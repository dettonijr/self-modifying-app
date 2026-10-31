import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHostCommand } from "../src/host-commands.ts";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform, type TestPlatformOptions } from "./support/harness.ts";

interface Spending {
  totalUsd: number;
  capUsd: number;
  paused: boolean;
}

describe("Spending cap", () => {
  const platforms: TestPlatform[] = [];
  const dataDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
    await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function dataDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sma-spending-"));
    dataDirs.push(dir);
    return dir;
  }
  async function start(options: TestPlatformOptions = {}) {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent, ...options });
    platforms.push(platform);
    return { platform, agent };
  }
  async function spending(platform: TestPlatform): Promise<Spending> {
    const response = await platform.consoleApi("/api/spending");
    expect(response.status).toBe(200);
    return (await response.json()) as Spending;
  }

  it("turns the token usage the Agent reports into cost at each model's prices", async () => {
    const { platform, agent } = await start();
    expect((await spending(platform)).totalUsd).toBe(0);

    // Sonnet 5.5: $2 / $10 per million input / output tokens.
    agent.enqueue(async (run) => {
      run.usage({ inputTokens: 600_000, outputTokens: 0 });
      run.usage({ inputTokens: 400_000, outputTokens: 100_000 });
      await run.writeFile("index.html", "<h1>one</h1>");
    });
    const sonnet = await platform.sendPrompt({ nickname: "Alice", prompt: "one", model: "claude-sonnet-5-5" });
    await platform.waitForRun(sonnet.id);
    expect((await spending(platform)).totalUsd).toBeCloseTo(3, 9);

    // Opus 5.5: $4 / $20 per million. A failed Run still costs what it used.
    agent.enqueue((run) => {
      run.usage({ inputTokens: 250_000, outputTokens: 50_000 });
      throw new Error("Claude gave up");
    });
    const opus = await platform.sendPrompt({ nickname: "Bob", prompt: "two", model: "claude-opus-5-5" });
    await platform.waitForRun(opus.id);
    expect((await spending(platform)).totalUsd).toBeCloseTo(5, 9);
  });

  it("pauses the Console once the total reaches the cap, refusing new Prompts but letting the Run in progress finish", async () => {
    const { platform, agent } = await start({ spendingCapUsd: 1 });
    expect(await spending(platform)).toEqual({ totalUsd: 0, capUsd: 1, paused: false });

    const reported = new Gate();
    const finish = new Gate();
    agent.enqueue(async (run) => {
      run.usage({ inputTokens: 500_000, outputTokens: 0 }); // $1 on Sonnet 5.5
      reported.release();
      await finish.wait();
      await run.writeFile("index.html", "<h1>expensive</h1>");
    });
    const run = await platform.sendPrompt({ nickname: "Alice", prompt: "spend it all" });
    await reported.wait();
    await expect.poll(async () => (await spending(platform)).paused).toBe(true);

    finish.release();
    expect(await platform.waitForRun(run.id)).toMatchObject({ state: "landed" });

    const refused = await platform.consoleApi("/api/prompts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "nickname=Bob" },
      body: JSON.stringify({ prompt: "one more" }),
    });
    expect(refused.status).toBe(503);
    expect((await refused.json()).error).toMatch(/spending cap/i);
    expect(agent.tasks).toHaveLength(1);
  });

  it("keeps the running total, and so the pause, across restarts", async () => {
    const dir = await dataDir();
    const first = await start({ dataDir: dir, spendingCapUsd: 1 });
    first.agent.enqueue(async (run) => {
      run.usage({ inputTokens: 100_000, outputTokens: 100_000 }); // $1.20 on Sonnet 5.5
      await run.writeFile("index.html", "<h1>spent</h1>");
    });
    await first.platform.waitForRun((await first.platform.sendPrompt({ nickname: "Alice", prompt: "spend" })).id);
    await first.platform.close();
    platforms.splice(platforms.indexOf(first.platform), 1);

    const second = await start({ dataDir: dir, spendingCapUsd: 1 });
    const after = await spending(second.platform);
    expect(after.totalUsd).toBeCloseTo(1.2, 9);
    expect(after.paused).toBe(true);
  });

  it("resumes without a restart when the host raises the cap from the command line", async () => {
    const { platform, agent } = await start({ spendingCapUsd: 1 });
    agent.enqueue(async (run) => {
      run.usage({ inputTokens: 500_000, outputTokens: 0 }); // $1 on Sonnet 5.5
      await run.writeFile("index.html", "<h1>spent</h1>");
    });
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "spend" })).id);
    expect((await spending(platform)).paused).toBe(true);

    const lower = raiseCap(platform.dataDir, "0.5");
    expect(lower).toMatchObject({ exitCode: 1, output: expect.stringMatching(/higher than/i) });
    expect((await spending(platform)).capUsd).toBe(1);

    const raised = raiseCap(platform.dataDir, "5");
    expect(raised).toMatchObject({ exitCode: 0, output: expect.stringContaining("$5.00") });
    expect(await spending(platform)).toMatchObject({ capUsd: 5, paused: false });

    agent.enqueue((run) => run.writeFile("index.html", "<h1>more</h1>"));
    const run = await platform.sendPrompt({ nickname: "Bob", prompt: "more" });
    expect(await platform.waitForRun(run.id)).toMatchObject({ state: "landed" });
  });
});

/** What `npm run raise-cap -- <usd>` runs, in-process: the dev machine's Node can't run .ts files in a child process. */
function raiseCap(dataDir: string, usd: string) {
  return runHostCommand(["raise-cap", usd], { DATA_DIR: dataDir, SPENDING_CAP_USD: "1" });
}
