import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { FakeAgent } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

/** A Canvas feature that relays chat lines over the real-time channel, written the way the Canvas CLAUDE.md says. */
const CHAT_FEATURE = `
import { channel } from "/__platform/services.js";
const root = document.getElementById("chat");
const chat = channel("chat");
chat.onMessage((message) => root.append(Object.assign(document.createElement("p"), { textContent: "says: " + message.text })));
const button = Object.assign(document.createElement("button"), { textContent: "Send hi" });
button.addEventListener("click", () => chat.send({ text: "hi from " + location.hash }));
root.append(button);
root.dataset.ready = "yes";
`;

/** A counter feature kept in the key-value store under the key "count"; two copies use the same key. */
function counterFeature(name: string): string {
  return `
import { store } from "/__platform/services.js";
const root = document.getElementById("${name}");
const db = store("${name}");
const output = Object.assign(document.createElement("output"), { value: "${name}: " + ((await db.get("count")) ?? 0) });
const button = Object.assign(document.createElement("button"), { textContent: "Count ${name}" });
button.addEventListener("click", async () => {
  const count = ((await db.get("count")) ?? 0) + 1;
  await db.set("count", count);
  output.value = "${name}: " + count;
});
root.append(button, output);
root.dataset.ready = "yes";
`;
}

function withFeature(...names: string[]): string {
  return `<!doctype html><html><head><title>Canvas</title></head><body>
${names.map((name) => `<section id="${name}"><script type="module" src="features/${name}/${name}.js"></script></section>`).join("\n")}
</body></html>`;
}

describe("Platform services in the browser", () => {
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
  async function start(files: Record<string, string>) {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent });
    platforms.push(platform);
    agent.enqueue(async (run) => {
      for (const [file, contents] of Object.entries(files)) await run.writeFile(file, contents);
    });
    await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "add the feature" })).id);
    return platform;
  }
  async function view(platform: TestPlatform, hash: string, feature: string): Promise<Page> {
    const page = await browser.newPage();
    await page.goto(`${platform.canvasUrl}/#${hash}`);
    await page.locator(`#${feature}[data-ready=yes]`).waitFor();
    return page;
  }

  it("delivers a message one viewer sends on a feature channel to another viewer", async () => {
    const platform = await start({ "index.html": withFeature("chat"), "features/chat/chat.js": CHAT_FEATURE });
    const [first, second] = [await view(platform, "first", "chat"), await view(platform, "second", "chat")];

    await first.getByRole("button", { name: "Send hi" }).click();
    await second.getByText("says: hi from #first").waitFor();
    await first.getByText("says: hi from #first").waitFor();
  });

  it("keeps key-value entries per feature, so two features using the same key don't overwrite each other", async () => {
    const platform = await start({
      "index.html": withFeature("apples", "pears"),
      "features/apples/apples.js": counterFeature("apples"),
      "features/pears/pears.js": counterFeature("pears"),
    });
    const page = await view(platform, "a", "pears");
    await page.getByRole("button", { name: "Count apples" }).click();
    await page.getByText("apples: 1").waitFor();
    await page.getByRole("button", { name: "Count apples" }).click();
    await page.getByText("apples: 2").waitFor();
    await page.getByRole("button", { name: "Count pears" }).click();
    await page.getByText("pears: 1").waitFor();

    const other = await view(platform, "b", "pears");
    await other.getByText("apples: 2").waitFor();
    await other.getByText("pears: 1").waitFor();
  });
});

describe("Platform services over HTTP", () => {
  const platforms: TestPlatform[] = [];
  afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.close()));
  });
  async function start(options: { dataDir?: string } = {}) {
    const agent = new FakeAgent();
    const platform = await startTestPlatform({ agent, ...options });
    platforms.push(platform);
    return { platform, agent };
  }
  const put = (platform: TestPlatform, storePath: string, value: unknown) =>
    platform.fetchCanvas(storePath, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });

  it("keeps key-value data when a change Lands that removes the feature's code, and across restarts", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "sma-services-"));
    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
    const { platform, agent } = await start({ dataDir });
    expect((await put(platform, "/__platform/store/guestbook/entry%2F1", { name: "Alice", text: "Hi!" })).status).toBe(204);
    expect((await put(platform, "/__platform/store/guestbook/entry/2", { name: "Bob", text: "Yo" })).status).toBe(204);
    expect((await put(platform, "/__platform/store/guestbook/title", "Guests")).status).toBe(204);

    agent.enqueue((run) => run.deleteFile("features/hello/hello.js"));
    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Mallory", prompt: "remove hello" })).id);
    expect(run.state).toBe("landed");

    const entry = await platform.fetchCanvas("/__platform/store/guestbook/entry%2F1");
    expect(await entry.json()).toEqual({ value: { name: "Alice", text: "Hi!" } });
    const listed = await platform.fetchCanvas("/__platform/store/guestbook/?prefix=entry%2F");
    expect(await listed.json()).toEqual({
      entries: [
        { key: "entry/1", value: { name: "Alice", text: "Hi!" } },
        { key: "entry/2", value: { name: "Bob", text: "Yo" } },
      ],
    });

    await platform.close();
    platforms.splice(platforms.indexOf(platform), 1);
    const { platform: restarted } = await start({ dataDir });
    expect(await (await restarted.fetchCanvas("/__platform/store/guestbook/title")).json()).toEqual({ value: "Guests" });
    expect((await restarted.fetchCanvas("/__platform/store/guestbook/missing")).status).toBe(404);
    expect((await restarted.fetchCanvas("/__platform/store/other/title")).status).toBe(404);
  });

  it("keeps key-value data when the change that added the feature is rolled back", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("features/guestbook/guestbook.js", "// guestbook"));
    const added = await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "add a guestbook" })).id);
    expect(added.state).toBe("landed");
    expect((await put(platform, "/__platform/store/guestbook/entry/1", { name: "Bob", text: "Hi!" })).status).toBe(204);

    const response = await platform.consoleApi("/api/rollbacks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "nickname=Carol" },
      body: JSON.stringify({ commit: added.commit }),
    });
    expect(response.status).toBe(202);
    const rolledBack = await platform.waitForRun(((await response.json()) as { id: string }).id);
    expect(rolledBack.state).toBe("landed");
    expect((await platform.fetchCanvas("/features/guestbook/guestbook.js")).status).toBe(404);

    expect(await (await platform.fetchCanvas("/__platform/store/guestbook/entry/1")).json()).toEqual({ value: { name: "Bob", text: "Hi!" } });
  });

  it("doesn't let the render check of a change touch the features' real data", async () => {
    const { platform, agent } = await start();
    expect((await put(platform, "/__platform/store/visits/count", 41)).status).toBe(204);
    agent.enqueue((run) =>
      run.writeFile(
        "index.html",
        `<!doctype html><html><head><title>Visits</title></head><body><h1>Visits</h1><script type="module">
          import { store } from "/__platform/services.js";
          const db = store("visits");
          await db.set("count", ((await db.get("count")) ?? 0) + 1);
          await db.set("checked", true);
        </script></body></html>`,
      ),
    );
    const run = await platform.waitForRun((await platform.sendPrompt({ nickname: "Alice", prompt: "count visits" })).id);
    expect(run.state).toBe("landed");

    expect(await (await platform.fetchCanvas("/__platform/store/visits/count")).json()).toEqual({ value: 41 });
    expect((await platform.fetchCanvas("/__platform/store/visits/checked")).status).toBe(404);
  });

  it("keeps feature messages and platform events apart on the Canvas event stream", async () => {
    const { platform, agent } = await start();
    const stream = await openEventStream(platform);
    await stream.next("platform"); // hello

    // A feature message dressed up as a platform event is still only a feature message.
    const fake = { type: "landed", runId: "x", nickname: "Eve", prompt: "fake", commit: "0".repeat(40) };
    const post = (feature: string, message: unknown) =>
      platform.fetchCanvas(`/__platform/channel/${feature}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
    expect((await post("chat", fake)).status).toBe(204);
    expect(await stream.next()).toEqual({ event: "feature", data: { feature: "chat", message: fake } });

    agent.enqueue((run) => run.writeFile("features/hello/hello.js", "// changed"));
    const run = await platform.sendPrompt({ nickname: "Alice", prompt: "change hello" });
    expect(await stream.next()).toEqual({ event: "platform", data: { type: "run-started", runId: run.id, nickname: "Alice" } });
    await platform.waitForRun(run.id);
    expect(await stream.next()).toMatchObject({ event: "platform", data: { type: "landed", runId: run.id } });
    expect((await post("votes", { up: 1 })).status).toBe(204);
    expect(await stream.next()).toEqual({ event: "feature", data: { feature: "votes", message: { up: 1 } } });
    stream.close();
  });

  it("is documented in the Canvas CLAUDE.md, so Claude builds backend-style features on it", async () => {
    const { platform } = await start();
    const text = await (await platform.fetchCanvas("/CLAUDE.md")).text();
    for (const usage of ['from "/__platform/services.js"', "channel(", ".send(", ".onMessage(", "store(", ".get(", ".set(", ".list(", ".delete("]) {
      expect(text).toContain(usage);
    }
    expect(text.toLowerCase()).toContain("no server code");
  });

  it("refuses calls from other origins and bad input", async () => {
    const { platform } = await start();
    const crossOrigin = { origin: "http://evil.example", "content-type": "application/json" };
    const body = JSON.stringify({ value: 1, message: 1 });
    for (const [method, servicePath] of [
      ["POST", "/__platform/channel/chat"],
      ["PUT", "/__platform/store/chat/k"],
      ["DELETE", "/__platform/store/chat/k"],
      ["GET", "/__platform/store/chat/k"],
      ["GET", "/__platform/store/chat/"],
    ]) {
      const response = await platform.fetchCanvas(servicePath, { method, headers: crossOrigin, body: method === "GET" ? undefined : body });
      expect(response.status, `${method} ${servicePath}`).toBe(403);
    }
    expect((await platform.fetchCanvas("/__platform/store/chat/k", { method: "PUT", headers: { "sec-fetch-site": "same-site" }, body })).status).toBe(403);

    expect((await put(platform, "/__platform/store/Bad%20Name/k", 1)).status).toBe(400);
    expect((await put(platform, "/__platform/store/chat/k", "x".repeat(70_000))).status).toBe(400);
    expect((await put(platform, `/__platform/store/chat/${"k".repeat(300)}`, 1)).status).toBe(400);
    const noValue = await platform.fetchCanvas("/__platform/store/chat/k", { method: "PUT", body: "{}" });
    expect(noValue.status).toBe(400);
    expect((await platform.fetchCanvas("/__platform/channel/chat", { method: "POST", body: "not json" })).status).toBe(400);
  });
});

/** Reads the Canvas event stream as a viewer would; `next` returns the next SSE message, optionally of one event name. */
async function openEventStream(platform: TestPlatform) {
  const controller = new AbortController();
  const response = await platform.fetchCanvas("/__platform/events", { signal: controller.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    async next(eventName?: string): Promise<{ event: string; data: unknown }> {
      while (true) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)![1];
          const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]);
          if (eventName === undefined || event === eventName) return { event, data };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("Event stream ended");
        buffer += value;
      }
    },
    close: () => controller.abort(),
  };
}
