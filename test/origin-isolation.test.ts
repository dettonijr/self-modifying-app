import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

describe("Origin isolation", () => {
  let browser: Browser;
  let platform: TestPlatform;
  beforeAll(async () => {
    [browser, platform] = await Promise.all([chromium.launch(), startTestPlatform()]);
  });
  afterAll(async () => {
    await Promise.all([browser?.close(), platform?.close()]);
  });

  it("a Canvas page can't make credentialed calls to the Console origin", async () => {
    const context = await browser.newContext();
    await context.addCookies([{ name: "nickname", value: "Alice", url: platform.consoleUrl }]);
    const page = await context.newPage();
    await page.goto(platform.canvasUrl + "/");

    const outcome = await page.evaluate(async (consoleUrl) => {
      try {
        const response = await fetch(consoleUrl + "/api/health", { credentials: "include" });
        return `read ${response.status}: ${await response.text()}`;
      } catch (error) {
        return `blocked: ${String(error)}`;
      }
    }, platform.consoleUrl);
    expect(outcome).toMatch(/^blocked/);

    // A write the browser sends without reading the response is still refused by the Console.
    const consoleRequests: Array<Promise<number | undefined>> = [];
    page.on("request", (request) => {
      if (request.url().startsWith(platform.consoleUrl)) {
        consoleRequests.push(request.response().then((response) => response?.status()));
      }
    });
    await page.evaluate(async (consoleUrl) => {
      await fetch(consoleUrl + "/api/health", { method: "POST", mode: "no-cors", credentials: "include", body: "x" });
    }, platform.consoleUrl);
    expect(await Promise.all(consoleRequests)).toEqual([403]);

    await context.close();
  });

  it("a Canvas page can't read or change a Console page it embeds", async () => {
    const page = await browser.newPage();
    await page.goto(platform.canvasUrl + "/");
    const outcome = await page.evaluate(async (consoleUrl) => {
      const frame = document.createElement("iframe");
      frame.src = consoleUrl + "/";
      await new Promise((resolve) => {
        frame.onload = resolve;
        document.body.append(frame);
      });
      try {
        return frame.contentDocument === null ? "blocked" : `read: ${frame.contentDocument.title}`;
      } catch (error) {
        return `blocked: ${String(error)}`;
      }
    }, platform.consoleUrl);
    expect(outcome).toMatch(/^blocked/);
    await page.close();
  });
});
