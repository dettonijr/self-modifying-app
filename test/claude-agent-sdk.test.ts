import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { ClaudeAgent } from "../src/claude-agent.ts";
import { startFakeAnthropicApi, type FakeAnthropicApi } from "./support/fake-anthropic-api.ts";

/**
 * The real Claude Agent SDK and the Claude Code process it starts, with only
 * the Anthropic API played by a local fake: proves the confinement holds for
 * calls Claude Code would otherwise allow on its own, like reading `.git`.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function gitWorktree(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sma-sdk-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const worktree = path.join(dir, "worktree");
  await mkdir(worktree);
  await writeFile(path.join(worktree, "index.html"), "<h1>Canvas</h1>\n");
  await promisify(execFile)("git", ["init", "-q"], { cwd: worktree });
  await writeFile(path.join(worktree, ".git/config"), "[core]\n\tsecret = in-the-history\n", { flag: "a" });
  return worktree;
}

function agentAgainst(api: FakeAnthropicApi): ClaudeAgent {
  return new ClaudeAgent({
    apiKey: "sk-ant-fake",
    timeLimitMs: 60_000,
    tokenLimit: 1_000_000,
    query: ({ prompt, options }) =>
      sdkQuery({
        prompt,
        options: { ...options, env: { ...options.env, ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CONFIG_DIR: path.join(options.cwd!, "..", "claude-config") } },
      }),
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe("The Claude Agent on the real SDK", () => {
  it("refuses reading the Canvas's history even though Claude Code allows reads in its working folder", { timeout: 60_000 }, async () => {
    const worktree = await gitWorktree();
    const api = await startFakeAnthropicApi([
      { tool: "Read", input: { file_path: path.join(worktree, "index.html") } },
      { tool: "Read", input: { file_path: path.join(worktree, ".git/config") } },
      { tool: "Grep", input: { pattern: "secret", path: path.join(worktree, ".git") } },
      { text: "Done." },
    ]);
    cleanups.push(() => api.close());

    const events = await collect(agentAgainst(api).run({ worktree, instructions: "look around", model: "claude-sonnet-5-5" }));

    expect(events.filter((e) => e.type === "tool")).toEqual([
      { type: "tool", text: "Read index.html" },
      { type: "tool", text: "Refused: Read .git/config (inside the Canvas's history)" },
      { type: "tool", text: "Refused: Grep 'secret' in .git/ (inside the Canvas's history)" },
    ]);
    expect(JSON.stringify(api.toolResults[0])).toContain("Canvas");
    expect(JSON.stringify(api.toolResults.slice(1))).not.toContain("in-the-history");
    expect(events.at(-1)).toEqual({ type: "result", outcome: "success" });
  });
});
