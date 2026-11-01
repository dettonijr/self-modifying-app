import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { CanvasRepository } from "./canvas-repository.ts";
import { changedFilesOf } from "./changed-files.ts";
import { isCrossOrigin, readJson, sendJson } from "./http.ts";
import { ChangeRefused, type Runs, type RunView } from "./runs.ts";
import { pinnedViewPath } from "./canvas-versions.ts";

const CONSOLE_PAGE = readFileSync(new URL("./console-page.html", import.meta.url), "utf8");
const RUN_PAGE = readFileSync(new URL("./run-page.html", import.meta.url), "utf8");
const SHARED_SCRIPT = readFileSync(new URL("./console-shared.js", import.meta.url), "utf8");
const STYLESHEETS: Record<string, string> = {
  "/palette.css": readFileSync(new URL("./palette.css", import.meta.url), "utf8"),
  "/console.css": readFileSync(new URL("./console.css", import.meta.url), "utf8"),
};
const REFUSAL_STATUS: Record<ChangeRefused["reason"], number> = { invalid: 400, "already-waiting": 409, "not-found": 404 };

/**
 * Serves the Console UI and the Console API, including `/api/live`: a
 * WebSocket that sends a `snapshot` on connecting, then every `RunsEvent`.
 */
export function createConsoleServer(options: { runs: Runs; repo: CanvasRepository; canvasPort: () => number }): Server {
  const { runs, repo, canvasPort } = options;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://console");
      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }).end(CONSOLE_PAGE);
        return;
      }
      if (url.pathname === "/console-shared.js" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }).end(SHARED_SCRIPT);
        return;
      }
      if (Object.hasOwn(STYLESHEETS, url.pathname) && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" }).end(STYLESHEETS[url.pathname]);
        return;
      }
      const runPage = /^\/runs\/([^/]+)$/.exec(url.pathname);
      if (runPage && req.method === "GET") {
        // Anyone may open a shared link to it, but other origins can't fetch or embed it.
        if (isCrossOrigin(req) && !isTopLevelNavigation(req)) {
          res.writeHead(403).end("The Run page only opens in its own tab");
          return;
        }
        const status = runs.get(decodeURIComponent(runPage[1])) ? 200 : 404;
        res.writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          "content-security-policy": "frame-ancestors 'none'",
          "x-frame-options": "DENY",
        }).end(RUN_PAGE);
        return;
      }
      if (url.pathname.startsWith("/api/") && isCrossOrigin(req)) {
        res.writeHead(403).end("The Console API only answers the Console");
        return;
      }
      if (url.pathname === "/api/health" && req.method === "GET") {
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === "/api/prompts" && req.method === "POST") {
        return await queueChange(req, res, (body, nickname) => runs.start({ nickname, prompt: body.prompt, model: body.model }));
      }
      if (url.pathname === "/api/replays" && req.method === "POST") {
        return await queueChange(req, res, (body, nickname) => runs.replay({ nickname, commit: body.commit, model: body.model }));
      }
      if (url.pathname === "/api/runs" && req.method === "GET") {
        return sendJson(res, 200, runs.list());
      }
      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (runMatch && req.method === "GET") {
        const run = runs.get(decodeURIComponent(runMatch[1]));
        if (!run) return sendJson(res, 404, { error: "No such Run" });
        const { editing: _editing, ...view } = run;
        return sendJson(res, 200, { ...view, files: await changedFilesOf(run, repo) });
      }
      if (url.pathname === "/api/canvas" && req.method === "GET") {
        // The Canvas is on the same host as the Console, on its own port (docs/adr/0004).
        // `versionPath` is the view-only address of a commit, with `{commit}` to fill in.
        return sendJson(res, 200, { port: canvasPort(), versionPath: pinnedViewPath("{commit}") });
      }
      res.writeHead(404).end("Not found");
    } catch (error) {
      console.error("Console server error", error);
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal error");
    }
  });

  const live = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? "/", "http://console");
    if (pathname !== "/api/live") return refuseUpgrade(socket, "404 Not Found");
    if (isCrossOrigin(req)) return refuseUpgrade(socket, "403 Forbidden");
    live.handleUpgrade(req, socket, head, (client) => followRuns(client, runs));
  });
  // Upgraded sockets aren't the HTTP server's connections any more, so closing the server wouldn't close them.
  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    for (const client of live.clients) client.terminate();
    return closeServer(callback);
  };
  return server;
}

/**
 * Handles a POST that queues a Run: reads the JSON body and the Player's
 * nickname cookie, then answers 202 with the Run, or the status for why it
 * was refused.
 */
async function queueChange(
  req: IncomingMessage,
  res: ServerResponse,
  queue: (body: Record<string, unknown>, nickname: string | undefined) => RunView | Promise<RunView>,
): Promise<void> {
  const body = await readJson(req);
  if (body === undefined) return sendJson(res, 400, { error: "Expected a JSON body" });
  try {
    return sendJson(res, 202, await queue(body, cookie(req, "nickname")));
  } catch (error) {
    if (!(error instanceof ChangeRefused)) throw error;
    return sendJson(res, REFUSAL_STATUS[error.reason], { error: error.message });
  }
}

function followRuns(client: WebSocket, runs: Runs): void {
  client.send(JSON.stringify({ type: "snapshot", ...runs.snapshot() }));
  const unsubscribe = runs.subscribe((event) => client.send(JSON.stringify(event)));
  client.on("close", unsubscribe);
  client.on("error", () => client.terminate());
}

/** Whether the browser is opening the request as a page in a tab, e.g. from a link, rather than fetching or embedding it. */
function isTopLevelNavigation(req: IncomingMessage): boolean {
  return req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
}

function refuseUpgrade(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return undefined;
    }
  }
  return undefined;
}
