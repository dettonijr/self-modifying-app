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
