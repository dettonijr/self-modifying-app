import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { CanvasChannel } from "./canvas-channel.ts";
import type { CanvasRepository } from "./canvas-repository.ts";
import type { KeyValueStore } from "./key-value-store.ts";
import { contentType } from "./http.ts";
import { handleServiceRequest, SERVICES_LIBRARY } from "./platform-services.ts";

/** URL paths under this prefix belong to the platform; Canvas files there are never served. */
const PLATFORM_PREFIX = "/__platform/";
const PLATFORM_SCRIPT = readFileSync(new URL("./canvas-platform-script.js", import.meta.url), "utf8");
const PLATFORM_SCRIPT_TAG = `<script src="${PLATFORM_PREFIX}platform.js"></script>`;
/** `/@<commit>/<path>`: a file as it is at one commit. */
const PINNED_PATH = /^\/@([0-9a-f]{40})(\/.*)$/;

/**
 * Serves the Canvas from git. A page's live URL redirects to the same page at
 * the commit `main` points to, `/@<commit>/…`, so everything the page loads by
 * relative URL comes from that one commit: never a mix of versions, and never
 * stale, because a new commit means new URLs. Only commits on `main` are
 * served, unless `anyCommit` is set, as for the render check's candidates.
 */
export function createCanvasServer(options: { repo: CanvasRepository; channel: CanvasChannel; store: KeyValueStore; anyCommit?: boolean }): Server {
  const { repo, channel, store } = options;
  // `main` only ever moves forward, so a commit on it stays on it.
  const onMain = new Set<string>();
  const servable = async (commit: string): Promise<boolean> => {
    if (options.anyCommit || onMain.has(commit)) return true;
    if (!(await repo.isOnMain(commit))) return false;
    onMain.add(commit);
    return true;
  };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://canvas");
      if (url.pathname.startsWith(PLATFORM_PREFIX)) {
        const platformPath = url.pathname.slice(PLATFORM_PREFIX.length);
        if (await handleServiceRequest(req, res, platformPath, { channel, store })) return;
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { allow: "GET, HEAD" }).end();
          return;
        }
        if (platformPath === "platform.js") return send(res, req.method, url.pathname, PLATFORM_SCRIPT, "no-cache");
        if (platformPath === "services.js") return send(res, req.method, url.pathname, SERVICES_LIBRARY, "no-cache");
        if (platformPath === "events" && req.method === "GET") return await channel.connect(req, res);
        res.writeHead(404).end("Not found");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      const pinned = PINNED_PATH.exec(url.pathname);
      const filePath = toRepoPath(pinned ? pinned[2] : url.pathname);
      if (filePath === undefined) {
        res.writeHead(404).end("Not found");
        return;
      }
      const commit = pinned ? pinned[1] : await repo.main();
      if (pinned && !(await servable(commit))) {
        res.writeHead(404).end("Not found");
        return;
      }
      const file = await findFile(repo, commit, filePath);
      if (file === undefined) {
        res.writeHead(404).end("Not found");
        return;
      }
      const isPage = file.path.endsWith(".html");
      if (!pinned && isPage) {
        res.writeHead(302, { location: `/@${commit}${url.pathname}${url.search}`, "cache-control": "no-store" }).end();
        return;
      }
      if (isPage) return send(res, req.method, file.path, injectPlatform(file.body.toString("utf8")), "no-cache");
      // A commit's files never change; files at live URLs change whenever main moves.
      send(res, req.method, file.path, file.body, pinned ? "public, max-age=31536000, immutable" : "no-cache");
    } catch (error) {
      console.error("Canvas server error", error);
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal error");
    }
  });
}

async function findFile(repo: CanvasRepository, commit: string, filePath: string): Promise<{ path: string; body: Buffer } | undefined> {
  const candidates = filePath === "" ? ["index.html"] : [filePath, `${filePath}/index.html`];
  for (const candidate of candidates) {
    const body = await repo.readFile(commit, candidate);
    if (body !== undefined) return { path: candidate, body };
  }
  return undefined;
}

function send(res: ServerResponse, method: string, filePath: string, body: string | Buffer, cacheControl: string): void {
  res.writeHead(200, { "content-type": contentType(filePath), "cache-control": cacheControl });
  res.end(method === "HEAD" ? undefined : body);
}

/** Maps a URL path to a path inside the repo, or `undefined` if it escapes the repo. */
function toRepoPath(urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.split("/").includes("..")) return undefined;
  return path.posix.normalize(decoded).replace(/^\/+|\/+$/g, "").replace(/^\.$/, "");
}

/**
 * Adds the platform script to a page: inside `<head>` if there is one, else
 * after the doctype, else at the very start.
 */
function injectPlatform(html: string): string {
  const anchor = /<head(\s[^>]*)?>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
  const at = anchor ? anchor.index + anchor[0].length : 0;
  return html.slice(0, at) + PLATFORM_SCRIPT_TAG + html.slice(at);
}
