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
  /** Sends a Prompt as a Player would; throws unless the Console accepts it. */
  sendPrompt(prompt: { nickname: string; prompt: string; model?: string }): Promise<RunView>;
  /** Polls a Run until it has Landed or been rejected. */
  waitForRun(runId: string): Promise<RunView>;
  /** Stops the platform and removes its data folder if the harness created it. */
  close(): Promise<void>;
}

export interface RunView {
  id: string;
  state: string;
  nickname: string;
  prompt: string;
  model: string;
  error?: string;
  commit?: string;
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

  const consoleApi = (apiPath: string, init?: RequestInit) => fetch(consoleUrl + apiPath, init);

  return {
    consoleUrl,
    canvasUrl,
    dataDir,
    agent,
    canvasRepoDir: path.join(dataDir, "canvas"),
    consoleApi,
    fetchCanvas: (canvasPath, init) => fetch(canvasUrl + canvasPath, init),
    async sendPrompt({ nickname, ...body }) {
      const response = await consoleApi("/api/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `nickname=${encodeURIComponent(nickname)}` },
        body: JSON.stringify(body),
      });
      if (response.status !== 202) throw new Error(`Prompt refused (${response.status}): ${await response.text()}`);
      return (await response.json()) as RunView;
    },
    async waitForRun(runId) {
      while (true) {
        const response = await consoleApi(`/api/runs/${encodeURIComponent(runId)}`);
        if (!response.ok) throw new Error(`No such Run ${runId} (${response.status})`);
        const run = (await response.json()) as RunView;
        if (run.state === "landed" || run.state === "rejected") return run;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async close() {
      await platform.close();
      if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
    },
  };
}
