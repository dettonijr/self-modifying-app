import path from "node:path";
import type { Agent } from "./agent.ts";
import { CanvasRepository } from "./canvas-repository.ts";
import { createCanvasServer } from "./canvas-server.ts";
import { createConsoleServer } from "./console-server.ts";
import { close, listen } from "./http.ts";
import { Lander } from "./lander.ts";
import { RenderCheck } from "./render-check.ts";
import { Runs } from "./runs.ts";

export interface PlatformOptions {
  /** Holds the Canvas repo (and later the SQLite database). Created if missing. */
  dataDir: string;
  agent: Agent;
  /** Interface to listen on; `0.0.0.0` makes both servers reachable on the network. */
  host?: string;
  /** 0 picks a random free port. */
  consolePort?: number;
  canvasPort?: number;
}

export interface Platform {
  consolePort: number;
  canvasPort: number;
  close(): Promise<void>;
}

/** Starts the Console and Canvas servers on separate ports, i.e. separate origins (docs/adr/0004). */
export async function startPlatform(options: PlatformOptions): Promise<Platform> {
  const host = options.host ?? "0.0.0.0";
  const repo = await CanvasRepository.open(path.join(options.dataDir, "canvas"));

  const renderCheck = new RenderCheck(repo);
  const runs = new Runs({ repo, agent: options.agent, lander: new Lander(repo, renderCheck), worktreesDir: path.join(options.dataDir, "worktrees") });

  const consoleServer = createConsoleServer({ runs, repo });
  const canvasServer = createCanvasServer(repo);
  const consolePort = await listen(consoleServer, options.consolePort ?? 0, host);
  const canvasPort = await listen(canvasServer, options.canvasPort ?? 0, host);

  return {
    consolePort,
    canvasPort,
    async close() {
      await Promise.all([close(consoleServer), close(canvasServer)]);
      await runs.close();
      await renderCheck.close();
    },
  };
}
