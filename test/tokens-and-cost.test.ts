import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { RunStore } from "../src/run-store.ts";
import { FakeAgent, Gate, type FakeAgentContext } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform, type TestPlatformOptions } from "./support/harness.ts";

/**
 * Prices (per million tokens): Sonnet 5.5 $2 input, $10 output, $0.20 cache
 * read, $2.50 cache write; Opus 5.5 $4, $20, $0.20, $5.
 */
async function start(options: TestPlatformOptions = {}) {
  const agent = new FakeAgent();
  const started = await startTestPlatform({ agent, maxParallelRuns: 1, ...options });
  // Closing twice fails, and a restart test closes the first platform itself.
  let closing: Promise<void> | undefined;
  const platform: TestPlatform = { ...started, close: () => (closing ??= started.close()) };
  onTestFinished(() => platform.close());
  return { platform, agent };
}

async function listed(platform: TestPlatform, id: string) {
  const runs = (await (await platform.consoleApi("/api/runs")).json()) as Array<{ id: string; usage?: unknown }>;
  return runs.find((run) => run.id === id);
}

/** Lands a Prompt whose Agent reports `usage` and writes one file. */
async function landWith(platform: TestPlatform, agent: FakeAgent, nickname: string, prompt: string, ...usage: Parameters<FakeAgentContext["usage"]>[0][]) {
  agent.enqueue(async (run) => {
    for (const each of usage) run.usage(each);
    await run.writeFile(`features/${nickname}/index.js`, prompt);
  });
  const run = await platform.waitForRun((await platform.sendPrompt({ nickname, prompt })).id);
  expect(run.state).toBe("landed");
  return run;
}

/** Saves the Run again as if it had been recorded before usage was. */
function forgetUsage(dataDir: string, id: string): void {
  const store = new RunStore(path.join(dataDir, "runs.sqlite"));
  const { usageByModel: _usage, ...older } = store.all().find((run) => run.id === id)!;
  store.save({ ...older, progress: [] });
  store.close();
}

async function tempDataDir(): Promise<string> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sma-usage-"));
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

describe("Tokens and cost per Prompt", () => {

  it("adds up a Run's usage events into its summary, with the cost of each kind of token", async () => {
    const { platform, agent } = await start();
    agent.enqueue(async (run) => {
      run.usage({ inputTokens: 600, outputTokens: 300, cacheReadTokens: 30_000, cacheWriteTokens: 100 });
      await run.writeFile("features/snow/snow.js", "snow");
      run.usage({ inputTokens: 400, outputTokens: 200, cacheReadTokens: 10_000, cacheWriteTokens: 100 });
    });

    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" })).id);

    // 1,000 × $2 + 500 × $10 + 40,000 × $0.20 + 200 × $2.50 = $0.0155
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 40_000, cacheWriteTokens: 200, cost: expect.closeTo(0.0155, 9) };
    expect(run).toMatchObject({ state: "landed", usage });
    expect(await listed(platform, run.id)).toMatchObject({ usage });
  });

  it("updates the Run's summary live while it's in progress", async () => {
    const { platform, agent } = await start();
    const gate = new Gate();
    agent.enqueue(async (run) => {
      run.usage({ inputTokens: 1000, outputTokens: 0 });
      await gate.wait();
      run.usage({ inputTokens: 1000, outputTokens: 0 });
      await gate.wait();
      await run.writeFile("features/snow/snow.js", "snow");
    });
    const live = await platform.live();
    const sent = await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" });

    const first = await live.waitFor((message) => message.type === "run" && message.run.id === sent.id && message.run.usage?.inputTokens === 1000);
    expect(first.run).toMatchObject({ state: "running", usage: { inputTokens: 1000, cost: expect.closeTo(0.002, 9) } });
    expect((await listed(platform, sent.id))?.usage).toMatchObject({ inputTokens: 1000 });
    gate.release();
    const second = await live.waitFor((message) => message.type === "run" && message.run.id === sent.id && message.run.usage?.inputTokens === 2000);
    expect(second.run.usage).toMatchObject({ cost: expect.closeTo(0.004, 9) });
    live.close();
  });

  it("includes a conflict fix on Sonnet in an Opus Prompt's usage, each priced at its own model's rates", async () => {
    const { platform, agent } = await start({ maxParallelRuns: 2 });
    const hold = new Gate();
    agent.enqueue(
      async (run) => {
        run.usage({ inputTokens: 1000, outputTokens: 100 });
        await run.writeFile("index.html", "<h1>Snow</h1>");
        await hold.wait();
      },
      (run) => run.writeFile("index.html", "<h1>Rain</h1>"),
      async (run) => {
        // The conflict fix, which always uses Sonnet.
        run.usage({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000 });
        await run.writeFile("index.html", "<h1>Snow and Rain</h1>");
      },
    );
    const alice = await platform.sendPrompt({ nickname: "Alice", prompt: "title it Snow", model: "claude-opus-5-5" });
    await agent.started(1);
    expect(await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "title it Rain" })).id)).toMatchObject({ state: "landed" });
    hold.release();

    const finished = await platform.waitForRun(alice.id);
    expect(finished.state).toBe("landed");
    expect(agent.tasks[2].model).toBe("claude-sonnet-5-5");
    // Opus: 1,000 × $4 + 100 × $20 = $0.006. Sonnet: 1,000 × $2 + 100 × $10 + 5,000 × $0.20 = $0.004.
    expect(finished).toMatchObject({ usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0, cost: expect.closeTo(0.01, 9) } });
  });

  it("keeps a Run's usage over a restart and keeps adding to it when the Run starts over", async () => {
    const dataDir = await tempDataDir();
    const before = await start({ dataDir });
    before.agent.enqueue(async (run) => {
      run.usage({ inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 400 });
      await interruptedByRestart(run);
    });
    const sent = await before.platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" });
    await expect.poll(async () => (await listed(before.platform, sent.id))?.usage).toMatchObject({ inputTokens: 1000 });
    await before.platform.close();

    const after = await start({ dataDir });
    const gate = new Gate();
    after.agent.enqueue(async (run) => {
      await gate.wait();
      run.usage({ inputTokens: 500, outputTokens: 50, cacheReadTokens: 2000 });
      await run.writeFile("features/snow/snow.js", "snow");
    });
    expect((await listed(after.platform, sent.id))?.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 400 });
    gate.release();

    expect(await after.platform.waitForRun(sent.id)).toMatchObject({
      state: "landed",
      usage: { inputTokens: 1500, outputTokens: 150, cacheReadTokens: 2000, cacheWriteTokens: 400 },
    });
  });

  it("shows zero for a Rollback that reverted cleanly, without Claude", async () => {
    const { platform, agent } = await start();
    agent.enqueue(async (run) => {
      run.usage({ inputTokens: 1000, outputTokens: 100 });
      await run.writeFile("features/snow/snow.js", "snow");
    });
    const snow = await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" })).id);

    const response = await platform.consoleApi("/api/rollbacks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "nickname=Bob" },
      body: JSON.stringify({ commit: snow.commit }),
    });
    const rollback = await platform.waitForRun(((await response.json()) as { id: string }).id);

    expect(rollback).toMatchObject({ state: "landed", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 } });
    expect(await listed(platform, snow.id)).toMatchObject({ usage: { inputTokens: 1000 } });
  });

  it("has no usage for a Run recorded before usage was", async () => {
    const dataDir = await tempDataDir();
    const before = await start({ dataDir });
    before.agent.enqueue((run) => run.writeFile("features/snow/snow.js", "snow"));
    const snow = await before.platform.waitForRun((await before.platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" })).id);
    await before.platform.close();
    forgetUsage(dataDir, snow.id);

    const after = await start({ dataDir });
    expect(await listed(after.platform, snow.id)).not.toHaveProperty("usage");
    expect(await (await after.platform.consoleApi(`/api/runs/${snow.id}`)).json()).not.toHaveProperty("usage");
  });

  it("doesn't start counting usage for a Run recorded before usage was that starts over after the upgrade", async () => {
    const dataDir = await tempDataDir();
    const before = await start({ dataDir });
    before.agent.enqueue(interruptedByRestart);
    const sent = await before.platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" });
    await before.agent.started(1);
    await before.platform.close();
    forgetUsage(dataDir, sent.id);

    const after = await start({ dataDir });
    after.agent.enqueue(async (run) => {
      run.usage({ inputTokens: 500, outputTokens: 50 });
      await run.writeFile("features/snow/snow.js", "snow");
    });
    expect(await after.platform.waitForRun(sent.id)).toMatchObject({ state: "landed" });
    expect(await listed(after.platform, sent.id)).not.toHaveProperty("usage");
    expect(await (await after.platform.consoleApi(`/api/runs/${sent.id}`)).json()).not.toHaveProperty("usage");
  });
});

describe("The tokens and cost line", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  async function open(url: string): Promise<Page> {
    const context = await browser.newContext();
    onTestFinished(() => context.close());
    const page = await context.newPage();
    await page.goto(url);
    return page;
  }
  const entryLine = (page: Page, id: string) => page.locator(`[data-testid="prompts"] li[data-run="${id}"] > .details .usage`);

  it("shows uncached and total tokens rounded with k and M, and the estimated cost, on every Prompts list entry", async () => {
    const { platform, agent } = await start();
    const ann = await landWith(platform, agent, "Ann", "under a thousand", { inputTokens: 850, outputTokens: 0 });
    // Uncached 1,000 + 200 written + 0 output = 1.2k; total with 46,800 read = 48k; $0.002 + $0.0005 + $0.00936 = $0.01186.
    const ben = await landWith(platform, agent, "Ben", "thousands", { inputTokens: 1000, outputTokens: 0, cacheWriteTokens: 200 }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 46_800 });
    // $2.20 + 1,400,000 × $0.20 = $2.48.
    const cat = await landWith(platform, agent, "Cat", "millions", { inputTokens: 1_100_000, outputTokens: 0, cacheReadTokens: 1_400_000 });
    // 15,500 × $10 = $0.155, plus 7,750 input × $2 = $0.0155: $0.1705.
    const dan = await landWith(platform, agent, "Dan", "a few cents", { inputTokens: 7750, outputTokens: 15_500 });
    // 999,960 rounds to 1M, not 1000k; $1.99992.
    const eve = await landWith(platform, agent, "Eve", "just under a million", { inputTokens: 999_960, outputTokens: 0 });

    const page = await open(platform.consoleUrl + "/");
    await expect.poll(() => entryLine(page, ann.id).textContent()).toBe("850 (850) tokens · <$0.01");
    expect(await entryLine(page, ben.id).textContent()).toBe("1.2k (48k) tokens · ~$0.01");
    expect(await entryLine(page, cat.id).textContent()).toBe("1.1M (2.5M) tokens · ~$2.48");
    expect(await entryLine(page, dan.id).textContent()).toBe("23.3k (23.3k) tokens · ~$0.17");
    expect(await entryLine(page, eve.id).textContent()).toBe("1M (1M) tokens · ~$2.00");
  });

  it("updates live in the list and on the Run page while the Run is in progress", async () => {
    const { platform, agent } = await start();
    const gate = new Gate();
    agent.enqueue(async (run) => {
      run.usage({ inputTokens: 1000, outputTokens: 0 });
      await gate.wait();
      run.usage({ inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 30_000 });
      await interruptedByRestart(run);
    });
    const sent = await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" });
    const list = await open(platform.consoleUrl + "/");
    const runPage = await open(`${platform.consoleUrl}/runs/${sent.id}`);
    const pageLine = runPage.getByTestId("run").locator(".details .usage");

    await expect.poll(() => entryLine(list, sent.id).textContent(), { timeout: 10_000 }).toBe("1k (1k) tokens · <$0.01");
    await expect.poll(() => pageLine.textContent(), { timeout: 10_000 }).toBe("1k (1k) tokens · <$0.01");
    gate.release();
    // 3k uncached, 33k in all: $0.004 + $0.01 + $0.006 = $0.02.
    await expect.poll(() => entryLine(list, sent.id).textContent(), { timeout: 10_000 }).toBe("3k (33k) tokens · ~$0.02");
    await expect.poll(() => pageLine.textContent(), { timeout: 10_000 }).toBe("3k (33k) tokens · ~$0.02");
  });

  it("shows zero for a clean-revert Rollback and a dash for a Run recorded before usage was", async () => {
    const dataDir = await tempDataDir();
    const before = await start({ dataDir });
    const snow = await landWith(before.platform, before.agent, "Alice", "make it snow", { inputTokens: 1000, outputTokens: 0 });
    const response = await before.platform.consoleApi("/api/rollbacks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "nickname=Bob" },
      body: JSON.stringify({ commit: snow.commit }),
    });
    const rollback = await before.platform.waitForRun(((await response.json()) as { id: string }).id);
    await before.platform.close();
    forgetUsage(dataDir, snow.id);
    const { platform } = await start({ dataDir });

    const list = await open(platform.consoleUrl + "/");
    const entries = list.getByTestId("prompts").locator("li");
    await expect.poll(() => entries.count()).toBe(2);
    expect(await entryLine(list, rollback.id).textContent()).toBe("0 (0) tokens · ~$0.00");
    expect(await entryLine(list, snow.id).textContent()).toBe("—");

    const rollbackPage = await open(`${platform.consoleUrl}/runs/${rollback.id}`);
    await expect.poll(() => rollbackPage.getByTestId("run").locator(".details .usage").textContent()).toBe("0 (0) tokens · ~$0.00");
    const olderPage = await open(`${platform.consoleUrl}/runs/${snow.id}`);
    await expect.poll(() => olderPage.getByTestId("run").locator(".details .usage").textContent()).toBe("—");
  });
});

async function interruptedByRestart(run: FakeAgentContext): Promise<void> {
  await run.aborted();
  throw new Error("aborted");
}
