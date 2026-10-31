import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeAgent, Gate } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

/** A feature that shows a stored note and messages heard, and tries to change both on "Write". */
const NOTES_FEATURE = `
import { channel, store } from "/__platform/services.js";
const root = document.getElementById("notes");
const db = store("notes");
const chat = channel("notes");
const show = (text) => root.append(Object.assign(document.createElement("p"), { textContent: text }));
chat.onMessage((message) => show("heard: " + message));
show("stored: " + (await db.get("note")));
const button = Object.assign(document.createElement("button"), { textContent: "Write" });
button.addEventListener("click", async () => {
  try {
    await db.set("note", "changed");
    await db.set("other", "added");
    await db.delete("note");
    await chat.send("from " + (location.search || "live"));
    show("wrote");
  } catch (error) {
    show("error: " + error.message);
  }
});
root.append(button);
root.dataset.ready = "yes";
`;
const NOTES_PAGE = '<!doctype html><html><head><title>Notes</title></head><body><section id="notes"><script type="module" src="features/notes/notes.js"></script></section></body></html>';

const OLDER_VERSION_BANNER = "Older version: view only · Go to the live Canvas";

describe("Older Canvas versions in the browser", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  const platforms: TestPlatform[] = [];
  const gates: Gate[] = [];
  afterEach(async () => {
    for (const gate of gates.splice(0)) gate.release();
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function start() {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent, maxParallelRuns: 1 });
    platforms.push(platform);
    return { platform, agent };
  }
  async function land(platform: TestPlatform, agent: FakeAgent, text: string) {
    agent.enqueue((run) => run.writeFile("features/hello/hello.js", `document.body.append(${JSON.stringify(text)});`));
    return platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: `say ${text}` })).id);
  }
  /** A normal tab, used as a clock: once it shows `text`, the Land has reached every viewer. */
  async function liveTab(platform: TestPlatform): Promise<Page> {
    const page = await browser.newPage();
    await page.goto(platform.canvasUrl + "/");
    return page;
  }

  it("keeps a pinned view on its version after the platform's hello and after a new Land, without following live banners", async () => {
    const { platform, agent } = await start();
    const old = await land(platform, agent, "Old words");
    await land(platform, agent, "Newer words");

    const pinned = await browser.newPage();
    await pinned.goto(`${platform.canvasUrl}/@${old.commit}/?version`);
    await pinned.getByText("Old words").waitFor();
    await pinned.evaluate(() => ((window as any).__stayed = true));
    const live = await liveTab(platform);
    await live.getByText("Newer words").waitFor();

    const gate = new Gate();
    gates.push(gate);
    agent.enqueue(async (run) => {
      await gate.wait();
      await run.writeFile("features/hello/hello.js", 'document.body.append("Newest words");');
    });
    await platform.sendPrompt({ nickname: "Carol", prompt: "say newest" });
    await live.getByText("Carol is changing the page…").waitFor();
    gate.release();
    await live.getByText("Newest words").waitFor();
    await live.waitForTimeout(500);

    expect(new URL(pinned.url()).pathname).toBe(`/@${old.commit}/`);
    expect(await pinned.evaluate(() => (window as any).__stayed)).toBe(true);
    expect(await pinned.getByText("Old words").count()).toBe(1);
    expect(await pinned.getByText("Carol is changing the page…").count()).toBe(0);
    expect(await pinned.getByText(/changed by/).count()).toBe(0);
  });

  it("shows pinned views a banner whose link goes to the live Canvas, and keeps the marker on links within the version", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("about.html", '<!doctype html><html><head><title>About</title></head><body>About <a href="index.html">Home</a></body></html>'));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "add about" })).id);
    const withAbout = mainCommit(platform);
    await land(platform, agent, "Newer words");

    const page = await browser.newPage();
    await page.goto(`${platform.canvasUrl}/@${withAbout}/about.html?version`);
    await page.getByText(OLDER_VERSION_BANNER).waitFor();
    await page.getByRole("link", { name: "Home" }).click();
    await page.waitForURL(`${platform.canvasUrl}/@${withAbout}/index.html?version`);
    await page.getByText(OLDER_VERSION_BANNER).waitFor();

    await page.getByRole("link", { name: "Go to the live Canvas" }).click();
    await page.waitForURL(`${platform.canvasUrl}/@${mainCommit(platform)}/`);
    await page.getByText("Newer words").waitFor();
    expect(await page.getByText(OLDER_VERSION_BANNER).count()).toBe(0);
  });

  it("shows the banner on a version committed before pinned views existed, whatever that version's CSS says", async () => {
    const { platform, agent } = await start();
    // Committed straight into the Canvas repo: a page from before this change, styled to hide the platform's UI.
    await writeFile(
      path.join(platform.canvasRepoDir, "index.html"),
      `<!doctype html><html><head><title>Old</title><style>
        platform-overlay, p, a { display: none !important; visibility: hidden !important; opacity: 0 !important; color: #00ff00 !important; }
      </style></head><body><h1>Before pinned views</h1></body></html>`,
    );
    const gitIn = (...args: string[]) => execFileSync("git", ["-c", "user.name=Platform", "-c", "user.email=platform@example.com", ...args], { cwd: platform.canvasRepoDir, encoding: "utf8" }).trim();
    gitIn("commit", "--quiet", "-am", "An old page");
    const old = gitIn("rev-parse", "HEAD");
    agent.enqueue((run) => run.writeFile("index.html", "<!doctype html><html><head><title>New</title></head><body>New</body></html>"));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "replace the page" })).id);

    const page = await browser.newPage();
    await page.goto(`${platform.canvasUrl}/@${old}/?version`);
    await page.getByText("Before pinned views").waitFor();
    const banner = page.getByText(OLDER_VERSION_BANNER);
    await banner.waitFor();
    expect(await banner.isVisible()).toBe(true);
    const link = page.getByRole("link", { name: "Go to the live Canvas" });
    expect(await link.isVisible()).toBe(true);
    expect(await link.evaluate((element) => getComputedStyle(element).color)).not.toBe("rgb(0, 255, 0)");
  });

  it("lets a pinned view read live data and hear live messages, while its writes and sends change nothing and throw nothing", async () => {
    const { platform, agent } = await start();
    agent.enqueue(async (run) => {
      await run.writeFile("index.html", NOTES_PAGE);
      await run.writeFile("features/notes/notes.js", NOTES_FEATURE);
    });
    const withNotes = (await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "add notes" })).id)).commit;
    agent.enqueue((run) => run.writeFile("features/notes/extra.txt", "later"));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "later change" })).id);
    await putValue(platform, "/__platform/store/notes/note", "kept");

    const pinned = await browser.newPage();
    await pinned.goto(`${platform.canvasUrl}/@${withNotes}/?version`);
    await pinned.locator("#notes[data-ready=yes]").waitFor();
    await pinned.getByText("stored: kept").waitFor();
    const live = await liveTab(platform);
    await live.locator("#notes[data-ready=yes]").waitFor();

    await pinned.getByRole("button", { name: "Write" }).click();
    await pinned.getByText("wrote").waitFor();
    expect(await (await platform.fetchCanvas("/__platform/store/notes/note")).json()).toEqual({ value: "kept" });
    expect((await platform.fetchCanvas("/__platform/store/notes/other")).status).toBe(404);
    await live.getByRole("button", { name: "Write" }).click();
    await live.getByText("heard: from live").waitFor();
    await pinned.getByText("heard: from live").waitFor();

    expect(await pinned.getByText(/^error/).count()).toBe(0);
    expect(await live.getByText("heard: from ?version").count()).toBe(0);
    expect(await pinned.getByText("heard: from ?version").count()).toBe(0);
  });

  it("doesn't show the banner on the live Canvas", async () => {
    const { platform } = await start();
    const page = await liveTab(platform);
    await page.getByRole("button", { name: "Wave" }).waitFor();
    expect(await page.getByText(OLDER_VERSION_BANNER).count()).toBe(0);
  });
});

describe("Older Canvas versions over HTTP", () => {
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });

  it("refuses store writes, deletes and channel sends from a pinned-version page with 403, and still takes them from the live Canvas", async () => {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent });
    platforms.push(platform);
    const old = mainCommit(platform);
    agent.enqueue((run) => run.writeFile("features/notes/notes.txt", "notes"));
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Bob", prompt: "add notes" })).id);
    const current = mainCommit(platform);
    await putValue(platform, "/__platform/store/notes/note", "kept");

    const from = (pagePath: string) => ({ referer: platform.canvasUrl + pagePath });
    // One after another, so the live Canvas's write and delete of the same key land in order.
    const attempts = async (headers: Record<string, string>) => {
      const responses: Response[] = [];
      for (const attempt of [
        () => platform.fetchCanvas("/__platform/store/notes/note", { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ value: "changed" }) }),
        () => platform.fetchCanvas("/__platform/store/notes/other", { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ value: "added" }) }),
        () => platform.fetchCanvas("/__platform/store/notes/note", { method: "DELETE", headers }),
        () => platform.fetchCanvas("/__platform/channel/notes", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) }),
      ]) {
        responses.push(await attempt());
      }
      return responses;
    };
    for (const pagePath of [`/@${old}/?version`, `/@${old}/`, `/@${old}/features/notes/page.html`, `/@${current}/?version`, `/@${current}/about.html?x=1&version`]) {
      const responses = await attempts(from(pagePath));
      expect(responses.map((response) => response.status), pagePath).toEqual([403, 403, 403, 403]);
      expect(await (await platform.fetchCanvas("/__platform/store/notes/note")).json()).toEqual({ value: "kept" });
      expect((await platform.fetchCanvas("/__platform/store/notes/other")).status).toBe(404);
    }

    const reads = await Promise.all([platform.fetchCanvas("/__platform/store/notes/note", { headers: from(`/@${old}/?version`) }), platform.fetchCanvas("/__platform/store/notes/?prefix=", { headers: from(`/@${old}/?version`) })]);
    expect(reads.map((response) => response.status)).toEqual([200, 200]);

    const live = await attempts(from(`/@${current}/`));
    expect(live.map((response) => response.status)).toEqual([204, 204, 204, 204]);
    expect((await platform.fetchCanvas("/__platform/store/notes/note")).status).toBe(404);
    expect(await (await platform.fetchCanvas("/__platform/store/notes/other")).json()).toEqual({ value: "added" });
  });

  it("still lets the render check's candidate write to its private store", async () => {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent });
    platforms.push(platform);
    agent.enqueue((run) =>
      run.writeFile(
        "index.html",
        `<!doctype html><html><head><title>Saved</title></head><body><script type="module">
          import { store } from "/__platform/services.js";
          const db = store("saved");
          await db.set("word", "Saved");
          document.body.append(await db.get("word"));
        </script></body></html>`,
      ),
    );
    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "save a word" })).id);
    expect(run.state).toBe("landed");
    expect((await platform.fetchCanvas("/__platform/store/saved/word")).status).toBe(404);
  });
});

function putValue(platform: TestPlatform, storePath: string, value: unknown) {
  return platform.fetchCanvas(storePath, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
}

function mainCommit(platform: TestPlatform): string {
  return execFileSync("git", ["rev-parse", "main"], { cwd: platform.canvasRepoDir, encoding: "utf8" }).trim();
}
