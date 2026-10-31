import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent, Gate, type FakeAgentContext, type FakeAgentScript } from "./support/fake-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

describe("Conflict handling", () => {
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

  /**
   * Lands Bob's "Rain" title while Alice's "Snow" title is held, so Alice's
   * Run conflicts. `alice` plays Alice's Run, `resolve` each resolution
   * request and `restart` the Run started over. Scripts are picked by task,
   * not by start order.
   */
  async function collide(
    platform: TestPlatform,
    agent: FakeAgent,
    scripts: { resolve?: FakeAgentScript[]; restart?: FakeAgentScript; alice?: (run: FakeAgentContext) => Promise<void> },
  ) {
    const hold = new Gate();
    const resolutions = [...(scripts.resolve ?? [])];
    let aliceRuns = 0;
    const play: FakeAgentScript = async (run) => {
      if (isResolution(run)) {
        const next = resolutions.shift();
        if (!next) throw new Error("unexpected resolution");
        return next(run);
      }
      const title = run.task.instructions.slice("title it ".length);
      if (title !== "Snow") return run.writeFile("index.html", `<h1>${title}</h1>`);
      if (aliceRuns++ === 0) {
        await (scripts.alice ?? (async (r: FakeAgentContext) => r.writeFile("index.html", "<h1>Snow</h1>")))(run);
        await Promise.race([hold.wait(), run.aborted()]);
        return;
      }
      if (!scripts.restart) throw new Error("unexpected restart");
      return scripts.restart(run);
    };
    agent.enqueue(play, play, play, play, play, play);
    const alice = await platform.sendPrompt({ nickname: "Alice", prompt: "title it Snow" });
    await agent.started(1);
    const bob = await platform.sendPrompt({ nickname: "Bob", prompt: "title it Rain" });
    const landed = await platform.waitForRun(bob.id);
    expect(landed).toMatchObject({ state: "landed" });
    hold.release();
    return { alice, bob: landed };
  }

  it("asks the Agent to resolve a conflict, with both Prompts, and Lands the Run with both changes", async () => {
    const { platform, agent } = await start();
    let conflicted = "";
    const { alice, bob } = await collide(platform, agent, {
      alice: async (run) => {
        await run.writeFile("index.html", "<h1>Snow</h1>");
        await run.writeFile("features/snow/snow.js", "snow");
      },
      resolve: [
        async (run) => {
          conflicted = await readFile(path.join(run.task.worktree, "index.html"), "utf8");
          run.usage({ inputTokens: 1000, outputTokens: 100 });
          await run.writeFile("index.html", "<h1>Snow and Rain</h1>");
        },
      ],
    });

    const finished = await platform.waitForRun(alice.id);
    expect(finished).toMatchObject({ state: "landed" });
    const resolution = agent.tasks.find((task) => isResolution({ task } as FakeAgentContext))!;
    expect(resolution.model).toBe("claude-sonnet-5-5");
    expect(resolution.instructions).toContain("title it Snow");
    expect(resolution.instructions).toContain("title it Rain");
    expect(resolution.instructions).toContain("index.html");
    expect(conflicted).toMatch(/<<<<<<<[\s\S]*Rain[\s\S]*Snow|<<<<<<<[\s\S]*Snow[\s\S]*Rain/);

    const { log } = (await (await platform.consoleApi(`/api/runs/${alice.id}`)).json()) as { log: Array<{ text: string }> };
    expect(log.map((entry) => entry.text)).toContain("Fixing a conflict (attempt 1 of 2)");
    expect(git(platform, ["rev-parse", "main"])).toBe(finished.commit);
    expect(git(platform, ["rev-parse", `${finished.commit}^`])).toBe(bob.commit);
    expect(await (await platform.fetchCanvas("/")).text()).toContain("Snow and Rain");
    expect(await (await platform.fetchCanvas("/features/snow/snow.js")).text()).toBe("snow");
    expect(git(platform, ["branch", "--list"])).toBe("* main");
  });

  it("starts the Run over once on the latest main after two failed resolutions, and the restart can Land", async () => {
    const { platform, agent } = await start();
    const { alice, bob } = await collide(platform, agent, {
      resolve: [
        () => {
          throw new Error("couldn't resolve it");
        },
        // Succeeds, but leaves the conflict markers in.
        () => undefined,
      ],
      restart: async (run) => {
        // The restart starts from the latest main, which already has Bob's change.
        expect(await readFile(path.join(run.task.worktree, "index.html"), "utf8")).toBe("<h1>Rain</h1>");
        await run.writeFile("index.html", "<h1>Snow, after Rain</h1>");
      },
    });

    const finished = await platform.waitForRun(alice.id);
    expect(finished).toMatchObject({ state: "landed" });
    expect(agent.tasks.filter((task) => isResolution({ task } as FakeAgentContext))).toHaveLength(2);
    expect(agent.tasks.filter((task) => task.instructions === "title it Snow")).toHaveLength(2);
    expect(git(platform, ["rev-parse", `${finished.commit}^`])).toBe(bob.commit);
    expect(await (await platform.fetchCanvas("/")).text()).toContain("Snow, after Rain");
    expect(git(platform, ["branch", "--list"])).toBe("* main");
  });

  it("rejects the Run, saying its Prompt collided, when the resolutions and the restart all fail", async () => {
    const { platform, agent } = await start();
    const restarted = new Gate();
    const carolLanded = new Gate();
    const { alice } = await collide(platform, agent, {
      resolve: [() => undefined, () => undefined],
      restart: async (run) => {
        await run.writeFile("index.html", "<h1>Snow again</h1>");
        restarted.release();
        await Promise.race([carolLanded.wait(), run.aborted()]);
      },
    });
    await restarted.wait();
    const carol = await platform.sendPrompt({ nickname: "Carol", prompt: "title it Hail" });
    const mainAfterCarol = (await platform.waitForRun(carol.id)).commit;
    carolLanded.release();

    const finished = await platform.waitForRun(alice.id);
    expect(finished).toMatchObject({ state: "rejected", error: expect.stringMatching(/collided/) });
    // No resolution for the restart: two for the first try only.
    expect(agent.tasks.filter((task) => isResolution({ task } as FakeAgentContext))).toHaveLength(2);
    expect(git(platform, ["rev-parse", "main"])).toBe(mainAfterCarol);
    expect(git(platform, ["branch", "--list"])).toBe("* main");
  });

  it("shows only a rejected Run's last attempt as its change, after its fixes and restart failed", async () => {
    const { platform, agent } = await start();
    const { alice } = await collide(platform, agent, {
      alice: async (run) => {
        await run.writeFile("index.html", "<h1>Snow</h1>");
        await run.writeFile("features/snow/first-try.js", "snow");
      },
      resolve: [
        async (run) => {
          await run.writeFile("features/snow/fix.js", "fix");
          throw new Error("couldn't resolve it");
        },
        () => undefined,
      ],
      restart: async (run) => {
        await run.writeFile("index.html", "<h1>Snow again</h1>\n");
        throw new Error("gave up");
      },
    });

    expect(await platform.waitForRun(alice.id)).toMatchObject({ state: "rejected" });
    const files = (await (await platform.consoleApi(`/api/runs/${alice.id}`)).json()).files;
    expect(files.map((file: { path: string }) => file.path)).toEqual(["index.html"]);
    expect(files[0].diff).toContain("-<h1>Rain</h1>");
    expect(files[0].diff).toContain("+<h1>Snow again</h1>");
  });

  it("shows only what Landed as a Run's change after a conflict fix", async () => {
    const { platform, agent } = await start();
    const { alice } = await collide(platform, agent, {
      resolve: [async (run) => run.writeFile("index.html", "<h1>Snow and Rain</h1>\n")],
    });

    expect(await platform.waitForRun(alice.id)).toMatchObject({ state: "landed" });
    const files = (await (await platform.consoleApi(`/api/runs/${alice.id}`)).json()).files;
    expect(files.map((file: { path: string }) => file.path)).toEqual(["index.html"]);
    expect(files[0].diff).toContain("-<h1>Rain</h1>");
    expect(files[0].diff).toContain("+<h1>Snow and Rain</h1>");
  });

  describe("a render-check failure takes the same path", () => {
    const blank = "<!doctype html><html><body></body></html>";

    it("asks the Agent to fix a page that doesn't render, and Lands the fix as one commit", async () => {
      const { platform, agent } = await start();
      const before = git(platform, ["rev-parse", "main"]);
      agent.enqueue(
        (run) => run.writeFile("index.html", blank),
        (run) => run.writeFile("index.html", "<h1>Fixed</h1>"),
      );
      const run = await platform.sendPrompt({ nickname: "Dave", prompt: "title it Blank", model: "claude-opus-5-5" });

      const finished = await platform.waitForRun(run.id);
      expect(finished).toMatchObject({ state: "landed" });
      expect(agent.tasks[1].model).toBe("claude-sonnet-5-5");
      expect(agent.tasks[1].instructions).toContain("title it Blank");
      expect(agent.tasks[1].instructions).toMatch(/render/);
      expect(git(platform, ["rev-parse", `${finished.commit}^`])).toBe(before);
      expect(await (await platform.consoleApi("/api/history")).json()).toMatchObject([{ prompt: "title it Blank", model: "claude-opus-5-5" }]);
    });

    it("restarts after two failed fixes, and rejects the Run if the restart doesn't render either", async () => {
      const { platform, agent } = await start();
      const before = git(platform, ["rev-parse", "main"]);
      const broken = (run: FakeAgentContext) => run.writeFile("index.html", blank);
      agent.enqueue(broken, () => undefined, broken, broken);
      const run = await platform.sendPrompt({ nickname: "Dave", prompt: "title it Blank" });

      expect(await platform.waitForRun(run.id)).toMatchObject({ state: "rejected", error: "Canvas didn't render" });
      expect(agent.tasks.map((task) => task.instructions === "title it Blank")).toEqual([true, false, false, true]);
      expect(git(platform, ["rev-parse", "main"])).toBe(before);
    });
  });
});

/** A Run's own Agent session gets exactly its Prompt, "title it <word>"; anything else is a resolution request. */
function isResolution(run: FakeAgentContext): boolean {
  return !/^title it \w+$/.test(run.task.instructions);
}

function git(platform: TestPlatform, args: string[]): string {
  return execFileSync("git", args, { cwd: platform.canvasRepoDir, encoding: "utf8" }).trim();
}
