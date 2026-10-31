import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

describe("Render check", () => {
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

  it("doesn't Land a change that leaves the page blank, and main stays put", async () => {
    const { platform, agent } = await start();
    const before = main(platform);
    agent.enqueue((run) => run.writeFile("index.html", "<!doctype html><html><head><title>gone</title></head><body></body></html>"));

    const run = await platform.sendPrompt({ nickname: "Alice", prompt: "remove everything" });

    expect(await platform.waitForRun(run.id)).toMatchObject({ state: "rejected", error: "Canvas didn't render" });
    expect(main(platform)).toBe(before);
    expect(await (await platform.fetchCanvas("/")).text()).toContain("The Canvas");
  });

  it("doesn't Land a change whose page throws a fatal error on load", async () => {
    const { platform, agent } = await start();
    const before = main(platform);
    agent.enqueue((run) =>
      run.writeFile(
        "index.html",
        `<!doctype html><html><body><h1>The Canvas</h1><script>throw new Error("boom");</script></body></html>`,
      ),
    );

    const run = await platform.sendPrompt({ nickname: "Bob", prompt: "add a bug to the page" });

    expect(await platform.waitForRun(run.id)).toMatchObject({ state: "rejected", error: "Canvas didn't render" });
    expect(main(platform)).toBe(before);
  });

  it("Lands a change that breaks a feature but still renders the page", async () => {
    const { platform, agent } = await start();
    agent.enqueue((run) => run.writeFile("features/hello/hello.js", `throw new Error("the greeting broke");\n`));

    const run = await platform.sendPrompt({ nickname: "Carol", prompt: "make hello fancier" });

    const finished = await platform.waitForRun(run.id);
    expect(finished).toMatchObject({ state: "landed" });
    expect(main(platform)).toBe(finished.commit);
    expect(await (await platform.fetchCanvas("/features/hello/hello.js")).text()).toContain("the greeting broke");
  });

  it("doesn't Land a change that removes the entry page", async () => {
    const { platform, agent } = await start();
    const before = main(platform);
    agent.enqueue((run) => run.deleteFile("index.html"));

    const run = await platform.sendPrompt({ nickname: "Dave", prompt: "delete the page" });

    expect(await platform.waitForRun(run.id)).toMatchObject({ state: "rejected", error: "Canvas didn't render" });
    expect(main(platform)).toBe(before);
  });
});

function main(platform: TestPlatform): string {
  return execFileSync("git", ["rev-parse", "main"], { cwd: platform.canvasRepoDir, encoding: "utf8" }).trim();
}
