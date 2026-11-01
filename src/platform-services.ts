import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanvasChannel } from "./canvas-channel.ts";
import { isCrossOrigin, readJson, sendJson } from "./http.ts";
import type { KeyValueStore } from "./key-value-store.ts";
import { VIEW_ONLY_HEADER, withVersionDefinitions } from "./canvas-versions.ts";

/** The client library Canvas features import from `/__platform/services.js`. */
export const SERVICES_LIBRARY = withVersionDefinitions(readFileSync(new URL("./canvas-services.js", import.meta.url), "utf8"));
/** Must match the client library's rule, which mirrors feature folder names. */
const FEATURE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_KEY_LENGTH = 256;

/**
 * Answers the platform services' API under `/__platform/` (docs/adr/0002):
 * - `POST channel/<feature>` broadcasts `{message}` to every viewer.
 * - `GET|PUT|DELETE store/<feature>/<key>` reads (`{value}`, or 404), writes
 *   (`{value}`) or removes one entry; `GET store/<feature>/?prefix=` lists
 *   `{entries: [{key, value}]}`.
 *
 * Changes (anything but `GET`/`HEAD`) are refused with 403 when `isViewOnly`
 * says the request comes from a view-only page, such as an older version,
 * marked with `VIEW_ONLY_HEADER` so the services library drops them quietly.
 *
 * Returns false if `servicePath` isn't a services path.
 */
export async function handleServiceRequest(
  req: IncomingMessage,
  res: ServerResponse,
  servicePath: string,
  services: { channel: CanvasChannel; store: KeyValueStore; isViewOnly?: (req: IncomingMessage) => Promise<boolean> },
): Promise<boolean> {
  const match = /^(?:channel\/([^/]*)|store\/([^/]*)\/(.*))$/.exec(servicePath);
  if (!match) return false;
  if (isCrossOrigin(req)) {
    res.writeHead(403).end("The platform services only answer the Canvas");
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD" && (await services.isViewOnly?.(req))) {
    console.warn(`Refused ${req.method} ${req.url} from an older Canvas version (${req.headers.referer})`);
    res.writeHead(403, { [VIEW_ONLY_HEADER]: "1" }).end("Older Canvas versions are view only");
    return true;
  }
  const feature = match[1] ?? match[2];
  if (!FEATURE_NAME.test(feature)) {
    sendJson(res, 400, { error: "Invalid feature name" });
    return true;
  }
  if (match[1] === undefined) {
    await handleStore(req, res, services.store, feature, match[3]);
    return true;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return true;
  }
  const body = await readJson(req, MAX_MESSAGE_BYTES);
  if (body === undefined || !("message" in body)) {
    sendJson(res, 400, { error: `Expected a JSON body {"message": …} of at most ${MAX_MESSAGE_BYTES} bytes` });
    return true;
  }
  services.channel.publishFeatureMessage(feature, body.message);
  res.writeHead(204).end();
  return true;
}

async function handleStore(req: IncomingMessage, res: ServerResponse, store: KeyValueStore, feature: string, encodedKey: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://canvas");
  if (encodedKey === "") {
    if (req.method !== "GET") return void res.writeHead(405, { allow: "GET" }).end();
    return sendJson(res, 200, { entries: store.list(feature, url.searchParams.get("prefix") ?? "") });
  }
  let key: string;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return sendJson(res, 400, { error: "Invalid key" });
  }
  if (key.length > MAX_KEY_LENGTH) return sendJson(res, 400, { error: `Keys are at most ${MAX_KEY_LENGTH} characters` });
  if (req.method === "GET") {
    const value = store.get(feature, key);
    return value === undefined ? sendJson(res, 404, { error: "No such key" }) : sendJson(res, 200, { value });
  }
  if (req.method === "PUT") {
    const body = await readJson(req, MAX_VALUE_BYTES);
    if (body === undefined || body.value === undefined) {
      return sendJson(res, 400, { error: `Expected a JSON body {"value": …} of at most ${MAX_VALUE_BYTES} bytes` });
    }
    store.set(feature, key, body.value);
    return void res.writeHead(204).end();
  }
  if (req.method === "DELETE") {
    store.delete(feature, key);
    return void res.writeHead(204).end();
  }
  res.writeHead(405, { allow: "GET, PUT, DELETE" }).end();
}
