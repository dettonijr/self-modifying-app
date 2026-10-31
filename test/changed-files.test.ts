import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform, type TestPlatformOptions } from "./support/harness.ts";

describe("A Run's changed files", () => {
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function start(options: TestPlatformOptions = {}): Promise<{ platform: TestPlatform; agent: FakeAgent }> {
    const agent = (options.agent as FakeAgent | undefined) ?? new FakeAgent();
    const platform = await startTestPlatform({ maxParallelRuns: 1, ...options, agent });
    platforms.push(platform);
    return { platform, agent };
  }
  const runFiles = async (platform: TestPlatform, id: string) => (await (await platform.consoleApi(`/api/runs/${id}`)).json()).files;

  it("lists the file names being edited while a Run is in progress, live, once each", async () => {
    const { platform, agent } = await start();
    const gate = new Gate();
    agent.enqueue(async (run) => {
      await run.writeFile("features/snow/snow.js", "snow");
      await run.writeFile("features/snow/snow.css", "body {}");
      await run.writeFile("features/snow/snow.js", "more snow");
      run.progress("Thinking");
      await gate.wait();
    });
    const live = await platform.live();
    const { id } = await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" });

    const update = await live.waitFor((m) => m.type === "files" && m.runId === id && m.files.length === 2);
    expect(update.files).toEqual(["features/snow/snow.js", "features/snow/snow.css"]);
    expect(live.messages.filter((m) => m.type === "files" && m.runId === id)).toHaveLength(2);
    expect(await runFiles(platform, id)).toEqual([{ path: "features/snow/snow.js" }, { path: "features/snow/snow.css" }]);
    // The Prompts list stays light: no files in summaries.
    expect((await (await platform.consoleApi("/api/runs")).json())[0]).not.toHaveProperty("files");
    gate.release();
  });

  it("keeps in-progress file names across a restart", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "sma-files-"));
    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
    const { platform, agent } = await start({ dataDir });
    agent.enqueue(async (run) => {
      await run.writeFile("features/snow/snow.js", "snow");
      await run.aborted();
      throw new Error("aborted");
    });
    const live = await platform.live();
    const { id } = await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" });
    await live.waitFor((m) => m.type === "files" && m.runId === id);
    await platform.close();
    platforms.splice(platforms.indexOf(platform), 1);

    const gate = new Gate();
    const { platform: restarted, agent: again } = await start({ dataDir, agent: new FakeAgent() });
    again.enqueue(() => gate.wait());
    await again.started(1);
    expect(await runFiles(restarted, id)).toEqual([{ path: "features/snow/snow.js" }]);
    gate.release();
  });

  it("lists a Landed Run's files with added and removed line counts and each file's diff, read from git", async () => {
    const { platform, agent } = await start();
    agent.enqueue(async (run) => {
      await run.writeFile("features/snow/snow.js", "one\ntwo\nthree\n");
      await run.writeFile("features/snow/old.js", "old\n");
    });
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    agent.enqueue(async (run) => {
      await run.writeFile("features/snow/snow.js", "one\n2\nthree\nfour\n");
      await run.deleteFile("features/snow/old.js");
      await run.writeFile("features/snow/new file.js", "new\n");
    });
    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "more snow" })).id);
    expect(run.state).toBe("landed");

    const files = await runFiles(platform, run.id);
    expect(files.map(({ path, added, removed }: { path: string; added: number; removed: number }) => ({ path, added, removed }))).toEqual([
      { path: "features/snow/new file.js", added: 1, removed: 0 },
      { path: "features/snow/old.js", added: 0, removed: 1 },
      { path: "features/snow/snow.js", added: 2, removed: 1 },
    ]);
    const snow = files[2].diff.split("\n");
    expect(snow[0]).toBe("diff --git a/features/snow/snow.js b/features/snow/snow.js");
    expect(snow).toEqual(expect.arrayContaining(["-two", "+2", "+four", " one"]));
    expect(files[1].diff).toContain("deleted file mode");
    // A Run's page opened by its Landed commit shows the same.
    expect(await runFiles(platform, run.commit!)).toEqual(files);
  });
});
