import { createServer, type Server } from "node:http";
import path from "node:path";
import type { CanvasRepository } from "./canvas-repository.ts";
import { contentType } from "./http.ts";

/** Serves the Canvas straight from the commit `main` points to. */
export function createCanvasServer(repo: CanvasRepository): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      const filePath = toRepoPath(new URL(req.url ?? "/", "http://canvas").pathname);
      if (filePath === undefined) {
        res.writeHead(404).end("Not found");
        return;
      }
      const commit = await repo.main();
      const candidates = filePath === "" ? ["index.html"] : [filePath, `${filePath}/index.html`];
      for (const candidate of candidates) {
        const body = await repo.readFile(commit, candidate);
        if (body === undefined) continue;
        res.writeHead(200, { "content-type": contentType(candidate), "cache-control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      res.writeHead(404).end("Not found");
    } catch (error) {
      console.error("Canvas server error", error);
      res.writeHead(500).end("Internal error");
    }
  });
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
