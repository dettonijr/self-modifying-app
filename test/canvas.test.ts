import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

describe("Canvas server", () => {
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function start(...args: Parameters<typeof startTestPlatform>) {
    const platform = await startTestPlatform(...args);
    platforms.push(platform);
    return platform;
  }

  it("serves the starter Canvas on first start", async () => {
    const platform = await start();

    const entry = await platform.fetchCanvas("/");
    expect(entry.status).toBe(200);
    expect(entry.headers.get("content-type")).toMatch(/text\/html/);
    const html = await entry.text();
    expect(html).toContain("<h1");
    expect(html).toContain("features/hello/");

    const feature = await platform.fetchCanvas("/features/hello/hello.js");
    expect(feature.status).toBe(200);
    expect(feature.headers.get("content-type")).toMatch(/javascript/);

    const conventions = await platform.fetchCanvas("/CLAUDE.md");
    const text = await conventions.text();
    for (const rule of ["import map", "no build step", "one folder per feature", "theme variables"]) {
      expect(text.toLowerCase()).toContain(rule);
    }
  });

  it("tells Claude in the starter Canvas conventions that every change must work on phones", async () => {
    const platform = await start();

    const text = (await (await platform.fetchCanvas("/CLAUDE.md")).text()).toLowerCase();
    for (const rule of ["phone", "sideways", "pointer events", "hover", "44", '<meta name="viewport"']) {
      expect(text).toContain(rule);
    }
  });

  it("serves a starter Canvas that fits a 390px-wide phone without scrolling sideways", async () => {
    const platform = await start();
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await page.goto(platform.canvasUrl + "/");
      await page.getByRole("button", { name: "Wave" }).waitFor();

      expect(await page.locator('meta[name="viewport"]').getAttribute("content")).toContain("width=device-width");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    } finally {
      await browser.close();
    }
  });

  it("serves what main points to, ignoring uncommitted changes in the working folder", async () => {
    const platform = await start();
    const entryFile = path.join(platform.canvasRepoDir, "index.html");
    const original = await readFile(entryFile, "utf8");
    const edited = original.replace("The Canvas</h1>", "Uncommitted title</h1>");
    await writeFile(entryFile, edited);

    expect(await (await platform.fetchCanvas("/")).text()).not.toContain("Uncommitted title");

    commitAll(platform.canvasRepoDir, "Change the title");
    expect(await (await platform.fetchCanvas("/")).text()).toContain("Uncommitted title");
  });

  it("reuses the existing Canvas repo on later starts", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "sma-test-"));
    try {
      const first = await startTestPlatform({ dataDir });
      await writeFile(path.join(first.canvasRepoDir, "features", "hello", "hello.js"), "// Landed earlier\n");
      commitAll(first.canvasRepoDir, "A change that Landed");
      await first.close();

      const second = await startTestPlatform({ dataDir });
      try {
        expect(await (await second.fetchCanvas("/features/hello/hello.js")).text()).toBe("// Landed earlier\n");
      } finally {
        await second.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("doesn't serve files that aren't in the Canvas", async () => {
    const platform = await start();
    expect((await platform.fetchCanvas("/missing.html")).status).toBe(404);
    expect((await platform.fetchCanvas("/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await platform.fetchCanvas("/.git/HEAD")).status).toBe(404);
  });

  it("serves only commits on main, never ones that didn't Land", async () => {
    const platform = await start();
    const main = git(platform.canvasRepoDir, ["rev-parse", "main"]);
    // A commit in the object store that isn't on main, as a rejected Run leaves behind.
    const tree = git(platform.canvasRepoDir, ["rev-parse", "main^{tree}"]);
    const unlanded = git(platform.canvasRepoDir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit-tree", tree, "-p", main, "-m", "rejected"]);

    expect((await platform.fetchCanvas(`/@${main}/`)).status).toBe(200);
    expect((await platform.fetchCanvas(`/@${unlanded}/`)).status).toBe(404);
    expect((await platform.fetchCanvas(`/@${unlanded}/features/hello/hello.js`)).status).toBe(404);
  });
});

/** Stands in for a Land until the Lander exists. */
function commitAll(repoDir: string, message: string) {
  execFileSync("git", ["add", "--all"], { cwd: repoDir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", message], { cwd: repoDir });
}

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}
