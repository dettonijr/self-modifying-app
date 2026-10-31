import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Agent } from "../../src/agent.ts";
import { startPlatform } from "../../src/platform.ts";
import { FakeAgent } from "./fake-agent.ts";

export interface TestPlatformOptions {
  /** Reuse a data folder, e.g. to restart a platform. Not deleted on close. */
  dataDir?: string;
  agent?: Agent;
}

export interface TestPlatform {
  consoleUrl: string;
  canvasUrl: string;
  dataDir: string;
  /** The Agent behind the platform; a fresh FakeAgent unless one was given. */
  agent: Agent;
  /** The Canvas repo inside the data folder. */
  canvasRepoDir: string;
  /** Calls the Console API, e.g. `consoleApi("/api/health")`. */
  consoleApi(apiPath: string, init?: RequestInit): Promise<Response>;
  fetchCanvas(canvasPath: string, init?: RequestInit): Promise<Response>;
  /** Stops the platform and removes its data folder if the harness created it. */
  close(): Promise<void>;
}

/**
 * Starts a fresh, isolated platform on random loopback ports with a temporary
 * data folder. Safe to call in parallel.
 */
export async function startTestPlatform(options: TestPlatformOptions = {}): Promise<TestPlatform> {
  const ownsDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), "sma-test-")));
  const agent = options.agent ?? new FakeAgent();
  const platform = await startPlatform({ dataDir, agent, host: "127.0.0.1" });
  const consoleUrl = `http://127.0.0.1:${platform.consolePort}`;
  const canvasUrl = `http://127.0.0.1:${platform.canvasPort}`;

  return {
    consoleUrl,
    canvasUrl,
    dataDir,
    agent,
    canvasRepoDir: path.join(dataDir, "canvas"),
    consoleApi: (apiPath, init) => fetch(consoleUrl + apiPath, init),
    fetchCanvas: (canvasPath, init) => fetch(canvasUrl + canvasPath, init),
    async close() {
      await platform.close();
      if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
    },
  };
}
