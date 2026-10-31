import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runHostCommand } from "../src/host-commands.ts";
import { DEFAULT_MAX_PARALLEL_RUNS, maxParallelRunsFromEnvironment } from "../src/parallel-limit.ts";
import { FakeAgent, Gate, type FakeAgentContext } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform, type TestPlatformOptions } from "./support/harness.ts";

describe("Parallel Runs", () => {
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

  it("runs 3 Runs at once by default; a 4th Prompt waits and starts when one Run finishes", async () => {
    const { platform, agent } = await start();
    // Runs take scripts in the order they start, which needn't be the order they were sent, so each script picks its gate by Prompt.
    const gates = new Map(["Alice", "Bob", "Carol"].map((nickname) => [`from ${nickname}`, new Gate()]));
    const held = async (run: FakeAgentContext) => {
      const [prompt, gate] = [...gates].find(([prompt]) => run.task.instructions.includes(prompt))!;
      await Promise.race([gate.wait(), run.aborted()]);
      await run.writeFile(`features/${prompt.slice(5)}/index.js`, prompt);
    };
    agent.enqueue(held, held, held, (run) => run.writeFile("features/dave/index.js", "from Dave"));
    const runs = [];
    for (const prompt of gates.keys()) runs.push(await platform.sendPrompt({ nickname: prompt.slice(5), prompt }));
    await agent.started(3);
    const fourth = await platform.sendPrompt({ nickname: "Dave", prompt: "from Dave" });
    expect(fourth).toMatchObject({ state: "waiting" });
    expect(agent.tasks).toHaveLength(3);

    gates.get("from Bob")!.release();
    expect(await platform.waitForRun(runs[1].id)).toMatchObject({ state: "landed" });
    await agent.started(4);
    expect(await platform.waitForRun(fourth.id)).toMatchObject({ state: "landed" });
    expect(agent.tasks).toHaveLength(4);

    for (const gate of gates.values()) gate.release();
    for (const run of runs) expect(await platform.waitForRun(run.id)).toMatchObject({ state: "landed" });
  });

  it("Lands two parallel Runs editing different features, the held one rebased onto the one that Landed first", async () => {
    const { platform, agent } = await start();
    const hold = new Gate();
    agent.enqueue(
      async (run) => {
        await run.writeFile("features/snow/snow.js", "snow");
        await Promise.race([hold.wait(), run.aborted()]);
      },
      (run) => run.writeFile("features/rain/rain.js", "rain"),
    );
    const held = await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" });
    await agent.started(1);
    const quick = await platform.sendPrompt({ nickname: "Bob", prompt: "make it rain" });
    const first = await platform.waitForRun(quick.id);
    expect(first).toMatchObject({ state: "landed" });

    hold.release();
    const second = await platform.waitForRun(held.id);
    expect(second).toMatchObject({ state: "landed" });
    expect(git(platform, ["rev-parse", "main"])).toBe(second.commit);
    expect(git(platform, ["rev-parse", `${second.commit}^`])).toBe(first.commit);
    expect(await (await platform.fetchCanvas("/features/snow/snow.js")).text()).toBe("snow");
    expect(await (await platform.fetchCanvas("/features/rain/rain.js")).text()).toBe("rain");
  });

  it("Lands Runs that finish together one at a time, so main never loses a change that Landed", async () => {
    const { platform, agent } = await start();
    const go = new Gate();
    const features = ["a", "b", "c"];
    agent.enqueue(
      ...features.map((feature) => async (run: FakeAgentContext) => {
        await Promise.race([go.wait(), run.aborted()]);
        await run.writeFile(`features/${feature}/${feature}.js`, feature);
      }),
    );
    const sent = [];
    for (const feature of features) sent.push(await platform.sendPrompt({ nickname: feature, prompt: `add ${feature}` }));
    await agent.started(3);
    const mainBefore = git(platform, ["rev-parse", "main"]);
    go.release();
    const landed = await Promise.all(sent.map((run) => platform.waitForRun(run.id)));

    expect(landed.map((run) => run.state)).toEqual(["landed", "landed", "landed"]);
    // A straight line from the old main through every Landed commit, one per Land.
    const line = git(platform, ["rev-list", "--parents", `${mainBefore}..main`]).split("\n").map((entry) => entry.split(" "));
    expect(line).toHaveLength(3);
    for (const parents of line) expect(parents).toHaveLength(2);
    expect(new Set(line.map(([commit]) => commit))).toEqual(new Set(landed.map((run) => run.commit)));
    for (const feature of features) {
      expect(await (await platform.fetchCanvas(`/features/${feature}/${feature}.js`)).text()).toBe(feature);
    }
  });

  it("runs only as many Runs at once as the configured limit", async () => {
    const { platform, agent } = await start({ maxParallelRuns: 2 });
    const go = new Gate();
    agent.enqueue(
      ...["a", "b", "c"].map((feature) => async (run: FakeAgentContext) => {
        await Promise.race([go.wait(), run.aborted()]);
        await run.writeFile(`features/${feature}/${feature}.js`, feature);
      }),
    );
    await platform.sendPrompt({ nickname: "a", prompt: "a" });
    await platform.sendPrompt({ nickname: "b", prompt: "b" });
    await agent.started(2);
    const third = await platform.sendPrompt({ nickname: "c", prompt: "c" });
    expect(third).toMatchObject({ state: "waiting" });
    expect(agent.tasks).toHaveLength(2);
    go.release();
    expect(await platform.waitForRun(third.id)).toMatchObject({ state: "landed" });
  });

  it("lets the host raise the limit during play, and the platform picks it up", async () => {
    const { platform, agent } = await start({ maxParallelRuns: 1 });
    const go = new Gate();
    const held = (feature: string) => async (run: FakeAgentContext) => {
      await Promise.race([go.wait(), run.aborted()]);
      await run.writeFile(`features/${feature}/${feature}.js`, feature);
    };
    agent.enqueue(held("a"), held("b"));
    await platform.sendPrompt({ nickname: "a", prompt: "a" });
    await agent.started(1);
    const second = await platform.sendPrompt({ nickname: "b", prompt: "b" });
    expect(second).toMatchObject({ state: "waiting" });

    const result = runHostCommand(["set-parallel-runs", "2"], { DATA_DIR: platform.dataDir });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toMatch(/2/);
    await agent.started(2);
    go.release();
    expect(await platform.waitForRun(second.id)).toMatchObject({ state: "landed" });
  });

  it("lets the host lower the limit during play without stopping Runs in progress", async () => {
    const { platform, agent } = await start({ maxParallelRuns: 2 });
    const gates = new Map(["a", "b", "c"].map((feature) => [feature, new Gate()]));
    const held = async (run: FakeAgentContext) => {
      const [feature, gate] = [...gates].find(([feature]) => run.task.instructions === feature)!;
      await Promise.race([gate.wait(), run.aborted()]);
      await run.writeFile(`features/${feature}/${feature}.js`, feature);
    };
    agent.enqueue(held, held, held, (run) => run.writeFile("features/d/d.js", "d"));
    const running = [await platform.sendPrompt({ nickname: "a", prompt: "a" }), await platform.sendPrompt({ nickname: "b", prompt: "b" })];
    await agent.started(2);

    expect(runHostCommand(["set-parallel-runs", "1"], { DATA_DIR: platform.dataDir }).exitCode).toBe(0);
    const third = await platform.sendPrompt({ nickname: "c", prompt: "c" });
    const fourth = await platform.sendPrompt({ nickname: "d", prompt: "d" });
    // Both Runs in progress carry on.
    gates.get("a")!.release();
    expect(await platform.waitForRun(running[0].id)).toMatchObject({ state: "landed" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // One Run is still in progress, so nothing new starts under a limit of 1.
    expect(agent.tasks).toHaveLength(2);
    gates.get("b")!.release();
    expect(await platform.waitForRun(running[1].id)).toMatchObject({ state: "landed" });
    await agent.started(3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(agent.tasks).toHaveLength(3);
    expect(await (await platform.consoleApi(`/api/runs/${fourth.id}`)).json()).toMatchObject({ state: "waiting" });
    gates.get("c")!.release();
    expect(await platform.waitForRun(third.id)).toMatchObject({ state: "landed" });
    expect(await platform.waitForRun(fourth.id)).toMatchObject({ state: "landed" });
  });

  it("refuses a parallel limit that isn't a whole number of at least 1", () => {
    for (const bad of ["0", "-1", "2.5", "lots"]) {
      expect(runHostCommand(["set-parallel-runs", bad], { DATA_DIR: "/nonexistent" })).toMatchObject({ exitCode: 1 });
    }
    expect(runHostCommand(["set-parallel-runs"], { DATA_DIR: "/nonexistent" })).toMatchObject({ exitCode: 2 });
  });

  it("reads the limit from MAX_PARALLEL_RUNS, defaulting to 3, and refuses anything but a whole number of at least 1", () => {
    expect(DEFAULT_MAX_PARALLEL_RUNS).toBe(3);
    expect(maxParallelRunsFromEnvironment({})).toBe(3);
    expect(maxParallelRunsFromEnvironment({ MAX_PARALLEL_RUNS: "" })).toBe(3);
    expect(maxParallelRunsFromEnvironment({ MAX_PARALLEL_RUNS: "5" })).toBe(5);
    for (const bad of ["0", "-1", "2.5", "lots"]) {
      expect(() => maxParallelRunsFromEnvironment({ MAX_PARALLEL_RUNS: bad })).toThrow(/MAX_PARALLEL_RUNS/);
    }
  });
});

function git(platform: TestPlatform, args: string[]): string {
  return execFileSync("git", args, { cwd: platform.canvasRepoDir, encoding: "utf8" }).trim();
}
