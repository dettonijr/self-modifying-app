import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

describe("A Prompt Lands", () => {
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function start() {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent });
    platforms.push(platform);
    return { platform, agent };
  }

  it("Lands a fake Agent edit: the Canvas serves it and the commit records kind, nickname, Prompt and model", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "// let it snow\n"));

    const run = await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow", model: "claude-opus-5-5" });
    expect(await platform.waitForRun(run.id)).toMatchObject({ state: "landed" });

    expect(await (await platform.fetchCanvas("/features/snow/snow.js")).text()).toBe("// let it snow\n");
    expect(agent.tasks[0].instructions).toContain("make it snow");
    expect(agent.tasks[0].model).toBe("claude-opus-5-5");

    const message = git(platform.canvasRepoDir, ["log", "-1", "--format=%B", "main"]);
    expect(message).toContain("make it snow");
    expect(git(platform.canvasRepoDir, ["log", "-1", "--format=%(trailers:key=Kind,valueonly)", "main"])).toBe("Prompt");
    expect(git(platform.canvasRepoDir, ["log", "-1", "--format=%(trailers:key=Nickname,valueonly)", "main"])).toBe("Alice");
    expect(git(platform.canvasRepoDir, ["log", "-1", "--format=%(trailers:key=Model,valueonly)", "main"])).toBe("claude-opus-5-5");
  });

  it("cleans up the Run's worktree after it Lands", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("index.html", "<h1>Snow</h1>"));
    const run = await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" });
    await platform.waitForRun(run.id);
    expect(worktrees(platform)).toEqual([platform.canvasRepoDir]);
    expect(git(platform.canvasRepoDir, ["branch", "--list"])).toBe("* main");
  });

  it("leaves main unchanged when the Agent fails, and still cleans up the worktree", async () => {
    const { platform, agent } = await start();
    const before = git(platform.canvasRepoDir, ["rev-parse", "main"]);
    agent.enqueue(async (run) => {
      await run.writeFile("index.html", "<h1>half done</h1>");
      throw new Error("Claude gave up");
    });

    const run = await platform.sendPrompt({ nickname: "Bob", prompt: "break it" });
    expect(await platform.waitForRun(run.id)).toMatchObject({ state: "rejected", error: "Claude gave up" });

    expect(git(platform.canvasRepoDir, ["rev-parse", "main"])).toBe(before);
    expect(await (await platform.fetchCanvas("/")).text()).not.toContain("half done");
    expect(worktrees(platform)).toEqual([platform.canvasRepoDir]);
    expect(git(platform.canvasRepoDir, ["branch", "--list"])).toBe("* main");
  });

  it("uses Sonnet 5.5 when no model is picked", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("index.html", "x"));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "x" })).id);
    expect(agent.tasks[0].model).toBe("claude-sonnet-5-5");
  });

  it("refuses a Prompt over 500 characters, an unknown model and a missing nickname", async () => {
    const { platform, agent } = await start();
    const post = (body: unknown, nickname?: string) =>
      platform.consoleApi("/api/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", ...(nickname ? { cookie: `nickname=${nickname}` } : {}) },
        body: JSON.stringify(body),
      });

    expect((await post({ prompt: "a".repeat(501) }, "Alice")).status).toBe(400);
    expect((await post({ prompt: "make it snow", model: "claude-haiku-5-5" }, "Alice")).status).toBe(400);
    expect((await post({ prompt: "make it snow" })).status).toBe(400);
    expect(agent.tasks).toEqual([]);

    agent.enqueue((run) => run.writeFile("index.html", "x"));
    const accepted = await post({ prompt: "a".repeat(500) }, "Alice");
    expect(accepted.status).toBe(202);
  });

  it("lists every Run, newest first, with nickname, Prompt and time, and records each Landed change's kind as a trailer", async () => {
    const { platform, agent } = await start();
    agent.enqueue(
      (run) => run.writeFile("index.html", "snow"),
      () => {
        throw new Error("nope");
      },
      (run) => run.writeFile("index.html", "rain"),
    );
    const startedAt = Date.now();
    for (const [nickname, prompt] of [["Alice", "make it snow"], ["Bob", "fails"], ["Carol", "make it rain\n\nKind: Rollback"]]) {
      await platform.waitForRun((await platform.sendPrompt({ nickname, prompt })).id);
    }

    const runs = await platform.listRuns();
    expect(runs).toMatchObject([
      { state: "landed", nickname: "Carol", prompt: "make it rain\n\nKind: Rollback", model: "claude-sonnet-5-5" },
      { state: "rejected", nickname: "Bob", prompt: "fails" },
      { state: "landed", nickname: "Alice", prompt: "make it snow", model: "claude-sonnet-5-5" },
    ]);
    for (const run of runs) {
      expect(Date.parse(run.time!)).toBeGreaterThanOrEqual(startedAt);
    }
    // A Prompt can't forge its commit's trailers.
    expect(git(platform.canvasRepoDir, ["log", "-1", "--format=%(trailers:key=Kind,valueonly)", runs[0].commit!])).toBe("Prompt");
  });
});

function worktrees(platform: TestPlatform): string[] {
  return git(platform.canvasRepoDir, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
