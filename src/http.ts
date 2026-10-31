import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";

export function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function contentType(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return CONTENT_TYPES[filePath.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * True if a request was made by a page on another origin. The Console and the
 * Canvas run on different ports of the same host, which browsers treat as the
 * same *site*, so cookies and SameSite don't separate them; only the origin
 * does (docs/adr/0004). Requests without these headers (curl, the host's
 * scripts) aren't cross-origin browser calls.
 */
export function isCrossOrigin(req: IncomingMessage): boolean {
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}
