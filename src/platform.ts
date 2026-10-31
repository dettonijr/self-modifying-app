import path from "node:path";
import type { Agent } from "./agent.ts";
import { CanvasChannel } from "./canvas-channel.ts";
import { CanvasRepository } from "./canvas-repository.ts";
import { createCanvasServer } from "./canvas-server.ts";
import { createConsoleServer } from "./console-server.ts";
import { close, listen } from "./http.ts";
import { KeyValueStore } from "./key-value-store.ts";
import { Lander } from "./lander.ts";
import { RenderCheck } from "./render-check.ts";
import { RunStore } from "./run-store.ts";
import { currentMaxParallelRuns, DEFAULT_MAX_PARALLEL_RUNS } from "./parallel-limit.ts";
import { Runs } from "./runs.ts";

export interface PlatformOptions {
  /** Holds the Canvas repo and the platform services' SQLite database. Created if missing. */
  dataDir: string;
  agent: Agent;
  /** Interface to listen on; `0.0.0.0` makes both servers reachable on the network. */
  host?: string;
  /** 0 picks a random free port. */
  consolePort?: number;
  canvasPort?: number;
  /**
   * The port Players' browsers reach the Canvas on, for links to it from the
   * Console; the port it listens on if omitted. Differs when Docker publishes
   * it on another port.
   */
  canvasPublicPort?: number;
  /** How many Runs may be in progress at once to start with; `DEFAULT_MAX_PARALLEL_RUNS` if omitted. The host can change it with `set-parallel-runs`. */
  maxParallelRuns?: number;
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
  const runStore = new RunStore(path.join(options.dataDir, "runs.sqlite"));
  const runs = new Runs({
    repo,
    agent: options.agent,
    lander: new Lander(repo, renderCheck),
    store: runStore,
    worktreesDir: path.join(options.dataDir, "worktrees"),
    maxParallelRuns: () => currentMaxParallelRuns(options.dataDir, options.maxParallelRuns ?? DEFAULT_MAX_PARALLEL_RUNS),
  });

  let canvasPort = 0;
  const consoleServer = createConsoleServer({ runs, repo, canvasPort: () => options.canvasPublicPort ?? canvasPort });
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
  const store = new KeyValueStore(path.join(options.dataDir, "services.sqlite"));
  const canvasServer = createCanvasServer({ repo, channel, store });
  await runs.resume();
  const consolePort = await listen(consoleServer, options.consolePort ?? 0, host);
  canvasPort = await listen(canvasServer, options.canvasPort ?? 0, host);

  return {
    consolePort,
    canvasPort,
    async close() {
      await Promise.all([close(consoleServer), close(canvasServer)]);
      await runs.close();
      await renderCheck.close();
      store.close();
      runStore.close();
    },
  };
}
