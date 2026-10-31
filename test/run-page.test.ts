import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
    expect(await details.locator("time").getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);

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

  it("updates live while the Run is in progress, and says when there's no log recorded", async () => {
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
    expect(await page.getByTestId("log").textContent()).toContain("No log recorded");
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

  it("shows the files being edited while the Run is in progress, live, and still after a reload", async () => {
    const { platform, agent } = await start();
    const editing = new Gate();
    const done = new Gate();
    agent.enqueue(async (run) => {
      await run.writeFile("features/snow/snow.js", "snow");
      await editing.wait();
      await run.writeFile("features/snow/snow.css", "body {}");
      await done.wait();
    });
    const { id } = await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" });
    await agent.started(1);
    const page = await newPage(platform);
    await page.goto(`${platform.consoleUrl}/runs/${id}`);
    const files = page.getByTestId("files");
    const names = () => files.locator(".file .path").allTextContents();
    await expect.poll(names, { timeout: 10_000 }).toEqual(["features/snow/snow.js"]);

    editing.release();
    await expect.poll(names, { timeout: 10_000 }).toEqual(["features/snow/snow.js", "features/snow/snow.css"]);
    expect(await files.locator(".diff").count()).toBe(0);
    await page.reload();
    await expect.poll(names, { timeout: 10_000 }).toEqual(["features/snow/snow.js", "features/snow/snow.css"]);

    // Once it Lands, the open page shows the final change.
    done.release();
    await expect.poll(() => files.locator(".file .additions").allTextContents(), { timeout: 10_000 }).toEqual(["+1", "+1"]);
    expect(await names()).toEqual(["features/snow/snow.css", "features/snow/snow.js"]);
  });

  it("lists a Landed Run's files with added and removed counts, each expanding to its diff, and links to the Canvas at that version", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("features/snow/snow.js", "one\ntwo\n"));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    agent.enqueue(async (run) => {
      await run.writeFile("features/snow/snow.js", "one\n2\nthree\n");
      await run.writeFile("features/snow/snow.css", "body {}\n");
    });
    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "more snow" })).id);
    const page = await newPage(platform);
    await page.goto(`${platform.consoleUrl}/runs/${run.id}`);

    const files = page.getByTestId("files").locator(".file");
    await expect.poll(() => files.locator(".path").allTextContents(), { timeout: 10_000 }).toEqual(["features/snow/snow.css", "features/snow/snow.js"]);
    const snow = files.nth(1);
    expect(await snow.locator(".additions").textContent()).toBe("+2");
    expect(await snow.locator(".removals").textContent()).toBe("−1");
    const diff = snow.locator(".diff");
    expect(await diff.isVisible()).toBe(false);
    await snow.locator(".path").click();
    expect(await diff.isVisible()).toBe(true);
    expect(await diff.locator(".line.added").allTextContents()).toEqual(["+2", "+three"]);
    expect(await diff.locator(".line.removed").allTextContents()).toEqual(["-two"]);

    const link = page.getByRole("link", { name: "View the Canvas at this version" });
    expect(await link.getAttribute("href")).toBe(`${platform.canvasUrl}/@${run.commit}/`);
    await link.click();
    await page.waitForURL(`${platform.canvasUrl}/@${run.commit}/`);
  });

  it("has no Canvas link while a Run isn't Landed", async () => {
    const { platform, agent } = await start();
    agent.enqueue(() => {
      throw new Error("Claude gave up");
    });
    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "make it snow" })).id);
    const page = await newPage(platform);
    await page.goto(`${platform.consoleUrl}/runs/${run.id}`);
    await expect.poll(() => page.getByTestId("run").getAttribute("data-state"), { timeout: 10_000 }).toBe("rejected");
    expect(await page.getByRole("link", { name: "View the Canvas at this version" }).count()).toBe(0);
  });
});
