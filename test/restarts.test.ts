import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { FakeAgent, Gate, type FakeAgentContext } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

describe("Surviving restarts", () => {
  async function dataFolder(): Promise<string> {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "sma-restart-"));
    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
    return dataDir;
  }
  async function start(dataDir: string, options: { maxParallelRuns?: number } = {}) {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ dataDir, agent, maxParallelRuns: options.maxParallelRuns ?? 1 });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await platform.close();
    };
    onTestFinished(close);
    return { platform: { ...platform, close } as TestPlatform, agent };
  }

  it("keeps waiting Prompts queued in the same order", async () => {
    const dataDir = await dataFolder();
    const before = await start(dataDir);
    before.agent.enqueue(interruptedByRestart);
    await before.platform.sendPrompt({ nickname: "Alice", prompt: "first" });
    await before.agent.started(1);
    const bob = await before.platform.sendPrompt({ nickname: "Bob", prompt: "second" });
    const carol = await before.platform.sendPrompt({ nickname: "Carol", prompt: "third" });
    await before.platform.close();

    const gate = new Gate();
    const after = await start(dataDir);
    after.agent.enqueue(async (run) => {
      await gate.wait();
      await run.writeFile("features/a/a.js", "a");
    });
    const live = await after.platform.live();
    const snapshot = await live.waitFor((message) => message.type === "snapshot");
    expect(snapshot.queue.map((run: { id: string }) => run.id)).toEqual([bob.id, carol.id]);
    gate.release();
  });

  it("starts Runs that were in progress again from scratch on the latest main, and they Land", async () => {
    const dataDir = await dataFolder();
    const before = await start(dataDir, { maxParallelRuns: 2 });
    before.agent.enqueue(
      async (run) => {
        await run.writeFile("features/half/half.js", "half done");
        await interruptedByRestart(run);
      },
      (run) => run.writeFile("features/rain/rain.js", "rain"),
    );
    const interrupted = await before.platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" });
    await before.agent.started(1);
    const rain = await before.platform.sendPrompt({ nickname: "Bob", prompt: "make it rain" });
    expect(await before.platform.waitForRun(rain.id)).toMatchObject({ state: "landed" });
    await before.platform.close();

    const after = await start(dataDir);
    const seen: { rain?: string; half?: boolean } = {};
    after.agent.enqueue(async (run) => {
      seen.rain = await readFile(path.join(run.task.worktree, "features/rain/rain.js"), "utf8");
      seen.half = await exists(path.join(run.task.worktree, "features/half/half.js"));
      await run.writeFile("features/snow/snow.js", "snow");
    });
    expect(await after.platform.waitForRun(interrupted.id)).toMatchObject({ state: "landed", nickname: "Alice", prompt: "make it snow" });
    expect(after.agent.tasks.map((task) => task.instructions)).toEqual(["make it snow"]);
    expect(seen).toEqual({ rain: "rain", half: false });
    expect(await (await after.platform.fetchCanvas("/features/snow/snow.js")).text()).toBe("snow");
    expect(await (await after.platform.fetchCanvas("/features/rain/rain.js")).text()).toBe("rain");
  });

  it("removes worktrees left over from before the restart", async () => {
    const dataDir = await dataFolder();
    const before = await start(dataDir);
    await before.platform.close();
    const canvas = path.join(dataDir, "canvas");
    const leftover = path.join(dataDir, "worktrees", "crashed-run");
    execFileSync("git", ["worktree", "add", "--quiet", "-b", "run/crashed-run", leftover, "main"], { cwd: canvas });

    await start(dataDir);
    expect(await exists(leftover)).toBe(false);
    const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: canvas, encoding: "utf8" });
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
    expect(execFileSync("git", ["branch", "--list", "run/*"], { cwd: canvas, encoding: "utf8" })).toBe("");
  });

  it("still allows one waiting Prompt per Player", async () => {
    const dataDir = await dataFolder();
    const before = await start(dataDir);
    before.agent.enqueue(interruptedByRestart);
    await before.platform.sendPrompt({ nickname: "Alice", prompt: "first" });
    await before.agent.started(1);
    await before.platform.sendPrompt({ nickname: "Bob", prompt: "second" });
    await before.platform.close();

    const gate = new Gate();
    const after = await start(dataDir);
    after.agent.enqueue(async (run) => {
      await gate.wait();
      await run.writeFile("features/a/a.js", "a");
    });
    await after.agent.started(1);
    const refused = await after.platform.consoleApi("/api/prompts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "nickname=Bob" },
      body: JSON.stringify({ prompt: "another" }),
    });
    expect(refused.status).toBe(409);
    gate.release();
  });
});

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Hangs until the platform shuts down, then fails, as a real Agent does when its Run is aborted. */
async function interruptedByRestart(run: FakeAgentContext): Promise<void> {
  await run.aborted();
  throw new Error("aborted");
}
