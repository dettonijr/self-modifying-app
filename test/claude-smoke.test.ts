import { afterEach, describe, expect, it } from "vitest";
import { agentFromEnvironment } from "../src/claude-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

/**
 * Opt-in: talks to the real Claude and spends real tokens. Runs only with
 * `ANTHROPIC_API_KEY` set and `CLAUDE_SMOKE_TEST=1`, e.g.
 * `CLAUDE_SMOKE_TEST=1 ANTHROPIC_API_KEY=... npx vitest run test/claude-smoke.test.ts`.
 */
const enabled = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.CLAUDE_SMOKE_TEST === "1";

describe.skipIf(!enabled)("The real Claude Agent (smoke test)", () => {
  let platform: TestPlatform | undefined;
  afterEach(async () => {
    await platform?.close();
  });

  it("Lands \"change the title to Hello\", with Claude's messages and tool calls in the Run's log", { timeout: 300_000 }, async () => {
    platform = await startTestPlatform({ agent: agentFromEnvironment(process.env) });

    const run = await platform.sendPrompt({ nickname: "Smoke", prompt: "change the title to Hello" });

    expect(await platform.waitForRun(run.id)).toMatchObject({ state: "landed" });
    const page = await (await platform.fetchCanvas("/index.html")).text();
    expect(page).toMatch(/<h1[^>]*>\s*Hello\s*<\/h1>|<title>\s*Hello\s*<\/title>/);
    const { log } = (await (await platform.consoleApi(`/api/runs/${run.id}`)).json()) as { log: Array<{ source: string; text: string }> };
    expect(log.filter((entry) => entry.source === "claude").length).toBeGreaterThan(0);
    expect(log.filter((entry) => entry.source === "tool").length).toBeGreaterThan(0);
  });
});
