import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

describe("The queue", () => {
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function start() {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent, maxParallelRuns: 1 });
    platforms.push(platform);
    return { platform, agent };
  }

  it("queues a second Player's Prompt and runs it after the first one Lands", async () => {
    const { platform, agent } = await start();
    const gate = new Gate();
    agent.enqueue(
      async (run) => {
        await gate.wait();
        await run.writeFile("features/snow/snow.js", "snow");
      },
      (run) => run.writeFile("features/rain/rain.js", "rain"),
    );
    const first = await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" });
    await agent.started(1);

    const second = await platform.sendPrompt({ nickname: "Bob", prompt: "make it rain" });
    expect(second).toMatchObject({ state: "waiting", nickname: "Bob" });
    expect(agent.tasks).toHaveLength(1);

    gate.release();
    expect(await platform.waitForRun(first.id)).toMatchObject({ state: "landed" });
    expect(await platform.waitForRun(second.id)).toMatchObject({ state: "landed" });
    expect(await (await platform.fetchCanvas("/features/snow/snow.js")).text()).toBe("snow");
    expect(await (await platform.fetchCanvas("/features/rain/rain.js")).text()).toBe("rain");
  });

  it("refuses a second waiting Prompt from the same Player, until their first one starts running", async () => {
    const { platform, agent } = await start();
    const first = new Gate();
    const second = new Gate();
    agent.enqueue(
      async (run) => {
        await first.wait();
        await run.writeFile("features/a/a.js", "a");
      },
      async (run) => {
        await second.wait();
        await run.writeFile("features/b/b.js", "b");
      },
      (run) => run.writeFile("features/c/c.js", "c"),
    );
    await platform.sendPrompt({ nickname: "Bob", prompt: "a" });
    await agent.started(1);
    const waiting = await platform.sendPrompt({ nickname: "Alice", prompt: "b" });

    const refused = await platform.consoleApi("/api/prompts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "nickname=Alice" },
      body: JSON.stringify({ prompt: "c" }),
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/already have a Prompt waiting/);

    first.release();
    await agent.started(2);
    expect(await (await platform.consoleApi(`/api/runs/${waiting.id}`)).json()).toMatchObject({ state: "running" });
    const third = await platform.sendPrompt({ nickname: "Alice", prompt: "c" });
    expect(third).toMatchObject({ state: "waiting" });

    second.release();
    expect(await platform.waitForRun(third.id)).toMatchObject({ state: "landed" });
  });
});

describe("Live updates in the Console", () => {
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });

  it("sends Console clients the queue, Run state changes and progress events as they happen", async () => {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent, maxParallelRuns: 1 });
    platforms.push(platform);
    const live = await platform.live();
    expect(await live.waitFor((m) => m.type === "snapshot")).toMatchObject({ queue: [], runs: [] });

    const gate = new Gate();
    agent.enqueue(
      async (run) => {
        await run.writeFile("features/snow/snow.js", "snow");
        await gate.wait();
      },
      (run) => run.writeFile("features/rain/rain.js", "rain"),
    );
    const first = await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" });
    await live.waitFor((m) => m.type === "run" && m.run.id === first.id && m.run.state === "running");
    const progress = await live.waitFor((m) => m.type === "progress" && m.runId === first.id);
    expect(progress).toMatchObject({ file: "features/snow/snow.js", message: "Editing features/snow/snow.js" });

    const second = await platform.sendPrompt({ nickname: "Bob", prompt: "make it rain" });
    await live.waitFor(
      (m) => m.type === "queue" && m.queue.length === 1 && m.queue[0].nickname === "Bob" && m.queue[0].prompt === "make it rain",
    );

    // A Console page that connects now sees what's already going on.
    const late = await platform.live();
    const snapshot = await late.waitFor((m) => m.type === "snapshot");
    expect(snapshot.queue).toMatchObject([{ id: second.id, nickname: "Bob", prompt: "make it rain", state: "waiting" }]);
    expect(snapshot.runs).toMatchObject([
      { id: second.id, nickname: "Bob", state: "waiting" },
      { id: first.id, nickname: "Alice", state: "running" },
    ]);

    gate.release();
    await live.waitFor((m) => m.type === "run" && m.run.id === first.id && m.run.state === "landing");
    await live.waitFor((m) => m.type === "run" && m.run.id === first.id && m.run.state === "landed");
    await live.waitFor((m) => m.type === "queue" && m.queue.length === 0);
    await live.waitFor((m) => m.type === "run" && m.run.id === second.id && m.run.state === "landed");

    const states = live.messages.filter((m) => m.type === "run" && m.run.id === second.id).map((m) => m.run.state);
    expect(states).toEqual(["waiting", "running", "landing", "landed"]);
  });

  it("tells Console clients why a Run failed or was rejected", async () => {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent, maxParallelRuns: 1 });
    platforms.push(platform);
    const live = await platform.live();
    agent.enqueue(
      () => {
        throw new Error("Claude gave up");
      },
      () => {},
    );

    const failed = await platform.sendPrompt({ nickname: "Alice", prompt: "break it" });
    const failure = await live.waitFor((m) => m.type === "run" && m.run.id === failed.id && m.run.state === "rejected");
    expect(failure.run.error).toBe("Claude gave up");

    const empty = await platform.sendPrompt({ nickname: "Alice", prompt: "do nothing" });
    const rejection = await live.waitFor((m) => m.type === "run" && m.run.id === empty.id && m.run.state === "rejected");
    expect(rejection.run.error).toMatch(/\w/);
  });

  it("disconnects Console clients when the platform stops", async () => {
    const platform = await startTestPlatform();
    const { default: WebSocket } = await import("ws");
    const socket = new WebSocket(platform.consoleUrl.replace(/^http/, "ws") + "/api/live");
    await new Promise((resolve) => socket.once("open", resolve));
    const closed = new Promise((resolve) => socket.once("close", resolve));
    await platform.close();
    await closed;
  });

  it("refuses WebSocket connections from other origins", async () => {
    const platform = await startTestPlatform();
    platforms.push(platform);
    const { default: WebSocket } = await import("ws");
    const socket = new WebSocket(platform.consoleUrl.replace(/^http/, "ws") + "/api/live", { origin: platform.canvasUrl });
    const outcome = await new Promise<string>((resolve) => {
      socket.once("open", () => resolve("open"));
      socket.once("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
      socket.once("error", () => resolve("error"));
    });
    expect(outcome).toBe("403");
  });
});
