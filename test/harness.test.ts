import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, AgentTask } from "../src/agent.ts";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform } from "./support/harness.ts";

describe("Test harness", () => {
  it("starts isolated platforms in parallel", async () => {
    const [a, b] = await Promise.all([startTestPlatform(), startTestPlatform()]);
    try {
      expect(new Set([a.consoleUrl, a.canvasUrl, b.consoleUrl, b.canvasUrl]).size).toBe(4);
      expect(a.dataDir).not.toBe(b.dataDir);

      await writeFile(path.join(a.canvasRepoDir, "index.html"), "only in a");
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qam", "a"], { cwd: a.canvasRepoDir });

      expect(await (await a.fetchCanvas("/")).text()).toContain("only in a");
      expect(await (await b.fetchCanvas("/")).text()).not.toContain("only in a");
      expect((await a.consoleApi("/api/health")).status).toBe(200);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});

describe("Scripted fake Agent", () => {
  const worktrees: string[] = [];
  afterEach(async () => {
    await Promise.all(worktrees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function task(overrides: Partial<AgentTask> = {}): Promise<AgentTask> {
    const worktree = await mkdtemp(path.join(os.tmpdir(), "sma-worktree-"));
    worktrees.push(worktree);
    return { worktree, instructions: "make it snow", model: "claude-sonnet-5-5", ...overrides };
  }
  async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const all: AgentEvent[] = [];
    for await (const event of events) all.push(event);
    return all;
  }

  it("edits files in the worktree and reports progress, usage and success", async () => {
    const agent = new FakeAgent().enqueue(async (run) => {
      await run.writeFile("features/snow/snow.js", "// snow");
      run.usage({ inputTokens: 1000, outputTokens: 200 });
    });
    const t = await task();

    const events = await collect(agent.run(t));

    expect(await readFile(path.join(t.worktree, "features/snow/snow.js"), "utf8")).toBe("// snow");
    expect(events).toEqual([
      { type: "progress", message: "Editing features/snow/snow.js", file: "features/snow/snow.js" },
      { type: "usage", usage: { inputTokens: 1000, outputTokens: 200 } },
      { type: "result", outcome: "success" },
    ]);
    expect(agent.tasks).toEqual([t]);
  });

  it("reports a crash as a failure", async () => {
    const agent = new FakeAgent().enqueue(() => {
      throw new Error("boom");
    });
    expect(await collect(agent.run(await task()))).toEqual([{ type: "result", outcome: "failure", error: "boom" }]);
  });

  it("fails a Run that has no script", async () => {
    const [event] = await collect(new FakeAgent().run(await task()));
    expect(event).toMatchObject({ type: "result", outcome: "failure" });
  });

  it("refuses to write outside the worktree", async () => {
    const agent = new FakeAgent().enqueue((run) => run.writeFile("../escape.txt", "x"));
    const [event] = await collect(agent.run(await task()));
    expect(event).toMatchObject({ type: "result", outcome: "failure" });
  });

  it("holds until the test releases it, so Runs can be ordered without sleeps", async () => {
    const gate = new Gate();
    const order: string[] = [];
    const agent = new FakeAgent().enqueue(
      async () => {
        await gate.wait();
        order.push("first");
      },
      () => {
        order.push("second");
      },
    );
    const first = collect(agent.run(await task()));
    await agent.started(1);
    await collect(agent.run(await task()));
    gate.release();
    await first;
    expect(order).toEqual(["second", "first"]);
  });

  it("hangs until the Run is aborted", async () => {
    const controller = new AbortController();
    const agent = new FakeAgent().enqueue(async (run) => {
      await run.aborted();
      throw new Error("aborted");
    });
    const events = collect(agent.run(await task({ signal: controller.signal })));
    controller.abort();
    expect(await events).toEqual([{ type: "result", outcome: "failure", error: "aborted" }]);
  });
});
