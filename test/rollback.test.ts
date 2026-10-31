import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent, Gate, type FakeAgentScript } from "./support/fake-agent.ts";
import { startTestPlatform, type RunView, type TestPlatform, type TestPlatformOptions } from "./support/harness.ts";

describe("Rollback", () => {
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

  /** Sends a Prompt played by `script` and waits for it to Land. */
  async function land(platform: TestPlatform, agent: FakeAgent, nickname: string, prompt: string, script: FakeAgentScript): Promise<RunView> {
    agent.enqueue(script);
    const run = await platform.waitForRun((await platform.sendPrompt({ nickname, prompt })).id);
    expect(run).toMatchObject({ state: "landed" });
    return run;
  }

  it("reverts a change mechanically, keeping what Landed after it, and credits the Player", async () => {
    const { platform, agent } = await start();
    const snow = await land(platform, agent, "Alice", "make it snow", (run) => run.writeFile("features/snow/snow.js", "snow"));
    const rain = await land(platform, agent, "Bob", "make it rain", (run) => run.writeFile("features/rain/rain.js", "rain"));

    const response = await rollback(platform, "Carol", snow.commit!);
    expect(response.status).toBe(202);
    const run = (await response.json()) as RunView;
    const finished = await platform.waitForRun(run.id);

    expect(finished).toMatchObject({ state: "landed", nickname: "Carol" });
    // No Agent was needed for a clean revert.
    expect(agent.tasks).toHaveLength(2);
    expect((await platform.fetchCanvas("/features/snow/snow.js")).status).toBe(404);
    expect(await (await platform.fetchCanvas("/features/rain/rain.js")).text()).toBe("rain");
    expect(git(platform, ["rev-parse", "main"])).toBe(finished.commit);
    expect(git(platform, ["rev-parse", `${finished.commit}^`])).toBe(rain.commit);

    const history = (await (await platform.consoleApi("/api/history")).json()) as unknown[];
    expect(history[0]).toMatchObject({ commit: finished.commit, kind: "Rollback", nickname: "Carol", prompt: "make it snow", original: { commit: snow.commit, nickname: "Alice" } });
    const trailers = git(platform, ["log", "-1", "--format=%(trailers)", finished.commit!]);
    expect(trailers).toContain("Kind: Rollback");
    expect(trailers).toContain("Nickname: Carol");
    expect(trailers).toContain(`Original: ${snow.commit}`);
    expect(trailers).toContain("Original-Nickname: Alice");
    expect(git(platform, ["branch", "--list"])).toBe("* main");
  });

  it("asks the Agent to undo the change and keep what came after when the revert conflicts", async () => {
    const { platform, agent } = await start();
    const snow = await land(platform, agent, "Alice", "title it Snow", (run) => run.writeFile("index.html", "<h1>Snow</h1>"));
    const rain = await land(platform, agent, "Bob", "title it Rain", (run) => run.writeFile("index.html", "<h1>Rain</h1><p>Rain falls</p>"));
    let page = "";
    agent.enqueue(async (run) => {
      page = await readFile(path.join(run.task.worktree, "index.html"), "utf8");
      await run.writeFile("index.html", "<p>Rain falls</p>");
    });

    const run = (await (await rollback(platform, "Carol", snow.commit!)).json()) as RunView;
    const finished = await platform.waitForRun(run.id);

    expect(finished).toMatchObject({ state: "landed", nickname: "Carol" });
    const task = agent.tasks[2];
    expect(task.instructions).toMatch(/roll back this change, and keep what came after/i);
    expect(task.instructions).toContain("title it Snow");
    expect(task.instructions).toContain("<h1>Snow</h1>");
    expect(task.instructions).toContain("Bob: title it Rain");
    // The Agent starts from the latest Canvas, with no conflict markers.
    expect(page).toBe("<h1>Rain</h1><p>Rain falls</p>");
    expect(git(platform, ["rev-parse", `${finished.commit}^`])).toBe(rain.commit);
    expect(await (await platform.consoleApi("/api/history")).json()).toMatchObject([{ kind: "Rollback", nickname: "Carol", original: { commit: snow.commit, nickname: "Alice" } }, {}, {}]);
    expect(git(platform, ["branch", "--list"])).toBe("* main");
  });

  it("uses up the Player's one waiting slot, like a Prompt", async () => {
    const { platform, agent } = await start({ maxParallelRuns: 1 });
    const snow = await land(platform, agent, "Alice", "make it snow", (run) => run.writeFile("features/snow/snow.js", "snow"));
    const hold = new Gate();
    agent.enqueue(async (run) => {
      await run.writeFile("features/hold/hold.js", "hold");
      await Promise.race([hold.wait(), run.aborted()]);
    });
    const busy = await platform.sendPrompt({ nickname: "Bob", prompt: "hold the slot" });
    await agent.started(2);

    const waiting = await rollback(platform, "Carol", snow.commit!);
    expect(waiting.status).toBe(202);
    expect(await waiting.json()).toMatchObject({ state: "waiting", kind: "Rollback" });
    expect((await rollback(platform, "Carol", snow.commit!)).status).toBe(409);
    await expect(platform.sendPrompt({ nickname: "Carol", prompt: "make it rain" })).rejects.toThrow(/409/);

    agent.enqueue((run) => run.writeFile("features/dave/dave.js", "dave"));
    await platform.sendPrompt({ nickname: "Dave", prompt: "add dave" });
    expect((await rollback(platform, "Dave", snow.commit!)).status).toBe(409);

    hold.release();
    await platform.waitForRun(busy.id);
  });

  it("refuses a Rollback of anything not in the history (404)", async () => {
    const { platform, agent } = await start();
    const snow = await land(platform, agent, "Alice", "make it snow", (run) => run.writeFile("features/snow/snow.js", "snow"));
    const starter = git(platform, ["rev-parse", `${snow.commit}^`]);
    expect((await rollback(platform, "Carol", starter)).status).toBe(404);
    expect((await rollback(platform, "Carol", "f".repeat(40))).status).toBe(404);
    expect((await rollback(platform, "", snow.commit!)).status).toBe(400);
  });

  it("says so when the change is already undone", async () => {
    const { platform, agent } = await start();
    const snow = await land(platform, agent, "Alice", "make it snow", (run) => run.writeFile("features/snow/snow.js", "snow"));
    const undone = await platform.waitForRun(((await (await rollback(platform, "Carol", snow.commit!)).json()) as RunView).id);
    expect(undone).toMatchObject({ state: "landed" });

    const again = await platform.waitForRun(((await (await rollback(platform, "Dave", snow.commit!)).json()) as RunView).id);
    expect(again).toMatchObject({ state: "rejected", error: "That change is already undone" });
    expect(agent.tasks).toHaveLength(1);
    expect(git(platform, ["rev-parse", "main"])).toBe(undone.commit);
  });

  it("can roll back a Rollback, bringing the change back", async () => {
    const { platform, agent } = await start();
    const snow = await land(platform, agent, "Alice", "make it snow", (run) => run.writeFile("features/snow/snow.js", "snow"));
    const undone = await platform.waitForRun(((await (await rollback(platform, "Carol", snow.commit!)).json()) as RunView).id);
    expect((await platform.fetchCanvas("/features/snow/snow.js")).status).toBe(404);

    const redone = await platform.waitForRun(((await (await rollback(platform, "Dave", undone.commit!)).json()) as RunView).id);
    expect(redone).toMatchObject({ state: "landed" });
    expect(await (await platform.fetchCanvas("/features/snow/snow.js")).text()).toBe("snow");
    expect(await (await platform.consoleApi("/api/history")).json()).toMatchObject([
      { kind: "Rollback", nickname: "Dave", original: { commit: undone.commit, nickname: "Carol" }, prompt: "make it snow" },
      { kind: "Rollback", nickname: "Carol", original: { commit: snow.commit, nickname: "Alice" } },
      { kind: "Prompt", nickname: "Alice" },
    ]);
  });
});

function rollback(platform: TestPlatform, nickname: string, commit: string): Promise<Response> {
  return platform.consoleApi("/api/rollbacks", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `nickname=${encodeURIComponent(nickname)}` },
    body: JSON.stringify({ commit }),
  });
}

function git(platform: TestPlatform, args: string[]): string {
  return execFileSync("git", args, { cwd: platform.canvasRepoDir, encoding: "utf8" }).trim();
}
