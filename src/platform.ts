import path from "node:path";
import type { Agent } from "./agent.ts";
import { CanvasChannel } from "./canvas-channel.ts";
import { CanvasRepository } from "./canvas-repository.ts";
import { createCanvasServer } from "./canvas-server.ts";
import { createConsoleServer } from "./console-server.ts";
import { close, listen } from "./http.ts";
import { Lander } from "./lander.ts";
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

  const runs = new Runs({ repo, agent: options.agent, lander: new Lander(repo), worktreesDir: path.join(options.dataDir, "worktrees") });

  const consoleServer = createConsoleServer({ runs, repo });
  const channel = new CanvasChannel({
    greeting: async () => ({
      type: "hello",
      commit: await repo.main(),
      running: runs.inProgressRuns().map((run) => ({ runId: run.id, nickname: run.nickname })),
    }),
  });
  runs.onChange((run) => {
    if (run.state === "running") channel.publish({ type: "run-started", runId: run.id, nickname: run.nickname });
    if (run.state === "landed" && run.commit) {
      channel.publish({ type: "landed", runId: run.id, nickname: run.nickname, prompt: run.prompt, commit: run.commit });
    }
    if (run.state === "rejected") channel.publish({ type: "rejected", runId: run.id });
  });
  const canvasServer = createCanvasServer({ repo, channel });
  const consolePort = await listen(consoleServer, options.consolePort ?? 0, host);
  const canvasPort = await listen(canvasServer, options.canvasPort ?? 0, host);

  return {
    consolePort,
    canvasPort,
    async close() {
      await Promise.all([close(consoleServer), close(canvasServer)]);
      await runs.close();
    },
  };
}
