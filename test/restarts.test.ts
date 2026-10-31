import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { RunStore } from "../src/run-store.ts";
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

  it("puts Runs that were in progress at the front of the queue, within the parallel limit", async () => {
    const dataDir = await dataFolder();
    const before = await start(dataDir, { maxParallelRuns: 2 });
    before.agent.enqueue(interruptedByRestart, interruptedByRestart);
    const alice = await before.platform.sendPrompt({ nickname: "Alice", prompt: "snow" });
    const bob = await before.platform.sendPrompt({ nickname: "Bob", prompt: "rain" });
    await before.agent.started(2);
    const carol = await before.platform.sendPrompt({ nickname: "Carol", prompt: "wind" });
    await before.platform.close();

    const after = await start(dataDir, { maxParallelRuns: 1 });
    const gates = new Map(["snow", "rain", "wind"].map((prompt) => [prompt, new Gate()]));
    const held = async (run: FakeAgentContext) => {
      await Promise.race([gates.get(run.task.instructions)!.wait(), run.aborted()]);
      await run.writeFile(`features/${run.task.instructions}/index.js`, run.task.instructions);
    };
    after.agent.enqueue(held, held, held);
    await after.agent.started(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(after.agent.tasks.map((task) => task.instructions)).toEqual(["snow"]);

    gates.get("snow")!.release();
    expect(await after.platform.waitForRun(alice.id)).toMatchObject({ state: "landed" });
    await after.agent.started(2);
    expect(after.agent.tasks.map((task) => task.instructions)).toEqual(["snow", "rain"]);
    gates.get("rain")!.release();
    gates.get("wind")!.release();
    expect(await after.platform.waitForRun(bob.id)).toMatchObject({ state: "landed" });
    expect(await after.platform.waitForRun(carol.id)).toMatchObject({ state: "landed" });
    expect(after.agent.tasks.map((task) => task.instructions)).toEqual(["snow", "rain", "wind"]);
  });

  it("doesn't Land a Run twice when the platform stopped after main moved but before the Run was saved as Landed", async () => {
    const dataDir = await dataFolder();
    const before = await start(dataDir);
    before.agent.enqueue((run) => run.writeFile("features/snow/snow.js", "snow"));
    const snow = await before.platform.waitForRun((await before.platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" })).id);
    expect(snow).toMatchObject({ state: "landed" });
    await before.platform.close();
    const canvas = path.join(dataDir, "canvas");
    expect(execFileSync("git", ["log", "-1", "--format=%(trailers:key=Run,valueonly)", "main"], { cwd: canvas, encoding: "utf8" }).trim()).toBe(snow.id);
    // As if the process was killed between moving main and saving the Run as Landed.
    const store = new RunStore(path.join(dataDir, "runs.sqlite"));
    const { commit: _commit, ...unsaved } = { ...snow, state: "landing" as const, progress: [], log: [] };
    store.save(unsaved as Parameters<RunStore["save"]>[0]);
    store.close();

    const after = await start(dataDir);
    expect(await after.platform.waitForRun(snow.id)).toMatchObject({ state: "landed", commit: snow.commit });
    expect(after.agent.tasks).toHaveLength(0);
    expect(execFileSync("git", ["rev-parse", "main"], { cwd: canvas, encoding: "utf8" }).trim()).toBe(snow.commit);
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

  it("keeps every Run's whole log, and a resumed Run continues its log after a \"Platform restarted\" line", async () => {
    const dataDir = await dataFolder();
    const before = await start(dataDir);
    const long = "snow ".repeat(20_000).trim();
    before.agent.enqueue(
      async (run) => {
        run.message(long);
        await run.writeFile("features/snow/snow.js", "snow");
      },
      async (run) => {
        run.message("Starting on the rain.");
        await interruptedByRestart(run);
      },
    );
    const snow = await before.platform.waitForRun((await before.platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" })).id);
    const rain = await before.platform.sendPrompt({ nickname: "Bob", prompt: "make it rain" });
    await before.agent.started(2);
    await before.platform.close();

    const after = await start(dataDir);
    after.agent.enqueue(async (run) => {
      run.message("Trying the rain again.");
      await run.writeFile("features/rain/rain.js", "rain");
    });
    await after.platform.waitForRun(rain.id);

    const logOf = async (id: string) =>
      ((await (await after.platform.consoleApi(`/api/runs/${id}`)).json()) as { log: Array<{ source: string; text: string }> }).log.map(({ source, text }) => `${source}: ${text}`);
    expect(await logOf(snow.id)).toEqual([
      "platform: Queued",
      "platform: Started",
      `claude: ${long}`,
      "platform: Rebasing onto the latest Canvas",
      "platform: Checking that the Canvas renders",
      "platform: Landed",
    ]);
    expect(await logOf(rain.id)).toEqual([
      "platform: Queued",
      "platform: Started",
      "claude: Starting on the rain.",
      "platform: Platform restarted, starting over",
      "platform: Started",
      "claude: Trying the rain again.",
      "platform: Rebasing onto the latest Canvas",
      "platform: Checking that the Canvas renders",
      "platform: Landed",
    ]);
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
