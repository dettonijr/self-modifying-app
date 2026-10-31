import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

describe("The Prompts list (every Run, newest first)", () => {
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function start(options: { dataDir?: string; agent?: FakeAgent } = {}) {
    const agent = options.agent ?? new FakeAgent();
    const platform = await startTestPlatform({ agent, maxParallelRuns: 1, dataDir: options.dataDir });
    platforms.push(platform);
    return { platform, agent };
  }
  const listed = async (platform: TestPlatform) => (await (await platform.consoleApi("/api/runs")).json()) as Array<Record<string, any>>;

  it("lists waiting, running and finished Runs once each, newest first, in the snapshot and from GET /api/runs", async () => {
    const { platform, agent } = await start();
    const gate = new Gate();
    agent.enqueue(
      () => {
        throw new Error("Claude gave up");
      },
      async (run) => {
        await gate.wait();
        await run.writeFile("features/snow/snow.js", "snow");
      },
    );
    const rejected = await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "break it" })).id);
    const running = await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow", model: "claude-opus-5-5" });
    await agent.started(2);
    const waiting = await platform.sendPrompt({ nickname: "Bob", prompt: "make it rain" });

    const live = await platform.live();
    const snapshot = await live.waitFor((m) => m.type === "snapshot");
    const expected = [
      { id: waiting.id, state: "waiting", nickname: "Bob", prompt: "make it rain", model: "claude-sonnet-5-5" },
      { id: running.id, state: "running", nickname: "Alice", prompt: "make it snow", model: "claude-opus-5-5" },
      { id: rejected.id, state: "rejected", nickname: "Alice", prompt: "break it", error: "Claude gave up" },
    ];
    expect(snapshot.runs).toMatchObject(expected);
    expect(await listed(platform)).toMatchObject(expected);
    for (const run of snapshot.runs) {
      expect(run.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Summaries only: no progress, logs or diffs.
      expect(run).not.toHaveProperty("progress");
    }

    gate.release();
    await platform.waitForRun(waiting.id);
    const states = live.messages.filter((m) => m.type === "run" && m.run.id === running.id).map((m) => m.run.state);
    expect(states).toEqual(["landing", "landed"]);
    expect((await listed(platform)).map((run) => [run.id, run.state])).toEqual([
      [waiting.id, "rejected"],
      [running.id, "landed"],
      [rejected.id, "rejected"],
    ]);
  });

  it("keeps listing more than 20 finished Runs, unchanged after a restart", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "sma-prompts-"));
    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
    const before = await start({ dataDir });
    for (let i = 0; i < 23; i++) {
      // Every third one is rejected: rejected Runs stay too.
      before.agent.enqueue(i % 3 === 0 ? () => {} : (run) => run.writeFile(`features/f${i}/f.js`, `${i}`));
      await before.platform.waitForRun((await before.platform.sendPrompt({ nickname: "Alice", prompt: `prompt ${i}` })).id);
    }
    const list = await listed(before.platform);
    expect(list.map((run) => run.prompt)).toEqual(Array.from({ length: 23 }, (_, i) => `prompt ${22 - i}`));
    expect(list.filter((run) => run.state === "rejected")).toHaveLength(8);
    await before.platform.close();
    platforms.splice(platforms.indexOf(before.platform), 1);

    const after = await start({ dataDir });
    expect(await listed(after.platform)).toEqual(list);
    const snapshot = await (await after.platform.live()).waitFor((m) => m.type === "snapshot");
    expect(snapshot.runs).toEqual(list);
  });

  it("lists Landed changes on main that have no Run record as Landed entries, older than every Run", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "sma-prompts-"));
    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
    const seeded = await start({ dataDir });
    await seeded.platform.close();
    platforms.splice(platforms.indexOf(seeded.platform), 1);
    // As Landed before Runs were saved: commit trailers but no Run trailer, and nothing in the Run store.
    const canvas = path.join(dataDir, "canvas");
    await writeFile(path.join(canvas, "old.js"), "old");
    const gitIn = (...args: string[]) => execFileSync("git", ["-c", "user.name=Platform", "-c", "user.email=platform@example.com", ...args], { cwd: canvas, encoding: "utf8" }).trim();
    gitIn("add", "old.js");
    gitIn("commit", "--quiet", "-m", "Prompt by Olga: make it old\n\nmake it old\n\nKind: Prompt\nNickname: Olga\nModel: claude-opus-5-5");
    const old = gitIn("rev-parse", "HEAD");

    const { platform, agent } = await start({ dataDir });
    agent.enqueue((run) => run.writeFile("features/new/new.js", "new"));
    const fresh = await platform.waitForRun((await platform.sendPrompt({ nickname: "Nina", prompt: "make it new" })).id);
    expect(await listed(platform)).toMatchObject([
      { id: fresh.id, state: "landed", prompt: "make it new" },
      { id: old, state: "landed", nickname: "Olga", prompt: "make it old", model: "claude-opus-5-5", commit: old, time: expect.stringMatching(/^\d{4}-/) },
    ]);
  });
});
