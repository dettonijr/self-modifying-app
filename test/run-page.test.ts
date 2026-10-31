import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform, type TestPlatformOptions } from "./support/harness.ts";

describe("The Run page", () => {
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
  async function start(options: TestPlatformOptions = {}): Promise<{ platform: TestPlatform; agent: FakeAgent }> {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent, maxParallelRuns: 1, ...options });
    platforms.push(platform);
    return { platform, agent };
  }
  async function newPage(platform: TestPlatform, nickname?: string): Promise<Page> {
    const context = await browser.newContext();
    if (nickname) await context.addCookies([{ name: "nickname", value: nickname, url: platform.consoleUrl }]);
    return context.newPage();
  }

  it("opens directly from its URL, shows the Run's details and links back to the Prompts list", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "snow"));
    const long = "make it snow " + "and then some more ".repeat(10).trim();
    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: long, model: "claude-opus-5-5" })).id);

    const page = await newPage(platform);
    const response = await page.goto(`${platform.consoleUrl}/runs/${run.id}`);
    expect(response?.status()).toBe(200);
    const details = page.getByTestId("run");
    await expect.poll(() => details.getAttribute("data-state"), { timeout: 10_000 }).toBe("landed");
    expect(await details.locator(".state").textContent()).toMatch(/landed/i);
    expect(await details.locator(".nickname").first().textContent()).toBe("Bob");
    expect(await details.locator(".prompt").textContent()).toBe(long);
    expect(await details.locator(".model").textContent()).toBe("Opus 5.5");
    expect(await details.locator(".outcome").textContent()).toBe("Landed");
    expect(await details.locator(".details time").getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await page.getByRole("link", { name: "← Prompts" }).click();
    await page.waitForURL(platform.consoleUrl + "/");
    await page.getByTestId("prompts").locator("li").first().waitFor();
  });

  it("opens from a click anywhere on a Prompts list entry except its buttons", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "snow"));
    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    const page = await newPage(platform, "Alice");
    await page.goto(platform.consoleUrl + "/");
    const entry = page.getByTestId("prompts").locator("li", { hasText: "make it snow" });
    await entry.waitFor();

    await entry.getByRole("button", { name: "Replay", exact: true }).click();
    await entry.getByRole("button", { name: "Cancel" }).click();
    await entry.getByRole("button", { name: "Roll back", exact: true }).click();
    await entry.getByRole("button", { name: "Keep it" }).click();
    expect(new URL(page.url()).pathname).toBe("/");

    await entry.locator(".details").click();
    await page.waitForURL(`${platform.consoleUrl}/runs/${run.id}`);
    await expect.poll(() => page.getByTestId("run").getAttribute("data-state"), { timeout: 10_000 }).toBe("landed");
  });

  it("updates live while the Run is in progress, and its log ends with the rejection reason", async () => {
    const { platform, agent } = await start();
    const gate = new Gate();
    agent.enqueue(
      async (run) => {
        await gate.wait();
        await run.writeFile("features/snow/snow.js", "snow");
      },
      () => {
        throw new Error("Claude gave up");
      },
    );
    await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" });
    await agent.started(1);
    const waiting = await platform.sendPrompt({ nickname: "Carol", prompt: "make it rain" });

    const page = await newPage(platform);
    await page.goto(`${platform.consoleUrl}/runs/${waiting.id}`);
    const details = page.getByTestId("run");
    await expect.poll(() => details.getAttribute("data-state"), { timeout: 10_000 }).toBe("waiting");
    expect(await details.locator(".outcome").count()).toBe(0);

    gate.release();
    await expect.poll(() => details.locator(".outcome").textContent(), { timeout: 10_000 }).toBe("Claude gave up");
    expect(await details.getAttribute("data-state")).toBe("rejected");
    expect(await details.locator(".state").textContent()).toMatch(/rejected/i);
    for (const name of ["Replay", "Roll back"]) expect(await page.getByRole("button", { name, exact: true }).count()).toBe(0);
    await expect.poll(() => page.getByTestId("log").locator("li").last().textContent(), { timeout: 10_000 }).toContain("Rejected: Claude gave up");
  });

  it("shows the log of what Claude said and what the platform did, timestamped and appended live", async () => {
    const { platform, agent } = await start();
    const gate = new Gate();
    agent.enqueue(async (run) => {
      run.message("I'll add some snow.");
      await gate.wait();
      await run.writeFile("features/snow/snow.js", "snow");
      run.message("Done: it snows now.");
    });
    const run = await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" });
    await agent.started(1);

    const page = await newPage(platform);
    await page.goto(`${platform.consoleUrl}/runs/${run.id}`);
    const entries = page.getByTestId("log").locator("li");
    const shown = async () =>
      entries.evaluateAll((items) => items.map((item) => `${item.getAttribute("data-source")}: ${item.querySelector(".text")?.textContent}`));
    await expect.poll(shown, { timeout: 10_000 }).toEqual(["platform: Queued", "platform: Started", "claude: I'll add some snow."]);

    gate.release();
    await expect.poll(shown, { timeout: 10_000 }).toEqual([
      "platform: Queued",
      "platform: Started",
      "claude: I'll add some snow.",
      "claude: Done: it snows now.",
      "platform: Rebasing onto the latest Canvas",
      "platform: Checking that the Canvas renders",
      "platform: Landed",
    ]);
    for (const time of await entries.locator("time").all()) {
      expect(await time.getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect((await time.textContent())?.trim()).not.toBe("");
    }
    expect(await page.getByTestId("log").textContent()).not.toContain("No log recorded");
  });

  it("says \"No log recorded\" for a Landed change from before Runs were saved", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "sma-run-page-"));
    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
    const seeded = await start({ dataDir });
    await seeded.platform.close();
    platforms.splice(platforms.indexOf(seeded.platform), 1);
    const canvas = path.join(dataDir, "canvas");
    await writeFile(path.join(canvas, "old.js"), "old");
    const gitIn = (...args: string[]) => execFileSync("git", ["-c", "user.name=Platform", "-c", "user.email=platform@example.com", ...args], { cwd: canvas, encoding: "utf8" }).trim();
    gitIn("add", "old.js");
    gitIn("commit", "--quiet", "-m", "Prompt by Olga: make it old\n\nmake it old\n\nKind: Prompt\nNickname: Olga\nModel: claude-opus-5-5");
    const old = gitIn("rev-parse", "HEAD");

    const { platform } = await start({ dataDir });
    const page = await newPage(platform);
    await page.goto(`${platform.consoleUrl}/runs/${old}`);
    await expect.poll(() => page.getByTestId("log").textContent(), { timeout: 10_000 }).toContain("No log recorded");
  });

  it("replays a Landed Run after a confirmation, and the Replay's page names and links its original", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "snow"));
    const snow = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    const page = await newPage(platform, "Alice");
    await page.goto(`${platform.consoleUrl}/runs/${snow.id}`);

    await page.getByRole("button", { name: "Replay", exact: true }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await page.getByRole("button", { name: "Yes, replay" }).count()).toBe(0);
    expect(agent.tasks).toHaveLength(1);

    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "more snow"));
    await page.getByRole("button", { name: "Replay", exact: true }).click();
    await page.getByLabel("Replay model").selectOption("claude-opus-5-5");
    await page.getByRole("button", { name: "Yes, replay" }).click();
    await page.getByRole("link", { name: "Follow your Replay" }).click();

    const details = page.getByTestId("run");
    await expect.poll(() => details.getAttribute("data-state"), { timeout: 10_000 }).toBe("landed");
    expect(agent.tasks[1].model).toBe("claude-opus-5-5");
    expect(await details.locator(".nickname").first().textContent()).toBe("Alice");
    const original = page.getByRole("link", { name: "Replay of Bob's 'make it snow'" });
    expect(await page.locator("#original").textContent()).toBe("↻ Replay of Bob's 'make it snow'");
    await original.click();
    await page.waitForURL(`${platform.consoleUrl}/runs/${snow.commit}`);
    await expect.poll(() => details.getAttribute("data-run"), { timeout: 10_000 }).toBe(snow.id);
    expect(await details.locator(".prompt").textContent()).toBe("make it snow");
  });

  it("rolls back a Landed Run after a confirmation, and the Rollback's page names its original", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "snow"));
    const snow = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    const page = await newPage(platform, "Alice");
    await page.goto(`${platform.consoleUrl}/runs/${snow.id}`);

    await page.getByRole("button", { name: "Roll back", exact: true }).click();
    expect(await page.getByTestId("run").textContent()).toContain("Roll back Bob's change?");
    await page.getByRole("button", { name: "Keep it" }).click();
    expect(await page.getByRole("button", { name: "Yes, roll back" }).count()).toBe(0);

    await page.getByRole("button", { name: "Roll back", exact: true }).click();
    await page.getByRole("button", { name: "Yes, roll back" }).click();
    await page.getByRole("link", { name: "Follow your Rollback" }).click();
    await expect.poll(() => page.getByTestId("run").getAttribute("data-state"), { timeout: 10_000 }).toBe("landed");
    expect(await page.locator("#original").textContent()).toBe("↩ Rollback of Bob's 'make it snow'");
    expect(await page.getByRole("link", { name: "Rollback of Bob's 'make it snow'" }).getAttribute("href")).toBe(`/runs/${snow.commit}`);
    expect((await platform.fetchCanvas("/features/snow/snow.js")).status).toBe(404);
  });

  it("disables Replay and Roll back while the Console is paused", async () => {
    const { platform, agent } = await start({ spendingCapUsd: 1 });
    agent.enqueue(async (run) => {
      run.usage({ inputTokens: 500_000, outputTokens: 0 }); // $1 on Sonnet 5.5: the cap
      await run.writeFile("features/snow/snow.js", "snow");
    });
    const snow = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    const page = await newPage(platform, "Alice");
    await page.goto(`${platform.consoleUrl}/runs/${snow.id}`);
    await expect.poll(() => page.getByTestId("paused").isVisible(), { timeout: 10_000 }).toBe(true);
    for (const name of ["Replay", "Roll back"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect.poll(() => button.isDisabled(), { timeout: 10_000 }).toBe(true);
    }
  });

  it("shows \"No such Run\" for an unknown id", async () => {
    const { platform } = await start();
    const page = await newPage(platform);
    const response = await page.goto(`${platform.consoleUrl}/runs/no-such-run`);
    expect(response?.status()).toBe(404);
    await page.getByRole("heading", { name: "No such Run" }).waitFor();
    expect(await page.getByTestId("run").isVisible()).toBe(false);
    await page.getByRole("link", { name: "← Prompts" }).click();
    await page.waitForURL(platform.consoleUrl + "/");
  });

  it("can't be fetched or embedded by a Canvas page, but opens from a link on one", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "snow"));
    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    const runUrl = `${platform.consoleUrl}/runs/${run.id}`;
    const page = await newPage(platform);
    await page.goto(platform.canvasUrl + "/");
    const statuses: Array<Promise<number | undefined>> = [];
    page.on("request", (request) => {
      if (request.url() === runUrl) statuses.push(request.response().then((response) => response?.status()));
    });

    await page.evaluate(async (url) => {
      await fetch(url, { mode: "no-cors", credentials: "include" });
      const frame = document.createElement("iframe");
      frame.src = url;
      await new Promise((resolve) => {
        frame.onload = resolve;
        document.body.append(frame);
      });
    }, runUrl);
    expect(await Promise.all(statuses)).toEqual([403, 403]);
    expect((await platform.consoleApi(`/runs/${run.id}`, { headers: { origin: platform.canvasUrl } })).status).toBe(403);

    await page.evaluate((url) => {
      const link = document.createElement("a");
      link.href = url;
      link.textContent = "see my Run";
      document.body.append(link);
    }, runUrl);
    await page.getByRole("link", { name: "see my Run" }).click();
    await page.waitForURL(runUrl);
    await expect.poll(() => page.getByTestId("run").getAttribute("data-state"), { timeout: 10_000 }).toBe("landed");
  });
});
