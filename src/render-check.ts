import { chromium, type Browser } from "playwright";
import type { CanvasRepository } from "./canvas-repository.ts";
import { createCanvasServer } from "./canvas-server.ts";
import { close, listen } from "./http.ts";

export type RenderResult = { rendered: true } | { rendered: false; problem: string };

/** How long the page gets to load before it's checked as it stands. */
const LOAD_TIMEOUT_MS = 10_000;

/**
 * Loads a candidate Canvas commit in headless Chromium and checks that it
 * renders: the entry page loads, its own scripts don't throw (a fatal error)
 * and the page isn't blank. It deliberately doesn't test individual features:
 * an error thrown by a feature's own files breaks only that feature, so it
 * doesn't count. Chromium starts on the first check and is reused until `close`.
 */
export class RenderCheck {
  private readonly repo: CanvasRepository;
  private browser: Promise<Browser> | undefined;

  constructor(repo: CanvasRepository) {
    this.repo = repo;
  }

  async check(commit: string): Promise<RenderResult> {
    // A private Canvas server for this one commit, on a random loopback port.
    const server = createCanvasServer(this.repo, async () => commit);
    const port = await listen(server, 0, "127.0.0.1");
    const context = await (await this.launch()).newContext();
    try {
      const page = await context.newPage();
      const entryPage = `http://127.0.0.1:${port}/`;
      const fatalErrors: string[] = [];
      await page.exposeFunction(REPORT_ERROR, (file: string, message: string) => {
        if (isEntryPage(file, entryPage)) fatalErrors.push(message);
      });
      await page.addInitScript(`window.addEventListener("error", (e) => window.${REPORT_ERROR}(e.filename, e.message));`);
      const response = await page.goto(entryPage, { timeout: LOAD_TIMEOUT_MS }).catch(() => undefined);
      if (response && !response.ok()) return { rendered: false, problem: `The entry page answered ${response.status()}` };
      const blank = await page.evaluate<boolean>(IS_BLANK);
      // Checked after a round trip to the page, so every error reported during the load has arrived.
      if (fatalErrors.length > 0) return { rendered: false, problem: `Fatal error: ${fatalErrors[0]}` };
      if (blank) return { rendered: false, problem: "The page is blank" };
      return { rendered: true };
    } finally {
      await context.close();
      await close(server);
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    await (await browser?.catch(() => undefined))?.close();
  }

  private launch(): Promise<Browser> {
    this.browser ??= chromium.launch();
    return this.browser;
  }
}

/** The page-side hook uncaught errors are reported through. */
const REPORT_ERROR = "__renderCheckReportError";

/** Whether an error's source file is the entry page itself, i.e. one of its inline scripts. */
function isEntryPage(file: string, entryPage: string): boolean {
  try {
    const { origin, pathname } = new URL(file);
    return origin === new URL(entryPage).origin && (pathname === "/" || pathname === "/index.html");
  } catch {
    return false;
  }
}

/**
 * Evaluated in the page (as source, since the platform isn't type-checked
 * against the DOM): blank means no text and no visible element with a size.
 */
const IS_BLANK = `(() => {
  const body = document.body;
  if (!body) return true;
  if (body.innerText.trim() !== "") return false;
  const invisible = ["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"];
  for (const element of body.querySelectorAll("*")) {
    if (invisible.includes(element.tagName)) continue;
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden") return false;
  }
  return true;
})()`;
