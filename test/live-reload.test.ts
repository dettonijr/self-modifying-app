import { execFileSync } from "node:child_process";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

const PLATFORM_SCRIPT = '<script src="/__platform/platform.js"></script>';

describe("Live reload: the Canvas server's side", () => {
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function start() {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent });
    platforms.push(platform);
    return { platform, agent };
  }

  it("injects the platform script into served HTML, even after a Run rewrites the Canvas's pages", async () => {
    const { platform, agent } = await start();
    expect(await (await platform.fetchCanvas("/")).text()).toContain(PLATFORM_SCRIPT);

    agent.enqueue(async (run) => {
      await run.writeFile("index.html", "<h1>No head, no script</h1>");
      await run.writeFile("features/about/index.html", "<!doctype html><html><head><title>About</title></head><body>About</body></html>");
    });
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "strip the page" })).id);

    const entry = await (await platform.fetchCanvas("/")).text();
    expect(entry).toContain(PLATFORM_SCRIPT);
    expect(entry).toContain("<h1>No head, no script</h1>");
    const about = await (await platform.fetchCanvas("/features/about/")).text();
    expect(about.startsWith("<!doctype html>")).toBe(true);
    expect(about).toContain(PLATFORM_SCRIPT);

    const script = await platform.fetchCanvas("/__platform/platform.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toMatch(/javascript/);
  });

  it("can't be shadowed by a Canvas file at the platform's path", async () => {
    const { platform, agent } = await start();
    const original = await (await platform.fetchCanvas("/__platform/platform.js")).text();
    agent.enqueue((run) => run.writeFile("__platform/platform.js", "// hijacked"));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Mallory", prompt: "replace the platform" })).id);
    expect(await (await platform.fetchCanvas("/__platform/platform.js")).text()).toBe(original);
  });
});

describe("Live reload: commit-pinned asset URLs", () => {
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

  it("loads a page's files from URLs that carry the commit it was served from", async () => {
    const platform = await startTestPlatform();
    platforms.push(platform);
    const commit = mainCommit(platform);
    const page = await browser.newPage();
    const requested: string[] = [];
    page.on("request", (request) => requested.push(new URL(request.url()).pathname));
    await page.goto(platform.canvasUrl + "/");
    await page.getByRole("button", { name: "Wave" }).waitFor();

    expect(requested).toContain(`/@${commit}/theme.css`);
    expect(requested).toContain(`/@${commit}/features/hello/hello.js`);
    await page.close();
  });

  it("keeps serving a commit's files at its URL after main moves on, marked as never changing", async () => {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent });
    platforms.push(platform);
    const before = mainCommit(platform);
    const original = await (await platform.fetchCanvas("/features/hello/hello.js")).text();

    agent.enqueue((run) => run.writeFile("features/hello/hello.js", "// changed"));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "change hello" })).id);
    const after = mainCommit(platform);

    const old = await platform.fetchCanvas(`/@${before}/features/hello/hello.js`);
    expect(await old.text()).toBe(original);
    expect(old.headers.get("cache-control")).toMatch(/immutable/);
    expect(await (await platform.fetchCanvas(`/@${after}/features/hello/hello.js`)).text()).toBe("// changed");
    expect((await platform.fetchCanvas(`/@${"0".repeat(40)}/theme.css`)).status).toBe(404);
    expect((await platform.fetchCanvas(`/@main/theme.css`)).status).toBe(404);
  });

  it("sends a page's live URL to the URL of the commit main points to", async () => {
    const platform = await startTestPlatform();
    platforms.push(platform);
    const commit = mainCommit(platform);
    for (const [live, pinned] of [
      ["/", `/@${commit}/`],
      ["/index.html?x=1", `/@${commit}/index.html?x=1`],
    ]) {
      const response = await platform.fetchCanvas(live, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(pinned);
    }
    expect((await platform.fetchCanvas("/missing.html", { redirect: "manual" })).status).toBe(404);
  });
});

describe("Live reload: what viewers see", () => {
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
  async function start() {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent });
    platforms.push(platform);
    return { platform, agent };
  }
  async function view(platform: TestPlatform) {
    const page = await browser.newPage();
    await page.goto(platform.canvasUrl + "/");
    await page.getByRole("button", { name: "Wave" }).waitFor();
    return page;
  }

  it("shows every viewer a banner while a Run is in progress, and removes it when the Run is rejected", async () => {
    const { platform, agent } = await start();
    const [first, second] = [await view(platform), await view(platform)];
    const gate = new Gate();
    agent.enqueue(async () => {
      await gate.wait();
      throw new Error("Claude gave up");
    });

    const run = await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" });
    for (const page of [first, second]) {
      await page.getByText("Alice is changing the page…").waitFor();
    }
    const late = await view(platform);
    await late.getByText("Alice is changing the page…").waitFor();

    gate.release();
    await platform.waitForRun(run.id);
    for (const page of [first, second, late]) {
      await page.getByText("Alice is changing the page…").waitFor({ state: "detached" });
    }
  });

  it("reloads every viewer when a change Lands, onto the new commit's files, with a notice crediting the Player", async () => {
    const { platform, agent } = await start();
    const [first, second] = [await view(platform), await view(platform)];
    agent.enqueue((run) =>
      run.writeFile("features/hello/hello.js", 'document.getElementById("hello").append(Object.assign(document.createElement("p"), { textContent: "It is snowing" }));'),
    );

    const run = await platform.sendPrompt({ nickname: "Alice", prompt: "make it snow" });
    await platform.waitForRun(run.id);
    const commit = mainCommit(platform);

    for (const page of [first, second]) {
      await page.getByText("✨ changed by Alice: 'make it snow'").waitFor();
      await page.getByText("It is snowing").waitFor();
      expect(new URL(page.url()).pathname).toBe(`/@${commit}/`);
      expect(await page.getByRole("button", { name: "Wave" }).count()).toBe(0);
      expect(await page.getByText("Alice is changing the page…").count()).toBe(0);
    }
  });

  it("brings a page opened at an older commit up to date", async () => {
    const { platform, agent } = await start();
    const old = mainCommit(platform);
    agent.enqueue((run) => run.writeFile("features/hello/hello.js", 'document.body.append("Fresh");'));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "freshen up" })).id);

    const page = await browser.newPage();
    await page.goto(`${platform.canvasUrl}/@${old}/`);
    await page.getByText("Fresh").waitFor();
    expect(new URL(page.url()).pathname).toBe(`/@${mainCommit(platform)}/`);
  });
});

function mainCommit(platform: TestPlatform): string {
  return execFileSync("git", ["rev-parse", "main"], { cwd: platform.canvasRepoDir, encoding: "utf8" }).trim();
}
