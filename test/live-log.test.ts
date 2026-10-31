import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent, Gate, type FakeAgentContext } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

interface LogEntry {
  time: string;
  source: "claude" | "platform" | "thinking" | "tool";
  text: string;
}

describe("A Run's live log", () => {
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function start(dataDir?: string) {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent, maxParallelRuns: 1, dataDir });
    platforms.push(platform);
    return { platform, agent };
  }
  async function logOf(platform: TestPlatform, id: string): Promise<LogEntry[]> {
    return ((await (await platform.consoleApi(`/api/runs/${id}`)).json()) as { log: LogEntry[] }).log;
  }
  const lines = (log: LogEntry[]) => log.map(({ source, text }) => `${source}: ${text}`);

  it("shows Claude's messages and the platform's steps in order, each with a time", async () => {
    const { platform, agent } = await start();
    agent.enqueue(async (run) => {
      run.message("I'll add some snow.");
      await run.writeFile("features/snow/snow.js", "snow");
      run.message("Done: it snows now.");
    });

    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);

    const log = await logOf(platform, run.id);
    expect(lines(log)).toEqual([
      "platform: Queued",
      "platform: Started",
      "claude: I'll add some snow.",
      "claude: Done: it snows now.",
      "platform: Rebasing onto the latest Canvas",
      "platform: Checking that the Canvas renders",
      "platform: Landed",
    ]);
    for (const entry of log) expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    const times = log.map((entry) => Date.parse(entry.time));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("ends a rejected Run's log with the reason", async () => {
    const { platform, agent } = await start();
    agent.enqueue(async (run) => {
      run.message("This is too hard.");
      throw new Error("Claude gave up");
    });

    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);

    expect(run.state).toBe("rejected");
    expect(lines(await logOf(platform, run.id))).toEqual(["platform: Queued", "platform: Started", "claude: This is too hard.", "platform: Rejected: Claude gave up"]);
  });

  it("logs each fix attempt and starting over", async () => {
    const { platform, agent } = await start();
    const broken = (run: FakeAgentContext) => run.writeFile("index.html", "<!doctype html><html><body></body></html>");
    agent.enqueue(broken, () => undefined, broken, broken);

    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Dave", prompt: "title it Blank" })).id);

    const land = ["platform: Rebasing onto the latest Canvas", "platform: Checking that the Canvas renders"];
    expect(lines(await logOf(platform, run.id))).toEqual([
      "platform: Queued",
      "platform: Started",
      ...land,
      "platform: Fixing a render failure (attempt 1 of 2)",
      ...land,
      "platform: Fixing a render failure (attempt 2 of 2)",
      ...land,
      "platform: Starting over from the latest Canvas",
      ...land,
      "platform: Rejected: Canvas didn't render",
    ]);
  });

  it("sends each new entry live while the Run is in progress, but never in Prompts list entries", async () => {
    const { platform, agent } = await start();
    const gate = new Gate();
    agent.enqueue(async (run) => {
      run.message("Thinking about snow.");
      await gate.wait();
      await run.writeFile("features/snow/snow.js", "snow");
    });
    const live = await platform.live();

    const run = await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" });
    const said = await live.waitFor((message) => message.type === "log" && message.runId === run.id && message.entry.source === "claude");
    expect(said.entry).toMatchObject({ source: "claude", text: "Thinking about snow.", time: expect.any(String) });
    expect((await platform.consoleApi(`/api/runs/${run.id}`).then((r) => r.json())).state).toBe("running");
    gate.release();
    await live.waitFor((message) => message.type === "log" && message.runId === run.id && message.entry.text === "Landed");

    const live2 = await platform.live();
    const snapshot = await live2.waitFor((message) => message.type === "snapshot");
    for (const entry of [...snapshot.runs, ...live.messages.filter((m) => m.type === "run").map((m) => m.run)]) expect(entry).not.toHaveProperty("log");
    expect(await (await platform.consoleApi("/api/runs")).json()).toEqual([expect.not.objectContaining({ log: expect.anything() })]);
  });

  it("keeps Claude's thinking and tool calls, sends them live, and still has them after a restart", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "sma-log-"));
    try {
      const before = await start(dataDir);
      const gate = new Gate();
      before.agent.enqueue(async (run) => {
        run.thinking("The Player wants snow.");
        run.tool("Read index.html");
        await gate.wait();
        run.thinking("  ");
        run.tool("Refused: Read /etc/hostname (outside the Canvas)");
        await run.writeFile("features/snow/snow.js", "snow");
      });
      const live = await before.platform.live();

      const run = await before.platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" });
      const thought = await live.waitFor((message) => message.type === "log" && message.runId === run.id && message.entry.source === "thinking");
      expect(thought.entry).toMatchObject({ source: "thinking", text: "The Player wants snow.", time: expect.any(String) });
      const tool = await live.waitFor((message) => message.type === "log" && message.runId === run.id && message.entry.source === "tool");
      expect(tool.entry).toMatchObject({ source: "tool", text: "Read index.html" });
      gate.release();
      await before.platform.waitForRun(run.id);
      await before.platform.close();
      platforms.splice(platforms.indexOf(before.platform), 1);

      const after = await start(dataDir);
      expect(lines(await logOf(after.platform, run.id))).toEqual([
        "platform: Queued",
        "platform: Started",
        "thinking: The Player wants snow.",
        "tool: Read index.html",
        "tool: Refused: Read /etc/hostname (outside the Canvas)",
        "platform: Rebasing onto the latest Canvas",
        "platform: Checking that the Canvas renders",
        "platform: Landed",
      ]);
    } finally {
      await Promise.all(platforms.splice(0).map((p) => p.close()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
