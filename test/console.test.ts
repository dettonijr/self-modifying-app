import { afterEach, describe, expect, it } from "vitest";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

describe("Console server", () => {
  let platform: TestPlatform | undefined;
  afterEach(async () => {
    await platform?.close();
    platform = undefined;
  });

  it("serves the Console page", async () => {
    platform = await startTestPlatform();
    const page = await fetch(platform.consoleUrl + "/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Console");
  });

  it("answers its API from its own origin", async () => {
    platform = await startTestPlatform();
    const response = await platform.consoleApi("/api/health", { headers: { origin: platform.consoleUrl } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("has no history endpoint: the Prompts list is /api/runs", async () => {
    platform = await startTestPlatform();
    expect((await platform.consoleApi("/api/history")).status).toBe(404);
    expect((await platform.consoleApi("/api/runs")).status).toBe(200);
  });

  it("has no Rollback endpoint or Roll back button", async () => {
    platform = await startTestPlatform();
    const response = await platform.consoleApi("/api/rollbacks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "nickname=Alice" },
      body: JSON.stringify({ commit: "HEAD" }),
    });
    expect(response.status).toBe(404);
    const shared = await (await fetch(platform.consoleUrl + "/console-shared.js")).text();
    expect(shared).not.toMatch(/roll ?back/i);
  });

  it("refuses API calls made from the Canvas origin", async () => {
    platform = await startTestPlatform();
    const response = await platform.consoleApi("/api/health", {
      method: "POST",
      headers: { origin: platform.canvasUrl, cookie: "nickname=Mallory" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();

    const read = await platform.consoleApi("/api/health", { headers: { origin: platform.canvasUrl } });
    expect(read.status).toBe(403);
  });
});
