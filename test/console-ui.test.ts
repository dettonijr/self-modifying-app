import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeAgent, Gate, type FakeAgentContext } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform, type TestPlatformOptions } from "./support/harness.ts";

describe("Console UI", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function open(
    agent = new FakeAgent(),
    options: TestPlatformOptions = {},
  ): Promise<{ page: Page; platform: TestPlatform; agent: FakeAgent }> {
    const platform = await startTestPlatform({ agent, maxParallelRuns: 1, ...options });
    platforms.push(platform);
    const page = await (await browser.newContext()).newPage();
    await page.goto(platform.consoleUrl + "/");
    return { page, platform, agent };
  }

  it("asks for a nickname on first visit, remembers it in a cookie and lets the Player change it", async () => {
    const { page, platform } = await open();

    await page.getByLabel("Nickname").fill("Alice");
    await page.getByRole("button", { name: "Join" }).click();
    await expect.poll(() => page.getByTestId("current-nickname").textContent()).toBe("Alice");

    const cookies = await page.context().cookies(platform.consoleUrl);
    expect(cookies.find((c) => c.name === "nickname")?.value).toBe("Alice");

    await page.reload();
    expect(await page.getByLabel("Nickname").isVisible()).toBe(false);
    expect(await page.getByTestId("current-nickname").textContent()).toBe("Alice");

    await page.getByRole("button", { name: "Change nickname" }).click();
    await page.getByLabel("Nickname").fill("Alicia");
    await page.getByRole("button", { name: "Join" }).click();
    await expect.poll(() => page.getByTestId("current-nickname").textContent()).toBe("Alicia");
    expect((await page.context().cookies(platform.consoleUrl)).find((c) => c.name === "nickname")?.value).toBe("Alicia");
  });

  it("limits the Prompt to 500 characters with a visible counter", async () => {
    const { page } = await join(await open());
    const box = page.getByLabel("Prompt");
    expect(await page.getByTestId("prompt-counter").textContent()).toBe("0 / 500");

    await box.fill("make it snow");
    expect(await page.getByTestId("prompt-counter").textContent()).toBe("12 / 500");

    await box.fill("a".repeat(600));
    expect((await box.inputValue()).length).toBe(500);
    expect(await page.getByTestId("prompt-counter").textContent()).toBe("500 / 500");
  });

  it("offers only Sonnet 5.5 and Opus 5.5, with Sonnet 5.5 as the default", async () => {
    const { page } = await join(await open());
    const model = page.getByLabel("Model");
    const options = await model.locator("option").evaluateAll((all) =>
      all.map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent })),
    );
    expect(options).toEqual([
      { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
      { value: "claude-opus-5-5", label: "Opus 5.5" },
    ]);
    expect(await model.inputValue()).toBe("claude-sonnet-5-5");
  });

  it("sends a Prompt with the picked model, and lists it in the history once it Lands", async () => {
    const { page, platform, agent } = await join(await open());
    agent.enqueue((run) => run.writeFile("index.html", "<h1>Snowing</h1>"));

    await page.getByLabel("Prompt").fill("make it snow");
    await page.getByLabel("Model").selectOption("claude-opus-5-5");
    await page.getByRole("button", { name: "Send" }).click();

    const entry = page.getByTestId("history").locator("li").first();
    await expect.poll(() => entry.textContent(), { timeout: 10_000 }).toContain("make it snow");
    expect(await entry.textContent()).toContain("Alice");
    expect(await entry.locator("time").getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(agent.tasks[0].model).toBe("claude-opus-5-5");
    expect(await (await platform.fetchCanvas("/")).text()).toContain("<h1>Snowing</h1>");
  });

  it("Rolls back a change from the history only after the Player confirms, and lists the Rollback", async () => {
    const { page, platform, agent } = await join(await open());
    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "snow"));
    const snowRun = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    const history = page.getByTestId("history");
    await page.reload();
    const snow = history.locator("li", { hasText: "make it snow" });
    await snow.waitFor();

    await snow.getByRole("button", { name: "Roll back" }).click();
    expect(await snow.textContent()).toContain("Roll back Bob's change?");
    await snow.getByRole("button", { name: "Keep it" }).click();
    expect(await snow.getByRole("button", { name: "Yes, roll back" }).count()).toBe(0);
    expect(await history.locator("li").count()).toBe(1);

    await snow.getByRole("button", { name: "Roll back" }).click();
    await snow.getByRole("button", { name: "Yes, roll back" }).click();
    await expect.poll(() => history.locator("li").count(), { timeout: 10_000 }).toBe(2);
    const entry = history.locator("li").first();
    expect(await entry.textContent()).toContain("Alice rolled back Bob's");
    expect(await entry.textContent()).toContain("make it snow");
    expect(await entry.textContent()).toContain(snowRun.commit!.slice(0, 7));
    expect(await entry.getByRole("button", { name: "Roll back" }).count()).toBe(1);
    expect(await entry.getByRole("button", { name: "Fix it to this!" }).count()).toBe(1);
    expect((await platform.fetchCanvas("/features/snow/snow.js")).status).toBe(404);
  });

  it("shows the running cost live to everyone, and the paused state once the spending cap is reached", async () => {
    const { page, platform, agent } = await open(new FakeAgent(), { spendingCapUsd: 2 });
    const watcher = await (await browser.newContext()).newPage();
    await watcher.goto(platform.consoleUrl + "/");
    for (const p of [page, watcher]) await expect.poll(() => p.getByTestId("spending").textContent()).toContain("$0.00 of $2.00");

    agent.enqueue(
      async (run) => {
        run.usage({ inputTokens: 100_000, outputTokens: 100_000 }); // $1.20 on Sonnet 5.5
        await run.writeFile("index.html", "<h1>one</h1>");
      },
      async (run) => {
        run.usage({ inputTokens: 400_000, outputTokens: 0 }); // $0.80 more: the cap
        await run.writeFile("index.html", "<h1>two</h1>");
      },
    );
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "one" })).id);
    await expect.poll(() => watcher.getByTestId("spending").textContent(), { timeout: 10_000 }).toContain("$1.20 of $2.00");
    expect(await watcher.getByTestId("paused").isVisible()).toBe(false);

    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "two" })).id);
    await expect.poll(() => watcher.getByTestId("paused").isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await watcher.getByTestId("paused").textContent()).toMatch(/spending cap/i);
    expect(await watcher.getByTestId("spending").textContent()).toContain("$2.00 of $2.00");

    await join({ page });
    await page.getByLabel("Prompt").fill("three");
    await expect.poll(() => page.getByRole("button", { name: "Send" }).isDisabled(), { timeout: 10_000 }).toBe(true);
    const history = page.getByTestId("history");
    await expect.poll(() => history.locator("li").count(), { timeout: 10_000 }).toBe(2);
    for (const name of ["Fix it to this!", "Roll back"]) {
      const buttons = history.getByRole("button", { name });
      await expect.poll(() => buttons.count()).toBe(2);
      for (const button of await buttons.all()) await expect.poll(() => button.isDisabled(), { timeout: 10_000 }).toBe(true);
    }
  });

  it("tells the Player why their Prompt didn't Land when the Canvas didn't render", async () => {
    const { page, agent } = await join(await open());
    // The Run, both resolution attempts and the restart all leave the page blank.
    const blank = (run: FakeAgentContext) => run.writeFile("index.html", "<body></body>");
    agent.enqueue(blank, blank, blank, blank);

    await page.getByLabel("Prompt").fill("blank it");
    await page.getByRole("button", { name: "Send" }).click();

    await expect.poll(() => page.locator("#status").textContent(), { timeout: 10_000 }).toContain("Canvas didn't render");
  });

  it("shows the live queue, the Run in progress with its progress, and each Run's outcome with its reason", async () => {
    const { page, platform, agent } = await join(await open());
    const gate = new Gate();
    agent.enqueue(
      async (run) => {
        await run.writeFile("features/snow/snow.js", "snow");
        await gate.wait();
      },
      () => {
        throw new Error("Claude gave up");
      },
    );
    const queue = page.getByTestId("queue");
    const runs = page.getByTestId("runs");

    await page.getByLabel("Prompt").fill("make it snow");
    await page.getByRole("button", { name: "Send" }).click();
    const snow = runs.locator("li", { hasText: "make it snow" });
    await expect.poll(() => snow.textContent(), { timeout: 10_000 }).toContain("features/snow/snow.js");
    expect(await snow.textContent()).toContain("Alice");
    expect(await snow.textContent()).toMatch(/running/i);

    await platform.sendPrompt({ nickname: "Bob", prompt: "make it rain" });
    await expect.poll(() => queue.textContent()).toContain("make it rain");
    expect(await queue.textContent()).toContain("Bob");

    gate.release();
    await expect.poll(() => snow.textContent(), { timeout: 10_000 }).toMatch(/landed/i);
    await expect.poll(() => queue.locator("li").count()).toBe(0);
    const rain = runs.locator("li", { hasText: "make it rain" });
    await expect.poll(() => rain.textContent(), { timeout: 10_000 }).toMatch(/rejected/i);
    expect(await rain.textContent()).toContain("Claude gave up");
  });

  it("shows a Run resolving, with the resolution's progress, and restarted", async () => {
    const { page, agent } = await join(await open());
    const resolving = new Gate();
    const restarted = new Gate();
    agent.enqueue(
      (run) => run.writeFile("index.html", "<!doctype html><html><body></body></html>"),
      async (run) => {
        await run.writeFile("features/fix/fix.js", "fix");
        await Promise.race([resolving.wait(), run.aborted()]);
        throw new Error("couldn't fix it");
      },
      () => {
        throw new Error("couldn't fix it either");
      },
      async (run) => {
        await Promise.race([restarted.wait(), run.aborted()]);
        await run.writeFile("index.html", "<h1>Fixed</h1>");
      },
    );

    await page.getByLabel("Prompt").fill("break the page");
    await page.getByRole("button", { name: "Send" }).click();
    const run = page.getByTestId("runs").locator("li", { hasText: "break the page" });
    await expect.poll(() => run.textContent(), { timeout: 10_000 }).toMatch(/resolving/i);
    await expect.poll(() => run.textContent()).toContain("features/fix/fix.js");
    resolving.release();
    await expect.poll(() => run.textContent(), { timeout: 10_000 }).toMatch(/restarted/i);
    restarted.release();
    await expect.poll(() => run.textContent(), { timeout: 10_000 }).toMatch(/landed/i);
  });

  it("replays a change from the history after a confirmation, with the picked model, and credits the replayer", async () => {
    const { page, platform, agent } = await join(await open());
    agent.enqueue((run) => run.writeFile("index.html", "<h1>Snowing</h1>"));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    const original = page.getByTestId("history").locator("li", { hasText: "make it snow" });
    await expect.poll(() => original.count(), { timeout: 10_000 }).toBe(1);

    await original.getByRole("button", { name: "Fix it to this!" }).click();
    expect(await original.getByRole("button", { name: "Replay" }).isVisible()).toBe(true);
    await original.getByRole("button", { name: "Cancel" }).click();
    expect(await original.getByRole("button", { name: "Replay" }).count()).toBe(0);
    expect(agent.tasks).toHaveLength(1);

    agent.enqueue((run) => run.writeFile("index.html", "<h1>Snowing again</h1>"));
    await original.getByRole("button", { name: "Fix it to this!" }).click();
    await original.getByLabel("Replay model").selectOption("claude-opus-5-5");
    await original.getByRole("button", { name: "Replay" }).click();

    const entry = page.getByTestId("history").locator("li").first();
    await expect.poll(() => entry.textContent(), { timeout: 10_000 }).toContain("↻ Alice replayed Bob's");
    expect(await entry.textContent()).toContain("make it snow");
    const [replayed, snow] = await (await platform.consoleApi("/api/history")).json();
    expect(await entry.getAttribute("data-original")).toBe(snow.commit);
    expect(replayed.kind).toBe("Replay");
    expect(agent.tasks[1].model).toBe("claude-opus-5-5");
  });

  it("tells the Player they already have a Prompt waiting", async () => {
    const { page, platform, agent } = await join(await open());
    const gate = new Gate();
    agent.enqueue(async (run) => {
      await gate.wait();
      await run.writeFile("index.html", "x");
    });
    await platform.sendPrompt({ nickname: "Bob", prompt: "first" });
    await agent.started(1);

    await page.getByLabel("Prompt").fill("second");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.getByTestId("queue").textContent()).toContain("second");
    await page.getByLabel("Prompt").fill("third");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => page.getByRole("status").textContent()).toMatch(/already have a Prompt waiting/);
    gate.release();
  });
});

async function join<T extends { page: Page }>(opened: T): Promise<T> {
  await opened.page.getByLabel("Nickname").fill("Alice");
  await opened.page.getByRole("button", { name: "Join" }).click();
  await opened.page.getByTestId("current-nickname").waitFor();
  return opened;
}
