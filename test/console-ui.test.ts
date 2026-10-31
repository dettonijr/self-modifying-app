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

  it("has a single Prompts list, and no separate Queue, Runs or History lists", async () => {
    const { page } = await open();
    expect(await page.getByRole("heading", { level: 2 }).allTextContents()).toEqual(["Prompts"]);
    expect(await page.getByTestId("prompts").count()).toBe(1);
    for (const old of ["queue", "runs", "history"]) expect(await page.getByTestId(old).count()).toBe(0);
  });

  it("sends a Prompt with the picked model, and shows its entry with state, nickname, model, time and outcome once it Lands", async () => {
    const { page, platform, agent } = await join(await open());
    agent.enqueue((run) => run.writeFile("index.html", "<h1>Snowing</h1>"));

    await page.getByLabel("Prompt").fill("make it snow");
    await page.getByLabel("Model").selectOption("claude-opus-5-5");
    await page.getByRole("button", { name: "Send" }).click();

    const entry = page.getByTestId("prompts").locator("li").first();
    await expect.poll(() => entry.getAttribute("data-state"), { timeout: 10_000 }).toBe("landed");
    expect(await entry.locator(".state").textContent()).toMatch(/landed/i);
    expect(await entry.locator(".nickname").textContent()).toBe("Alice");
    expect(await entry.locator(".prompt").textContent()).toBe("make it snow");
    expect(await entry.locator(".model").textContent()).toBe("Opus 5.5");
    expect(await entry.locator(".outcome").textContent()).toBe("Landed");
    expect(await entry.locator("time").getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(agent.tasks[0].model).toBe("claude-opus-5-5");
    expect(await (await platform.fetchCanvas("/")).text()).toContain("<h1>Snowing</h1>");
  });

  it("shortens long Prompts in the list, keeping the whole Prompt as its title", async () => {
    const { page, platform, agent } = await join(await open());
    const long = "make it snow " + "and then some more ".repeat(20);
    agent.enqueue((run) => run.writeFile("index.html", "<h1>Snowing</h1>"));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: long.trim() })).id);
    const prompt = page.getByTestId("prompts").locator("li .prompt").first();
    await expect.poll(() => prompt.getAttribute("title"), { timeout: 10_000 }).toBe(long.trim());
    const shown = (await prompt.textContent())!;
    expect(shown.length).toBeLessThan(100);
    expect(shown).toMatch(/^make it snow .*…$/);
  });

  it("Rolls back a Landed change only after the Player confirms, and lists the Rollback", async () => {
    const { page, platform, agent } = await join(await open());
    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "snow"));
    const snowRun = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    const history = page.getByTestId("prompts");
    await page.reload();
    const snow = history.locator("li", { hasText: "make it snow" });
    await snow.waitFor();

    await snow.getByRole("button", { name: "Roll back", exact: true }).click();
    expect(await snow.textContent()).toContain("Roll back Bob's change?");
    await snow.getByRole("button", { name: "Keep it" }).click();
    expect(await snow.getByRole("button", { name: "Yes, roll back" }).count()).toBe(0);
    expect(await history.locator("li").count()).toBe(1);

    await snow.getByRole("button", { name: "Roll back", exact: true }).click();
    await snow.getByRole("button", { name: "Yes, roll back" }).click();
    await expect.poll(() => history.locator("li").count(), { timeout: 10_000 }).toBe(2);
    const entry = history.locator("li").first();
    await expect.poll(() => entry.getAttribute("data-state"), { timeout: 10_000 }).toBe("landed");
    expect(await entry.textContent()).toContain("↩ Alice rolled back Bob's");
    expect(await entry.textContent()).toContain("make it snow");
    expect(await entry.textContent()).toContain(snowRun.commit!.slice(0, 7));
    expect(await entry.getAttribute("data-original")).toBe(snowRun.commit);
    expect(await entry.getByRole("button", { name: "Roll back", exact: true }).count()).toBe(1);
    expect(await entry.getByRole("button", { name: "Replay", exact: true }).count()).toBe(1);
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
    const history = page.getByTestId("prompts");
    await expect.poll(() => history.locator("li").count(), { timeout: 10_000 }).toBe(2);
    for (const name of ["Replay", "Roll back"]) {
      const buttons = history.getByRole("button", { name, exact: true });
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

  it("shows each Prompt once, updating its entry in place from waiting to running to Landed, and keeps rejected ones with their reason", async () => {
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
    const list = page.getByTestId("prompts");
    const snow = list.locator("li", { hasText: "make it snow" });
    const rain = list.locator("li", { hasText: "make it rain" });
    const noActions = async (entry: typeof snow) => {
      for (const name of ["Replay", "Roll back"]) expect(await entry.getByRole("button", { name, exact: true }).count()).toBe(0);
    };

    await page.getByLabel("Prompt").fill("make it snow");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => snow.getAttribute("data-state"), { timeout: 10_000 }).toBe("running");
    expect(await snow.textContent()).toContain("Alice");
    expect(await snow.locator(".state").textContent()).toMatch(/running/i);
    await noActions(snow);

    await platform.sendPrompt({ nickname: "Bob", prompt: "make it rain" });
    await expect.poll(() => rain.getAttribute("data-state")).toBe("waiting");
    expect(await rain.textContent()).toContain("Bob");
    await noActions(rain);
    // Newest first.
    expect(await list.locator("li").first().textContent()).toContain("make it rain");

    gate.release();
    await expect.poll(() => snow.getAttribute("data-state"), { timeout: 10_000 }).toBe("landed");
    await expect.poll(() => rain.getAttribute("data-state"), { timeout: 10_000 }).toBe("rejected");
    expect(await rain.locator(".outcome").textContent()).toBe("Claude gave up");
    await noActions(rain);
    expect(await snow.count()).toBe(1);
    expect(await rain.count()).toBe(1);
    expect(await list.locator("li").count()).toBe(2);

    // Still there, unchanged, for a Console opened later.
    await page.reload();
    await expect.poll(() => rain.locator(".outcome").textContent(), { timeout: 10_000 }).toBe("Claude gave up");
    expect(await list.locator("li").count()).toBe(2);
  });

  it("shows a Run resolving and restarted in the same entry", async () => {
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
    const run = page.getByTestId("prompts").locator("li", { hasText: "break the page" });
    await expect.poll(() => run.locator(".state").textContent(), { timeout: 10_000 }).toMatch(/resolving/i);
    resolving.release();
    await expect.poll(() => run.locator(".state").textContent(), { timeout: 10_000 }).toMatch(/restarted/i);
    restarted.release();
    await expect.poll(() => run.locator(".state").textContent(), { timeout: 10_000 }).toMatch(/landed/i);
    expect(await page.getByTestId("prompts").locator("li").count()).toBe(1);
  });

  it("replays a Landed change after a confirmation, with the picked model, and credits the replayer", async () => {
    const { page, platform, agent } = await join(await open());
    agent.enqueue((run) => run.writeFile("index.html", "<h1>Snowing</h1>"));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    const original = page.getByTestId("prompts").locator("li", { hasText: "make it snow" });
    await expect.poll(() => original.count(), { timeout: 10_000 }).toBe(1);

    await original.getByRole("button", { name: "Replay", exact: true }).click();
    expect(await original.getByRole("button", { name: "Yes, replay" }).isVisible()).toBe(true);
    await original.getByRole("button", { name: "Cancel" }).click();
    expect(await original.getByRole("button", { name: "Yes, replay" }).count()).toBe(0);
    expect(agent.tasks).toHaveLength(1);

    agent.enqueue((run) => run.writeFile("index.html", "<h1>Snowing again</h1>"));
    await original.getByRole("button", { name: "Replay", exact: true }).click();
    await original.getByLabel("Replay model").selectOption("claude-opus-5-5");
    await original.getByRole("button", { name: "Yes, replay" }).click();

    const entry = page.getByTestId("prompts").locator("li").first();
    await expect.poll(() => entry.textContent(), { timeout: 10_000 }).toContain("↻ Alice");
    await expect.poll(() => entry.getAttribute("data-state"), { timeout: 10_000 }).toBe("landed");
    expect(await entry.textContent()).toContain("↻ Alice replayed Bob's");
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
    await expect.poll(() => page.getByTestId("prompts").locator("li[data-state=waiting]").textContent()).toContain("second");
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
