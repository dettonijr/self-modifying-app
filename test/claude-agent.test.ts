import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { agentFromEnvironment, ClaudeAgent, credentialFromEnvironment, type ClaudeQuery } from "../src/claude-agent.ts";
import { startTestPlatform, type TestPlatform } from "./support/harness.ts";

/**
 * The Claude Agent SDK is the external boundary here: each test plays the SDK
 * with a scripted `query` and checks what the Agent asks of it and reports.
 */

const dirs: string[] = [];
const platforms: TestPlatform[] = [];
afterEach(async () => {
  await Promise.all(platforms.splice(0).map((p) => p.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempWorktree(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sma-claude-"));
  dirs.push(dir);
  const worktree = path.join(dir, "worktree");
  await mkdir(worktree);
  await writeFile(path.join(worktree, "CLAUDE.md"), "# Canvas conventions\nOne folder per feature.\n");
  return worktree;
}

interface Call {
  prompt: string;
  options: Options;
}

/** A fake SDK whose stream is produced by `script`, recording each call. */
function fakeQuery(script: (call: Call) => AsyncIterable<SDKMessage>): { query: ClaudeQuery; calls: Call[] } {
  const calls: Call[] = [];
  const query: ClaudeQuery = ({ prompt, options }) => {
    const call = { prompt, options };
    calls.push(call);
    return script(call);
  };
  return { query, calls };
}

const msg = (value: unknown) => value as SDKMessage;
const assistant = (id: string, content: unknown[], usage = { input_tokens: 0, output_tokens: 0 }) =>
  msg({ type: "assistant", message: { id, content, usage }, parent_tool_use_id: null });
const toolResult = (id: string, content: string, isError = false) =>
  msg({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: null });
const success = (modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> = {}) =>
  msg({ type: "result", subtype: "success", is_error: false, result: "Done", modelUsage });

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

function agentWith(query: ClaudeQuery, limits: { timeLimitMs?: number; tokenLimit?: number } = {}) {
  return new ClaudeAgent({ credential: { kind: "apiKey", value: "sk-test-key" }, timeLimitMs: limits.timeLimitMs ?? 60_000, tokenLimit: limits.tokenLimit ?? 1_000_000, query });
}

async function canUse(options: Options, tool: string, input: Record<string, unknown>): Promise<PermissionResult | null> {
  return options.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: "t1" } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
}

/** Plays Claude Code asking the Agent's `PreToolUse` hook about a tool call. */
async function preToolUse(options: Options, tool: string, input: Record<string, unknown>, toolUseID = "t1") {
  const [matcher] = options.hooks?.PreToolUse ?? [];
  const hookInput = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: toolUseID, session_id: "s", transcript_path: "", cwd: "" };
  return matcher.hooks[0](hookInput as never, toolUseID, { signal: new AbortController().signal });
}

describe("The Claude Agent", () => {
  it("asks Claude to work in the worktree with the chosen model, the Prompt and the Canvas conventions", async () => {
    const worktree = await tempWorktree();
    const { query, calls } = fakeQuery(async function* () {
      yield success();
    });

    await collect(agentWith(query).run({ worktree, instructions: "make it snow", model: "claude-opus-5-5" }));

    const { prompt, options } = calls[0];
    expect(prompt).toContain("make it snow");
    expect(options.cwd).toBe(worktree);
    expect(options.model).toBe("claude-opus-5-5");
    expect(JSON.stringify(options.systemPrompt)).toContain("One folder per feature.");
  });

  it("tells Claude every change must work on phones", async () => {
    const worktree = await tempWorktree();
    const { query, calls } = fakeQuery(async function* () {
      yield success();
    });

    await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    const { append } = calls[0].options.systemPrompt as { append: string };
    for (const rule of ["phone", "sideways", "pointer events", "hover", "44", '<meta name="viewport"']) {
      expect(append).toContain(rule);
    }
    // Word for word the same as the starter Canvas's "Every change works on phones".
    const conventions = await readFile(new URL("../starter-canvas/CLAUDE.md", import.meta.url), "utf8");
    const section = conventions.split("## Every change works on phones\n")[1].split("\n## ")[0].trim();
    expect(append).toContain(section);
  });

  it("offers only file tools: no shell, no network, no subagents, and no settings, hooks or MCP from disk", async () => {
    const worktree = await tempWorktree();
    const { query, calls } = fakeQuery(async function* () {
      yield success();
    });

    await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    const { options } = calls[0];
    expect([...(options.tools as string[])].sort()).toEqual(["Edit", "Glob", "Grep", "Read", "Write"]);
    for (const tool of ["Bash", "WebFetch", "WebSearch", "Agent", "Task", "NotebookEdit"]) {
      expect(options.disallowedTools).toContain(tool);
    }
    expect(options.settingSources).toEqual([]);
    expect(options.mcpServers ?? {}).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.permissionMode).toBe("default");
    expect(options.allowDangerouslySkipPermissions).not.toBe(true);
  });

  it("lets file tools touch only paths inside the worktree, and nothing else at all", async () => {
    const worktree = await tempWorktree();
    const outside = path.dirname(worktree);
    await symlink(outside, path.join(worktree, "escape"));
    const { query, calls } = fakeQuery(async function* () {
      yield success();
    });
    await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));
    const { options } = calls[0];

    expect(await canUse(options, "Write", { file_path: path.join(worktree, "features/snow/snow.js") })).toMatchObject({ behavior: "allow" });
    expect(await canUse(options, "Edit", { file_path: path.join(worktree, "index.html") })).toMatchObject({ behavior: "allow" });
    expect(await canUse(options, "Read", { file_path: path.join(worktree, "theme.css") })).toMatchObject({ behavior: "allow" });
    expect(await canUse(options, "Glob", { pattern: "**/*.js" })).toMatchObject({ behavior: "allow" });
    expect(await canUse(options, "Grep", { pattern: "x", path: path.join(worktree, "features") })).toMatchObject({ behavior: "allow" });

    expect(await canUse(options, "Write", { file_path: path.join(outside, "x.js") })).toMatchObject({ behavior: "deny" });
    expect(await canUse(options, "Edit", { file_path: path.join(worktree, "../x.js") })).toMatchObject({ behavior: "deny" });
    expect(await canUse(options, "Read", { file_path: "/etc/passwd" })).toMatchObject({ behavior: "deny" });
    expect(await canUse(options, "Write", { file_path: path.join(worktree, "escape/x.js") })).toMatchObject({ behavior: "deny" });
    expect(await canUse(options, "Write", { file_path: path.join(worktree, ".git") })).toMatchObject({ behavior: "deny" });
    expect(await canUse(options, "Glob", { pattern: "*", path: "/" })).toMatchObject({ behavior: "deny" });
    expect(await canUse(options, "Write", { file_path: "relative.js" })).toMatchObject({ behavior: "deny" });
    expect(await canUse(options, "Bash", { command: "curl example.com" })).toMatchObject({ behavior: "deny" });
    expect(await canUse(options, "WebFetch", { url: "https://example.com" })).toMatchObject({ behavior: "deny" });
  });

  it("passes the API key only to Claude's process, never in the instructions", async () => {
    const worktree = await tempWorktree();
    const { query, calls } = fakeQuery(async function* () {
      yield success();
    });
    await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(calls[0].options.env?.ANTHROPIC_API_KEY).toBe("sk-test-key");
    expect(calls[0].prompt).not.toContain("sk-test-key");
    expect(JSON.stringify(calls[0].options.systemPrompt)).not.toContain("sk-test-key");
  });

  it("hands Claude's process only the chosen credential", async () => {
    const worktree = await tempWorktree();
    const { query, calls } = fakeQuery(async function* () {
      yield success();
    });
    const agent = new ClaudeAgent({ credential: { kind: "oauthToken", value: "oat-test-token" }, timeLimitMs: 60_000, tokenLimit: 1_000_000, query });
    const before = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-stray-key";
    try {
      await collect(agent.run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));
    } finally {
      process.env = before;
    }

    expect(calls[0].options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-test-token");
    expect(calls[0].options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0].prompt).not.toContain("oat-test-token");
  });

  it("reports files being edited, token usage and success", async () => {
    const worktree = await tempWorktree();
    const { query } = fakeQuery(async function* () {
      yield assistant("m1", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: path.join(worktree, "features/snow/snow.js") } }], { input_tokens: 100, output_tokens: 20 });
      yield assistant("m2", [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: path.join(worktree, "index.html") } }], { input_tokens: 150, output_tokens: 30 });
      yield success({ "claude-sonnet-5-5": { inputTokens: 250, outputTokens: 50 } });
    });

    const events = await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(events.filter((e) => e.type === "progress")).toEqual([
      { type: "progress", message: "Editing features/snow/snow.js", file: "features/snow/snow.js" },
      { type: "progress", message: "Editing index.html", file: "index.html" },
    ]);
    expect(totalUsage(events)).toEqual({ inputTokens: 250, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(events.at(-1)).toEqual({ type: "result", outcome: "success" });
  });

  it("reports Claude's text replies as messages, but never tool inputs, tool results or the final result text", async () => {
    const worktree = await tempWorktree();
    const { query } = fakeQuery(async function* () {
      yield assistant("m1", [
        { type: "text", text: "I'll add some snow." },
        { type: "tool_use", id: "t1", name: "Write", input: { file_path: path.join(worktree, "snow.js"), content: "tool input" } },
      ]);
      yield toolResult("t1", "tool output");
      yield assistant("m2", [{ type: "text", text: "  " }, { type: "text", text: "Done: it snows now." }]);
      yield success();
    });

    const events = await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(events.filter((e) => e.type === "message")).toEqual([
      { type: "message", text: "I'll add some snow." },
      { type: "message", text: "Done: it snows now." },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/tool input|tool output|"Done"/);
  });

  it("asks for thinking summaries and reports each one, skipping redacted and empty thinking", async () => {
    const worktree = await tempWorktree();
    const { query, calls } = fakeQuery(async function* () {
      yield assistant("m1", [
        { type: "thinking", thinking: "The Player wants snow.\nA new feature folder fits.", signature: "sig" },
        { type: "text", text: "I'll add some snow." },
      ]);
      yield assistant("m2", [{ type: "redacted_thinking", data: "hidden" }, { type: "thinking", thinking: " ", signature: "sig" }, { type: "thinking", thinking: "", signature: "sig" }]);
      yield success();
    });

    const events = await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(calls[0].options.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(events.filter((e) => e.type === "thinking" || e.type === "message")).toEqual([
      { type: "thinking", text: "The Player wants snow.\nA new feature folder fits." },
      { type: "message", text: "I'll add some snow." },
    ]);
    expect(JSON.stringify(events)).not.toContain("hidden");
  });

  it("reports each tool call once, with its tool and worktree-relative target, never its output", async () => {
    const worktree = await tempWorktree();
    const at = (relative: string) => path.join(worktree, relative);
    await mkdir(at("features/snow"), { recursive: true });
    const calls: Array<[string, Record<string, unknown>]> = [
      ["Read", { file_path: at("features/snow/index.js") }],
      ["Edit", { file_path: at("index.html"), old_string: "old secret", new_string: "new secret" }],
      ["Write", { file_path: at("features/rain/rain.js"), content: "file contents" }],
      ["Grep", { pattern: "snow", path: at("features") }],
      ["Grep", { pattern: "rain" }],
      ["Glob", { pattern: "features/**/*.css" }],
      ["Glob", { pattern: "*.js", path: at("features/snow") }],
    ];
    const { query } = fakeQuery(async function* () {
      for (const [i, [name, input]] of calls.entries()) {
        yield assistant(`m${i}`, [{ type: "tool_use", id: `t${i}`, name, input }]);
        yield toolResult(`t${i}`, "tool output");
      }
      yield success();
    });

    const events = await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(events.filter((e) => e.type === "tool")).toEqual([
      { type: "tool", text: "Read features/snow/index.js" },
      { type: "tool", text: "Edit index.html" },
      { type: "tool", text: "Write features/rain/rain.js" },
      { type: "tool", text: "Grep 'snow' in features/" },
      { type: "tool", text: "Grep 'rain'" },
      { type: "tool", text: "Glob features/**/*.css" },
      { type: "tool", text: "Glob *.js in features/snow/" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/tool output|secret|file contents/);
  });

  it("reports a tool call refused by the confinement with the reason", async () => {
    const worktree = await tempWorktree();
    const { query } = fakeQuery(async function* ({ options }) {
      const refusals: Array<[string, Record<string, unknown>]> = [
        ["Read", { file_path: "/etc/hostname" }],
        ["Write", { file_path: path.join(worktree, ".git/config") }],
        ["Write", { file_path: "relative.js" }],
        ["Bash", { command: "curl example.com" }],
      ];
      for (const [i, [name, input]] of refusals.entries()) {
        yield assistant(`m${i}`, [{ type: "tool_use", id: `t${i}`, name, input }]);
        await options.canUseTool!(name, input, { signal: new AbortController().signal, toolUseID: `t${i}` } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
        yield toolResult(`t${i}`, "permission denied", true);
      }
      yield success();
    });

    const events = await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(events.filter((e) => e.type === "tool")).toEqual([
      { type: "tool", text: "Refused: Read /etc/hostname (outside the Canvas)" },
      { type: "tool", text: "Refused: Write .git/config (inside the Canvas's history)" },
      { type: "tool", text: "Refused: Write relative.js (not an absolute path)" },
      { type: "tool", text: "Refused: Bash (not available)" },
    ]);
  });

  it("applies the same confinement in a PreToolUse hook, which Claude Code runs even for calls it allows by itself", async () => {
    const worktree = await tempWorktree();
    const { query, calls } = fakeQuery(async function* () {
      yield success();
    });
    await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));
    const { options } = calls[0];

    expect(await preToolUse(options, "Read", { file_path: path.join(worktree, "index.html") })).toEqual({});
    expect(await preToolUse(options, "Glob", { pattern: "**/*.js" })).toEqual({});
    for (const [tool, input] of [
      ["Read", { file_path: path.join(worktree, ".git/config") }],
      ["Grep", { pattern: "x", path: path.join(worktree, ".git") }],
      ["Read", { file_path: "/etc/passwd" }],
      ["Read", { file_path: "relative.js" }],
      ["Bash", { command: "ls" }],
    ] as const) {
      expect(await preToolUse(options, tool, input)).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    }
  });

  it("reports a tool call refused by the PreToolUse hook with the reason", async () => {
    const worktree = await tempWorktree();
    const { query } = fakeQuery(async function* ({ options }) {
      const input = { file_path: path.join(worktree, ".git/config") };
      yield assistant("m1", [{ type: "tool_use", id: "t1", name: "Read", input }]);
      await preToolUse(options, "Read", input, "t1");
      yield toolResult("t1", "Only files inside the working directory can be used", true);
      yield success();
    });

    const events = await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(events.filter((e) => e.type === "tool")).toEqual([{ type: "tool", text: "Refused: Read .git/config (inside the Canvas's history)" }]);
  });

  it("still reports a tool call that never got a result before the Run ended", async () => {
    const worktree = await tempWorktree();
    const { query } = fakeQuery(async function* () {
      yield assistant("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: path.join(worktree, "index.html") } }]);
      yield success();
    });

    const events = await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(events.filter((e) => e.type === "tool")).toEqual([{ type: "tool", text: "Read index.html" }]);
    expect(events.at(-1)).toEqual({ type: "result", outcome: "success" });
  });

  it("reports fresh input, cache reads, cache writes and output separately, and reconciles with Claude's final totals", async () => {
    const worktree = await tempWorktree();
    const { query } = fakeQuery(async function* () {
      yield assistant("m1", [{ type: "text", text: "Looking" }], { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 40 } as never);
      yield assistant("m1", [{ type: "text", text: "Still looking" }], { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 90, cache_creation_input_tokens: 40 } as never);
      yield success({ "claude-sonnet-5-5": { inputTokens: 30, outputTokens: 8, cacheReadInputTokens: 500, cacheCreationInputTokens: 60 } });
    });

    const events = await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(events.filter((e) => e.type === "usage")[0]).toEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 40 } });
    expect(totalUsage(events)).toEqual({ inputTokens: 30, outputTokens: 8, cacheReadTokens: 500, cacheWriteTokens: 60 });
  });

  it("counts cache reads and writes toward the token cap", async () => {
    const worktree = await tempWorktree();
    const { query } = fakeQuery(async function* (call) {
      yield assistant("m1", [{ type: "text", text: "thinking" }], { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } as never);
      await aborted(call.options.abortController!.signal);
      throw new Error("aborted");
    });

    const events = await collect(agentWith(query, { tokenLimit: 1000 }).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "failure", error: expect.stringMatching(/token/i) });
  });

  it("reports failure when Claude ends with an error", async () => {
    const worktree = await tempWorktree();
    const { query } = fakeQuery(async function* () {
      yield msg({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["API overloaded"], modelUsage: {} });
    });

    const events = await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "failure", error: expect.stringContaining("API overloaded") });
  });

  it("reports failure when the SDK throws, without leaking the API key", async () => {
    const worktree = await tempWorktree();
    const { query } = fakeQuery(async function* () {
      throw new Error("Invalid API key sk-test-key");
    });

    const events = await collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    const last = events.at(-1);
    expect(last).toMatchObject({ type: "result", outcome: "failure" });
    expect(JSON.stringify(last)).not.toContain("sk-test-key");
  });

  it("stops a Run that goes over its token cap and reports it as failed", async () => {
    const worktree = await tempWorktree();
    const { query, calls } = fakeQuery(async function* (call) {
      yield assistant("m1", [{ type: "text", text: "thinking" }], { input_tokens: 600, output_tokens: 100 });
      yield assistant("m2", [{ type: "text", text: "more" }], { input_tokens: 400, output_tokens: 100 });
      await aborted(call.options.abortController!.signal);
      throw new Error("aborted");
    });

    const events = await collect(agentWith(query, { tokenLimit: 1000 }).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(calls[0].options.abortController!.signal.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "failure", error: expect.stringMatching(/token/i) });
    expect(totalUsage(events)).toEqual({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("stops a Run that goes over its time cap and reports it as failed", async () => {
    const worktree = await tempWorktree();
    const { query, calls } = fakeQuery(async function* (call) {
      await aborted(call.options.abortController!.signal);
      throw new Error("aborted");
    });

    const events = await collect(agentWith(query, { timeLimitMs: 50 }).run({ worktree, instructions: "x", model: "claude-sonnet-5-5" }));

    expect(calls[0].options.abortController!.signal.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "failure", error: expect.stringMatching(/time/i) });
  });

  it("stops when the platform aborts the Run", async () => {
    const worktree = await tempWorktree();
    const { query } = fakeQuery(async function* (call) {
      await aborted(call.options.abortController!.signal);
      throw new Error("aborted");
    });
    const abort = new AbortController();

    const run = collect(agentWith(query).run({ worktree, instructions: "x", model: "claude-sonnet-5-5", signal: abort.signal }));
    abort.abort();

    expect((await run).at(-1)).toMatchObject({ type: "result", outcome: "failure" });
  });

  it("drives a Prompt from the Console to a Land on the platform", async () => {
    const { query } = fakeQuery(async function* (call) {
      const target = path.join(call.options.cwd!, "index.html");
      await writeFile(target, "<h1>Hello</h1>\n");
      yield assistant("m1", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: target } }], { input_tokens: 10, output_tokens: 5 });
      yield success();
    });
    const platform = await startTestPlatform({ agent: agentWith(query) });
    platforms.push(platform);

    const run = await platform.sendPrompt({ nickname: "Alice", prompt: "change the title to Hello" });

    expect(await platform.waitForRun(run.id)).toMatchObject({ state: "landed" });
    expect(await (await platform.fetchCanvas("/index.html")).text()).toContain("<h1>Hello</h1>");
  });
});

function totalUsage(events: AgentEvent[]) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const event of events) {
    if (event.type !== "usage") continue;
    total.inputTokens += event.usage.inputTokens;
    total.outputTokens += event.usage.outputTokens;
    total.cacheReadTokens += event.usage.cacheReadTokens ?? 0;
    total.cacheWriteTokens += event.usage.cacheWriteTokens ?? 0;
  }
  return total;
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}


describe("Choosing the Agent from the environment", () => {
  it("uses Claude when an API key is set, with default caps", () => {
    const agent = agentFromEnvironment({ ANTHROPIC_API_KEY: "sk-test-key" });
    expect(agent).toBeInstanceOf(ClaudeAgent);
    expect((agent as ClaudeAgent).limits).toEqual({ timeLimitMs: 600_000, tokenLimit: 2_000_000 });
  });

  it("reads the caps from RUN_TIME_LIMIT_SECONDS and RUN_TOKEN_LIMIT", () => {
    const agent = agentFromEnvironment({ ANTHROPIC_API_KEY: "sk-test-key", RUN_TIME_LIMIT_SECONDS: "120", RUN_TOKEN_LIMIT: "50000" });
    expect((agent as ClaudeAgent).limits).toEqual({ timeLimitMs: 120_000, tokenLimit: 50_000 });
  });

  it("refuses caps that aren't positive numbers", () => {
    expect(() => agentFromEnvironment({ ANTHROPIC_API_KEY: "k", RUN_TOKEN_LIMIT: "lots" })).toThrow(/RUN_TOKEN_LIMIT/);
  });

  it("uses Claude with a subscription token when there's no API key, and prefers the API key when both are set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(credentialFromEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: "oat-test-token" })).toEqual({ kind: "oauthToken", value: "oat-test-token" });
      expect(agentFromEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: "oat-test-token" })).toBeInstanceOf(ClaudeAgent);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/subscription token/));
      expect(credentialFromEnvironment({ ANTHROPIC_API_KEY: "sk-test-key", CLAUDE_CODE_OAUTH_TOKEN: "oat-test-token" })).toEqual({ kind: "apiKey", value: "sk-test-key" });
    } finally {
      warn.mockRestore();
    }
  });

  it("fails every Run without an API key or subscription token", async () => {
    const agent = agentFromEnvironment({});
    expect(agent).not.toBeInstanceOf(ClaudeAgent);
    expect((await collect(agent.run({ worktree: "/nowhere", instructions: "x", model: "claude-sonnet-5-5" }))).at(-1)).toMatchObject({ outcome: "failure" });
  });
});
