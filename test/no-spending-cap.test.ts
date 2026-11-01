import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { runHostCommand } from "../src/host-commands.ts";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform, type TestPlatformOptions } from "./support/harness.ts";

// 10M input tokens is $20 on Sonnet 5.5, twice the old default cap of $10.
const HEAVY_USAGE = { inputTokens: 10_000_000, outputTokens: 0 };

describe("No spending cap", () => {
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function start(options: TestPlatformOptions = {}) {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent, ...options });
    platforms.push(platform);
    return { platform, agent };
  }

  it("keeps running Prompts and Replays however many tokens have been used", async () => {
    const { platform, agent } = await start();
    agent.enqueue(async (run) => {
      run.usage(HEAVY_USAGE);
      await run.writeFile("features/snow/snow.js", "snow");
    });
    const snow = await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" })).id);
    expect(snow).toMatchObject({ state: "landed" });

    agent.enqueue(async (run) => {
      run.usage(HEAVY_USAGE);
      await run.writeFile("features/rain/rain.js", "rain");
    });
    const rain = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it rain" })).id);
    expect(rain).toMatchObject({ state: "landed" });

    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "more snow"));
    const replay = await platform.replay({ nickname: "Carol", commit: snow.commit! });
    expect(replay.status).toBe(202);
    expect(await platform.waitForRun(((await replay.json()) as { id: string }).id)).toMatchObject({ state: "landed" });
  });

  it("starts a queued Prompt as soon as a slot frees, however much the Run before it used", async () => {
    const { platform, agent } = await start({ maxParallelRuns: 1 });
    const queued = new Gate();
    agent.enqueue(
      async (run) => {
        await Promise.race([queued.wait(), run.aborted()]);
        run.usage(HEAVY_USAGE);
        await run.writeFile("features/a/a.js", "a");
      },
      (run) => run.writeFile("features/b/b.js", "b"),
    );
    const heavy = await platform.sendPrompt({ nickname: "Alice", prompt: "use lots" });
    await agent.started(1);
    const waiting = await platform.sendPrompt({ nickname: "Bob", prompt: "after it" });
    queued.release();
    expect(await platform.waitForRun(heavy.id)).toMatchObject({ state: "landed" });
    expect(await platform.waitForRun(waiting.id)).toMatchObject({ state: "landed" });
  });

  it("deletes the old spending cap's files from the data folder on startup", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "sma-test-"));
    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
    await writeFile(path.join(dataDir, "spending.json"), JSON.stringify({ spentUsd: 3 }));
    await writeFile(path.join(dataDir, "spending-cap.json"), JSON.stringify({ capUsd: 20 }));
    await start({ dataDir });
    expect(existsSync(path.join(dataDir, "spending.json"))).toBe(false);
    expect(existsSync(path.join(dataDir, "spending-cap.json"))).toBe(false);
  });

  it("has no spending endpoint and no raise-cap command", async () => {
    const { platform } = await start();
    expect((await platform.consoleApi("/api/spending")).status).toBe(404);

    const raise = runHostCommand(["raise-cap", "20"], { DATA_DIR: platform.dataDir });
    expect(raise.exitCode).toBe(2);
    expect(raise.output).not.toMatch(/raise-cap|spending/i);
  });
});
