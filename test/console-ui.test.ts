import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeAgent } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

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
  async function open(agent = new FakeAgent()): Promise<{ page: Page; platform: TestPlatform; agent: FakeAgent }> {
    const platform = await startTestPlatform({ agent });
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
    expect(await (await platform.fetchCanvas("/")).text()).toBe("<h1>Snowing</h1>");
  });

  it("tells the Player why their Prompt didn't Land when the Canvas didn't render", async () => {
    const { page, agent } = await join(await open());
    agent.enqueue((run) => run.writeFile("index.html", "<body></body>"));

    await page.getByLabel("Prompt").fill("blank it");
    await page.getByRole("button", { name: "Send" }).click();

    await expect.poll(() => page.locator("#status").textContent(), { timeout: 10_000 }).toContain("Canvas didn't render");
  });
});

async function join<T extends { page: Page }>(opened: T): Promise<T> {
  await opened.page.getByLabel("Nickname").fill("Alice");
  await opened.page.getByRole("button", { name: "Join" }).click();
  await opened.page.getByTestId("current-nickname").waitFor();
  return opened;
}
