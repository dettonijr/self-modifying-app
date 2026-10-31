import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform, type RunView, type TestPlatform, type TestPlatformOptions } from "./support/harness.ts";

describe("Replay", () => {
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

  /** Bob makes it snow, then Carol stops the snow. Returns Bob's landed Run. */
  async function snowThenStop(platform: TestPlatform, agent: FakeAgent): Promise<RunView> {
    agent.enqueue(
      async (run) => {
        await run.writeFile("features/snow/snow.js", "let flakes = 100;");
        await run.writeFile("index.html", "<h1>Snowing</h1>");
      },
      (run) => run.writeFile("features/snow/snow.js", "let flakes = 0;"),
    );
    const snow = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    expect(snow).toMatchObject({ state: "landed" });
    expect(await platform.waitForRun((await platform.sendPrompt({ nickname: "Carol", prompt: "stop the snow" })).id)).toMatchObject({ state: "landed" });
    return snow;
  }

  it("gives the Agent the original Prompt, the original diff and the later Prompts, and Lands as a Replay credited to the replayer", async () => {
    const { platform, agent } = await start();
    const snow = await snowThenStop(platform, agent);
    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "let flakes = 100; // again"));

    const response = await platform.replay({ nickname: "Alice", commit: snow.commit!, model: "claude-opus-5-5" });
    expect(response.status).toBe(202);
    const replay = (await response.json()) as RunView;
    expect(replay).toMatchObject({ nickname: "Alice", prompt: "make it snow", model: "claude-opus-5-5", kind: "Replay" });
    const finished = await platform.waitForRun(replay.id);
    expect(finished).toMatchObject({ state: "landed" });

    const task = agent.tasks[2];
    expect(task.model).toBe("claude-opus-5-5");
    expect(task.instructions).toContain("make it snow");
    expect(task.instructions).toContain("+let flakes = 100;");
    expect(task.instructions).toContain("+<h1>Snowing</h1>");
    expect(task.instructions).toContain("Carol: stop the snow");
    expect(task.instructions).toMatch(/reference/i);
    expect(task.instructions).toMatch(/unrelated/i);

    const [latest] = await (await platform.consoleApi("/api/history")).json();
    expect(latest).toMatchObject({
      commit: finished.commit,
      kind: "Replay",
      nickname: "Alice",
      prompt: "make it snow",
      model: "claude-opus-5-5",
      original: { commit: snow.commit, nickname: "Bob" },
    });
    const trailers = git(platform, ["log", "-1", "--format=%(trailers)", finished.commit!]);
    expect(trailers).toContain("Kind: Replay");
    expect(trailers).toContain("Nickname: Alice");
    expect(trailers).toContain(`Original: ${snow.commit}`);
  });

  it("counts against the Player's one waiting Prompt", async () => {
    const { platform, agent } = await start({ maxParallelRuns: 1 });
    agent.enqueue((run) => run.writeFile("index.html", "<h1>Snowing</h1>"));
    const snow = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    const hold = new Gate();
    agent.enqueue(async (run) => {
      await Promise.race([hold.wait(), run.aborted()]);
      await run.writeFile("index.html", "<h1>Busy</h1>");
    });
    await platform.sendPrompt({ nickname: "Carol", prompt: "busy" });
    await agent.started(2);

    expect((await platform.replay({ nickname: "Alice", commit: snow.commit! })).status).toBe(202);
    const second = await platform.replay({ nickname: "Alice", commit: snow.commit! });
    expect(second.status).toBe(409);
    expect((await platform.consoleApi("/api/prompts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "nickname=Alice" },
      body: JSON.stringify({ prompt: "another" }),
    })).status).toBe(409);
    hold.release();
  });

  it("refuses a Replay of a commit that isn't in the history, or without a nickname", async () => {
    const { platform } = await start();
    const starter = git(platform, ["rev-parse", "main"]);
    expect((await platform.replay({ nickname: "Alice", commit: starter })).status).toBe(404);
    expect((await platform.replay({ nickname: "Alice", commit: "nope" })).status).toBe(404);
    expect((await platform.consoleApi("/api/replays", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commit: starter }) })).status).toBe(400);
  });
});

function git(platform: TestPlatform, args: string[]): string {
  return execFileSync("git", args, { cwd: platform.canvasRepoDir, encoding: "utf8" }).trim();
}
