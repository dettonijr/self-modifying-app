import { createServer, type Server } from "node:http";
import { isCrossOrigin } from "./http.ts";

const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Console</title></head>
<body><h1>Console</h1><p>Prompts are coming soon.</p></body>
</html>
`;

/** Serves the Console UI and the Console API. */
export function createConsoleServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://console");
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PLACEHOLDER_PAGE);
      return;
    }
    if (url.pathname.startsWith("/api/") && isCrossOrigin(req)) {
      res.writeHead(403).end("The Console API only answers the Console");
      return;
    }
    if (url.pathname === "/api/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end("Not found");
  });
}
