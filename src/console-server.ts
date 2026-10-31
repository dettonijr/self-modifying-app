import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Budget } from "./budget.ts";
import type { CanvasRepository } from "./canvas-repository.ts";
import { isCrossOrigin, readJson, sendJson } from "./http.ts";
import { PromptRefused, type Runs } from "./runs.ts";

const CONSOLE_PAGE = readFileSync(new URL("./console-page.html", import.meta.url), "utf8");
const REFUSAL_STATUS: Record<PromptRefused["reason"], number> = { invalid: 400, "already-waiting": 409, paused: 503, "not-found": 404 };

/**
 * Serves the Console UI and the Console API, including `/api/live`: a
 * WebSocket that sends a `snapshot` on connecting, then every `RunsEvent`.
 */
export function createConsoleServer(options: { runs: Runs; repo: CanvasRepository; budget: Budget }): Server {
  const { runs, repo, budget } = options;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://console");
      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }).end(CONSOLE_PAGE);
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
        const body = await readJson(req);
        if (body === undefined) return sendJson(res, 400, { error: "Expected a JSON body" });
        try {
          const run = runs.start({ nickname: cookie(req, "nickname"), prompt: body.prompt, model: body.model });
          return sendJson(res, 202, run);
        } catch (error) {
          if (!(error instanceof PromptRefused)) throw error;
          return sendJson(res, REFUSAL_STATUS[error.reason], { error: error.message });
        }
      }
      if (url.pathname === "/api/replays" && req.method === "POST") {
        const body = await readJson(req);
        if (body === undefined) return sendJson(res, 400, { error: "Expected a JSON body" });
        try {
          const run = await runs.replay({ nickname: cookie(req, "nickname"), commit: body.commit, model: body.model });
          return sendJson(res, 202, run);
        } catch (error) {
          if (!(error instanceof PromptRefused)) throw error;
          return sendJson(res, REFUSAL_STATUS[error.reason], { error: error.message });
        }
      }
      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (runMatch && req.method === "GET") {
        const run = runs.get(decodeURIComponent(runMatch[1]));
        return run ? sendJson(res, 200, run) : sendJson(res, 404, { error: "No such Run" });
      }
      if (url.pathname === "/api/spending" && req.method === "GET") {
        return sendJson(res, 200, budget.spending());
      }
      if (url.pathname === "/api/history" && req.method === "GET") {
        return sendJson(res, 200, await repo.history());
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

function followRuns(client: WebSocket, runs: Runs): void {
  client.send(JSON.stringify({ type: "snapshot", ...runs.snapshot() }));
  const unsubscribe = runs.subscribe((event) => client.send(JSON.stringify(event)));
  client.on("close", unsubscribe);
  client.on("error", () => client.terminate());
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
