import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform, type TestPlatformOptions } from "./support/harness.ts";

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const PLATFORM_PAGES = ["src/console-page.html", "src/run-page.html", "src/console-shared.js", "src/canvas-platform-script.js"];
// Tokyo Night (Night): background and text.
const NIGHT_TEXT = "rgb(192, 202, 245)";
const SWAPPED_TEXT = "rgb(255, 0, 0)";
const PHONES = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
];

describe("Look and feel", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  const platforms: TestPlatform[] = [];
  // Runs held in progress; released before closing, even when a test fails.
  const gates: Gate[] = [];
  const held = () => {
    const gate = new Gate();
    gates.push(gate);
    return gate;
  };
  afterEach(async () => {
    for (const gate of gates.splice(0)) gate.release();
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function start(options: TestPlatformOptions = {}) {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent, maxParallelRuns: 1, ...options });
    platforms.push(platform);
    return { platform, agent };
  }
  async function newPage(platform: TestPlatform, viewport = { width: 1280, height: 800 }) {
    const context = await browser.newContext({ viewport });
    await context.addCookies([{ name: "nickname", value: "Alice", url: platform.consoleUrl }]);
    return context.newPage();
  }

  /** A Landed Run with a diff and long log lines (thinking, a tool call and a message), a rejected one, and one held in progress until the test ends. */
  async function playSomeRuns(platform: TestPlatform, agent: FakeAgent) {
    agent.enqueue(async (run) => {
      run.thinking("The Player wants snow over the whole page.\nA new feature folder fits, with a-very-long-unbroken-thought-" + "y".repeat(120));
      run.tool("Grep 'snow' in features/" + "deeply/nested/".repeat(10));
      run.message("I'll add a snowfall feature with a very-long-unbroken-word-" + "x".repeat(120));
      await run.writeFile("features/snow/snow.js", `// ${"a-very-long-line-of-code-".repeat(12)}\nconsole.log("snow");\n`);
    });
    const landed = await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "Make it snow over the whole page " + "and-then-some-".repeat(10) })).id);
    agent.enqueue(() => {
      throw new Error("Claude gave up");
    });
    const rejected = await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "Break everything" })).id);
    const gate = held();
    agent.enqueue(() => gate.wait());
    const running = await platform.sendPrompt({ nickname: "Carol", prompt: "Add a cat" });
    await agent.started(3);
    return { landed, rejected, running };
  }

  async function viewCanvasWithBanner(page: Page, platform: TestPlatform) {
    await page.goto(platform.canvasUrl + "/");
    await page.getByText("Carol is changing the page…").waitFor();
  }

  const banner = (page: Page) => page.locator("platform-overlay p").first();

  it("takes every platform colour from the palette file, which holds Tokyo Night (Night)", () => {
    const palette = source("src/palette.css");
    expect(palette).toMatch(/--color-background:\s*#1a1b26;/i);
    expect(palette).toMatch(/--color-text:\s*#c0caf5;/i);
    expect(palette).toMatch(/--color-accent:\s*#7aa2f7;/i);
    for (const file of PLATFORM_PAGES) {
      expect(source(file), file).not.toMatch(/#[0-9a-f]{3,8}\b|\b(rgb|rgba|hsl|hsla)\(/i);
    }
  });

  it("changes every platform page when one palette variable changes", async () => {
    const { platform, agent } = await start();
    const { landed } = await playSomeRuns(platform, agent);
    const page = await newPage(platform);
    await page.context().route("**/palette.css", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(/--color-text:[^;]+;/, "--color-text: #ff0000;") });
    });

    await page.goto(platform.consoleUrl + "/");
    await page.locator("#prompts li").first().waitFor();
    expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(SWAPPED_TEXT);

    await page.goto(platform.consoleUrl + `/runs/${landed.id}`);
    await page.getByTestId("run").waitFor();
    expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(SWAPPED_TEXT);

    await viewCanvasWithBanner(page, platform);
    await expect.poll(() => banner(page).evaluate((element) => getComputedStyle(element).color)).toBe(SWAPPED_TEXT);
  });

  it("keeps the Canvas banner's look whatever the Canvas's CSS says", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) =>
      run.writeFile(
        "theme.css",
        "* , p, platform-overlay { color: #ff0000 !important; background: #00ff00 !important; font-size: 3px !important; --color-text: #ff0000; --color-surface: #00ff00; }",
      ),
    );
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Mallory", prompt: "restyle everything" })).id);
    const gate = held();
    agent.enqueue(() => gate.wait());
    await platform.sendPrompt({ nickname: "Carol", prompt: "Add a cat" });
    const page = await newPage(platform);
    await viewCanvasWithBanner(page, platform);

    const style = await banner(page).evaluate((element) => {
      const { color, backgroundColor, fontSize } = getComputedStyle(element);
      return { color, backgroundColor, fontSize };
    });
    expect(style.color).toBe(NIGHT_TEXT);
    expect(style.backgroundColor).not.toBe("rgb(0, 255, 0)");
    expect(parseFloat(style.fontSize)).toBeGreaterThanOrEqual(14);
  });

  it("gives buttons large, AA-contrast text, an obvious disabled state, and a distinct look to destructive confirmations", async () => {
    const { platform, agent } = await start();
    const { landed } = await playSomeRuns(platform, agent);
    const page = await newPage(platform);
    await page.goto(platform.consoleUrl + "/");
    const entry = page.locator(`#prompts li[data-run="${landed.id}"]`);
    await entry.getByRole("button", { name: "Roll back", exact: true }).click();

    for (const button of await page.locator("button:visible").all()) {
      const look = await button.evaluate(buttonLook);
      const name = await button.textContent();
      expect(contrast(look.color, look.background), `${name}: ${look.color} on ${look.background}`).toBeGreaterThanOrEqual(4.5);
      expect(look.fontSize, `${name} font size`).toBeGreaterThanOrEqual(16);
    }

    const rollback = await entry.getByRole("button", { name: "Yes, roll back" }).evaluate(buttonLook);
    const send = await page.getByRole("button", { name: "Send" }).evaluate(buttonLook);
    const keep = await entry.getByRole("button", { name: "Keep it" }).evaluate(buttonLook);
    expect(rollback.background).not.toBe(send.background);
    expect(rollback.background).not.toBe(keep.background);

    await page.goto(platform.consoleUrl + `/runs/${landed.id}`);
    const thinking = page.locator('li[data-source="thinking"] summary');
    await thinking.waitFor();
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    for (const target of [...(await page.locator(".filters button").all()), thinking]) {
      const look = await target.evaluate(effectiveLook);
      const name = await target.textContent();
      expect(contrast(look.color, look.background), `${name}: ${look.color} on ${look.background}`).toBeGreaterThanOrEqual(4.5);
    }
    const on = await page.getByRole("button", { name: "Claude", exact: true }).evaluate(effectiveLook);
    const off = await page.getByRole("button", { name: "Tools", exact: true }).evaluate(effectiveLook);
    expect(on.background).not.toBe(off.background);
    await page.goto(platform.consoleUrl + "/");

    // Disabled: nothing in the Console disables Send any more, so disable it here to check the style.
    const disabledSend = page.getByRole("button", { name: "Send" });
    await disabledSend.evaluate((button: HTMLButtonElement) => (button.disabled = true));
    const disabled = await disabledSend.evaluate(buttonLook);
    expect(disabled.background).not.toBe(send.background);
    expect(disabled.color).not.toBe(send.color);
    expect(disabled.cursor).toBe("not-allowed");
  });

  for (const viewport of PHONES) {
    it(`fits every page on a ${viewport.width}×${viewport.height} phone without sideways scrolling, with 44×44px tap targets`, async () => {
      const { platform, agent } = await start();
      const { landed } = await playSomeRuns(platform, agent);
      const page = await newPage(platform, viewport);

      await page.goto(platform.consoleUrl + "/");
      const entry = page.locator(`#prompts li[data-run="${landed.id}"]`);
      await entry.getByRole("button", { name: "Replay", exact: true }).click();
      await expectFitsPhone(page, "Console with a Replay confirmation");
      await entry.getByRole("button", { name: "Cancel" }).click();
      await entry.getByRole("button", { name: "Roll back", exact: true }).click();
      await expectFitsPhone(page, "Console with a Rollback confirmation");

      await page.goto(platform.consoleUrl + `/runs/${landed.id}`);
      await page.locator(".file summary").first().click();
      await page.locator("pre.diff").first().waitFor();
      await page.locator('li[data-source="thinking"] summary').click();
      await expectFitsPhone(page, "Run page");

      await viewCanvasWithBanner(page, platform);
      await page.getByRole("button", { name: "Wave" }).waitFor();
      await expectFitsPhone(page, "Canvas");
    });
  }

  for (const viewport of PHONES) {
    it(`gives the older-version banner AA contrast and a 44px-tall link on a ${viewport.width}×${viewport.height} phone`, async () => {
      const { platform, agent } = await start();
      const old = mainCommit(platform);
      agent.enqueue((run) => run.writeFile("features/hello/hello.js", 'document.body.append("Newer");'));
      await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "newer" })).id);
      const page = await newPage(platform, viewport);
      await page.goto(`${platform.canvasUrl}/@${old}/?version`);
      const banner = page.locator("platform-overlay p.version");
      await banner.getByText("Older version: view only").waitFor();
      await expect.poll(() => banner.evaluate((element) => getComputedStyle(element).color)).toBe(NIGHT_TEXT);

      const text = await banner.evaluate(effectiveLook);
      expect(contrast(text.color, text.background), `banner: ${text.color} on ${text.background}`).toBeGreaterThanOrEqual(4.5);
      const link = banner.getByRole("link", { name: "Go to the live Canvas" });
      const linkLook = await link.evaluate(effectiveLook);
      expect(contrast(linkLook.color, linkLook.background), `link: ${linkLook.color} on ${linkLook.background}`).toBeGreaterThanOrEqual(4.5);
      const box = (await link.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
      const bannerBox = (await banner.boundingBox())!;
      expect(bannerBox.x).toBeGreaterThanOrEqual(0);
      expect(bannerBox.x + bannerBox.width).toBeLessThanOrEqual(viewport.width);
      await expectFitsPhone(page, "Older Canvas version");
    });
  }

  it("gives the starter Canvas its own copy of the Tokyo Night colours", () => {
    const theme = source("starter-canvas/theme.css");
    expect(theme).toMatch(/--color-background:\s*#1a1b26;/i);
    expect(theme).toMatch(/--color-text:\s*#c0caf5;/i);
    expect(theme).not.toMatch(/palette|@import|__platform/);
    expect(source("starter-canvas/index.html")).not.toMatch(/palette|__platform/);
  });
});

function mainCommit(platform: TestPlatform): string {
  return execFileSync("git", ["rev-parse", "main"], { cwd: platform.canvasRepoDir, encoding: "utf8" }).trim();
}

async function expectFitsPhone(page: Page, what: string) {
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(width.scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width.viewport);
  for (const target of await page.locator("button:visible, select:visible, summary:visible").all()) {
    const box = await target.boundingBox();
    const name = (await target.textContent())?.trim() || (await target.getAttribute("aria-label"));
    expect(box!.width, `${what}: ${name} width`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `${what}: ${name} height`).toBeGreaterThanOrEqual(44);
  }
}

function buttonLook(element: Element) {
  const style = getComputedStyle(element);
  return { color: style.color, background: style.backgroundColor, fontSize: parseFloat(style.fontSize), cursor: style.cursor };
}

/** Text colour and the colour behind it: the nearest ancestor-or-self background that isn't transparent. */
function effectiveLook(element: Element) {
  const color = getComputedStyle(element).color;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const background = getComputedStyle(current).backgroundColor;
    if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") return { color, background };
  }
  return { color, background: "rgb(255, 255, 255)" };
}

/** WCAG contrast ratio between two opaque `rgb(…)` colours. */
function contrast(a: string, b: string): number {
  const luminance = (color: string) => {
    const [r, g, bl] = color.match(/[\d.]+/g)!.slice(0, 3).map((value) => {
      const c = Number(value) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}
