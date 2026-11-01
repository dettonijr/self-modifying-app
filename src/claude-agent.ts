import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { query as sdkQuery, type CanUseTool, type HookCallbackMatcher, type HookEvent, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { addUsage, unavailableAgent, USAGE_KINDS, zeroUsage, type Agent, type AgentEvent, type AgentTask, type TokenUsage, type UsageCounts } from "./agent.ts";
import { positiveNumberFromEnvironment } from "./environment.ts";

/** The one call into the Claude Agent SDK; tests substitute a scripted stream. */
export type ClaudeQuery = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeAgentOptions {
  /** The host's Anthropic API key. Only ever handed to Claude's own process. */
  apiKey: string;
  /** A Run still working after this long is stopped and fails. */
  timeLimitMs: number;
  /** A Run that uses more tokens than this (fresh input, cache reads, cache writes and output) is stopped and fails. */
  tokenLimit: number;
  query?: ClaudeQuery;
}

/** The only tools Claude gets: reading and editing files, all confined to the worktree. */
const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];
/** Belt and braces: refused even if some default would offer them. */
const FORBIDDEN_TOOLS = ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch", "Agent", "Task", "NotebookEdit", "Skill", "Workflow"];

/** The mobile rules repeat "Every change works on phones" in starter-canvas/CLAUDE.md word for word; a test keeps them in sync. */
const PLATFORM_RULES = `You are editing the Canvas, a website shared by the Players of a game, in your current working directory.
Players send Prompts; do what the Prompt asks by editing files there.
You can only read and edit files inside the working directory: there is no shell and no network access.
Make the change and stop; don't ask questions, nobody will answer them.

Players play on phones as well as computers, so every feature and every page must work on a phone:

- Layouts fit narrow screens (from 360px wide) without scrolling sideways. Prefer flexible widths (\`%\`, \`fr\`, \`min()\`, \`max-width: 100%\`) over fixed pixel widths, and let content wrap.
- Touch works everywhere a mouse does. Use pointer events (\`pointerdown\`, \`pointermove\`, \`pointerup\`) rather than mouse-only events (\`mousedown\`, \`mousemove\`, \`mouseup\`), and set \`touch-action: none\` on things you drag so the page doesn't scroll instead.
- Nothing only works on hover. Anything shown on hover must also be reachable by tapping.
- Tap targets (buttons, links, controls) are at least 44×44px.
- Every page has \`<meta name="viewport" content="width=device-width, initial-scale=1">\` in its \`<head>\`.`;

/**
 * The real Agent: Claude through the Claude Agent SDK, limited to file tools
 * inside the Run's worktree, with per-Run time and token caps.
 */
export class ClaudeAgent implements Agent {
  private readonly options: ClaudeAgentOptions;
  private readonly query: ClaudeQuery;

  constructor(options: ClaudeAgentOptions) {
    this.options = options;
    this.query = options.query ?? ((params) => sdkQuery(params));
  }

  get limits(): { timeLimitMs: number; tokenLimit: number } {
    return { timeLimitMs: this.options.timeLimitMs, tokenLimit: this.options.tokenLimit };
  }

  async *run(task: AgentTask): AsyncGenerator<AgentEvent> {
    const abort = new AbortController();
    let stopReason: string | undefined;
    const stop = (reason: string) => {
      stopReason ??= reason;
      abort.abort();
    };
    const onPlatformAbort = () => stop("The Run was stopped");
    if (task.signal?.aborted) onPlatformAbort();
    task.signal?.addEventListener("abort", onPlatformAbort, { once: true });
    const timer = setTimeout(() => stop(`The Run went over its time limit of ${Math.round(this.options.timeLimitMs / 1000)} seconds`), this.options.timeLimitMs);

    const usage = new UsageTracker();
    const toolCalls = new ToolCalls(task.worktree);
    try {
      const options = await this.sdkOptions(task, abort, toolCalls);
      for await (const message of this.query({ prompt: promptFor(task), options })) {
        if (message.type === "assistant") {
          const blocks = blocksOf(message.message.content);
          for (const event of eventsOf(blocks, task.worktree)) yield event;
          toolCalls.called(blocks);
          const delta = usage.seeMessage(message.message.id, message.message.usage as unknown as Record<string, number | undefined>);
          if (delta) yield { type: "usage", usage: delta };
          if (usage.total() > this.options.tokenLimit) stop(`The Run went over its limit of ${this.options.tokenLimit} tokens`);
          if (stopReason !== undefined) break;
        } else if (message.type === "user") {
          for (const event of await toolCalls.resultsArrived(message.message.content)) yield event;
        } else if (message.type === "result") {
          for (const event of await toolCalls.flush()) yield event;
          const delta = usage.seeTotals(message.modelUsage);
          if (delta) yield { type: "usage", usage: delta };
          if (stopReason !== undefined) break;
          if (message.subtype === "success" && !message.is_error) {
            yield { type: "result", outcome: "success" };
          } else {
            const details = "errors" in message && message.errors.length > 0 ? message.errors.join("; ") : message.subtype;
            yield { type: "result", outcome: "failure", error: this.redact(`Claude couldn't finish: ${details}`) };
          }
          return;
        }
      }
      yield { type: "result", outcome: "failure", error: stopReason ?? "Claude stopped without a result" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "result", outcome: "failure", error: stopReason ?? this.redact(`Claude stopped unexpectedly: ${message}`) };
    } finally {
      clearTimeout(timer);
      task.signal?.removeEventListener("abort", onPlatformAbort);
      abort.abort();
    }
  }

  private async sdkOptions(task: AgentTask, abort: AbortController, toolCalls: ToolCalls): Promise<Options> {
    const conventions = await readFile(path.join(task.worktree, "CLAUDE.md"), "utf8").catch(() => "");
    const confined = confineTo(task.worktree, (toolUseID, reason) => toolCalls.refused(toolUseID, reason));
    return {
      cwd: task.worktree,
      model: task.model,
      abortController: abort,
      tools: [...FILE_TOOLS],
      disallowedTools: [...FORBIDDEN_TOOLS],
      canUseTool: confined.canUseTool,
      // In "default" mode Claude Code allows reads in its working folder without asking `canUseTool`, `.git` included; the hook sees every call.
      hooks: confined.hooks,
      permissionMode: "default",
      // Raw thinking is never returned; summaries are, for the Run's log.
      thinking: { type: "adaptive", display: "summarized" },
      // Nothing from disk: a Prompt could have written `.claude/settings.json` or `.mcp.json` into the Canvas.
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: `${PLATFORM_RULES}\n\n${conventions}` },
      env: { ...process.env, ANTHROPIC_API_KEY: this.options.apiKey },
    };
  }

  private redact(text: string): string {
    return this.options.apiKey ? text.split(this.options.apiKey).join("[redacted]") : text;
  }
}

export const DEFAULT_TIME_LIMIT_SECONDS = 600;
export const DEFAULT_TOKEN_LIMIT = 2_000_000;

/**
 * The Agent the running platform uses: Claude when `ANTHROPIC_API_KEY` is set,
 * otherwise one that fails every Run. Caps come from `RUN_TIME_LIMIT_SECONDS`
 * and `RUN_TOKEN_LIMIT`.
 */
export function agentFromEnvironment(env: NodeJS.ProcessEnv): Agent {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return unavailableAgent;
  return new ClaudeAgent({
    apiKey,
    timeLimitMs: positiveNumberFromEnvironment(env, "RUN_TIME_LIMIT_SECONDS", DEFAULT_TIME_LIMIT_SECONDS) * 1000,
    tokenLimit: positiveNumberFromEnvironment(env, "RUN_TOKEN_LIMIT", DEFAULT_TOKEN_LIMIT),
  });
}

function promptFor(task: AgentTask): string {
  return `A Player sent this Prompt:\n\n${task.instructions}`;
}

/** The parts of an assistant message the Agent cares about; anything else is dropped. */
type Block = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function blocksOf(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): Block[] => {
    const { type, text, thinking, id, name, input } = block as { type?: string; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (type === "text" && typeof text === "string") return [{ type, text }];
    if (type === "thinking" && typeof thinking === "string") return [{ type, thinking }];
    if (type === "tool_use" && typeof id === "string" && typeof name === "string") {
      return [{ type, id, name, input: typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {} }];
    }
    return [];
  });
}

/**
 * Turns Claude's text replies into message events, thinking summaries into
 * thinking events, and file-editing tool calls into progress events with
 * worktree-relative paths. Redacted or empty thinking is left out.
 */
function eventsOf(blocks: Block[], worktree: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text.trim() !== "") events.push({ type: "message", text: block.text });
    if (block.type === "thinking" && block.thinking.trim() !== "") events.push({ type: "thinking", text: block.thinking });
    if (block.type !== "tool_use" || (block.name !== "Write" && block.name !== "Edit") || typeof block.input.file_path !== "string") continue;
    const file = path.relative(worktree, block.input.file_path);
    events.push({ type: "progress", message: `Editing ${file}`, file });
  }
  return events;
}

/** Why a tool call is refused: what Claude is told, and the short reason in the log. */
const REFUSALS = {
  unavailable: { message: (tool: string) => `${tool} isn't available; only file tools are`, reason: "not available" },
  relative: { message: () => "Use an absolute path inside the working directory", reason: "not an absolute path" },
  outside: { message: () => "Only files inside the working directory can be used", reason: "outside the Canvas" },
  git: { message: () => "Only files inside the working directory can be used", reason: "inside the Canvas's history" },
} satisfies Record<string, { message: (tool: string) => string; reason: string }>;

/** The refusal for a tool call, or undefined when it's allowed. */
async function refusalFor(worktree: string, toolName: string, input: Record<string, unknown>): Promise<keyof typeof REFUSALS | undefined> {
  if (!FILE_TOOLS.includes(toolName)) return "unavailable";
  const target = input.file_path ?? input.path;
  if (target === undefined) return undefined;
  if (typeof target !== "string" || !path.isAbsolute(target)) return "relative";
  const where = await locate(worktree, target);
  return where === "inside" ? undefined : where;
}

/**
 * The confinement for every tool call: only file tools, and only on paths
 * inside the worktree (after following symlinks), never in `.git`. Applied
 * twice with the same rules: as a `PreToolUse` hook, which sees every call,
 * and as `canUseTool`, for calls Claude Code asks about. Each refusal is also
 * reported to `onRefused` with a short reason for the log.
 */
export function confineTo(
  worktree: string,
  onRefused?: (toolUseID: string, reason: string) => void,
): { canUseTool: CanUseTool; hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> } {
  const refuse = (toolUseID: string, toolName: string, kind: keyof typeof REFUSALS): string => {
    onRefused?.(toolUseID, REFUSALS[kind].reason);
    return REFUSALS[kind].message(toolName);
  };
  return {
    canUseTool: async (toolName, input, { toolUseID }) => {
      const kind = await refusalFor(worktree, toolName, input);
      if (kind === undefined) return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: refuse(toolUseID, toolName, kind) };
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hookInput) => {
              if (hookInput.hook_event_name !== "PreToolUse") return {};
              const { tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseID } = hookInput;
              const input = typeof toolInput === "object" && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
              const kind = await refusalFor(worktree, toolName, input);
              // Nothing to add when allowed: the call then goes on to Claude Code's own checks and `canUseTool`.
              if (kind === undefined) return {};
              return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refuse(toolUseID, toolName, kind) } };
            },
          ],
        },
      ],
    },
  };
}

async function locate(worktree: string, target: string): Promise<"inside" | "outside" | "git"> {
  const root = await realpath(worktree);
  const resolved = await realpathOfNearest(path.resolve(target));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return "outside";
  return path.relative(root, resolved).split(path.sep).includes(".git") ? "git" : "inside";
}

/**
 * Turns tool calls into one log line each, e.g. "Read index.html" or
 * "Refused: Read /etc/hostname (outside the Canvas)". A call is reported once
 * its result arrives, so a refusal from `confineTo` (hook or `canUseTool`) can be included; calls
 * still waiting when the Run ends are reported then. Never the output.
 */
class ToolCalls {
  private readonly worktree: string;
  private readonly pending = new Map<string, { name: string; input: Record<string, unknown> }>();
  private readonly refusals = new Map<string, string>();

  constructor(worktree: string) {
    this.worktree = worktree;
  }

  called(blocks: Block[]): void {
    for (const block of blocks) {
      if (block.type === "tool_use") this.pending.set(block.id, { name: block.name, input: block.input });
    }
  }

  refused(toolUseID: string, reason: string): void {
    this.refusals.set(toolUseID, reason);
  }

  /** Events for the calls whose results are in `content`, a user message's content. */
  resultsArrived(content: unknown): Promise<AgentEvent[]> {
    return this.report(resultIds(content));
  }

  /** Events for every call still waiting for its result, for when the Run ends. */
  flush(): Promise<AgentEvent[]> {
    return this.report([...this.pending.keys()]);
  }

  private async report(ids: string[]): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for (const id of ids) {
      const call = this.pending.get(id);
      if (!call) continue;
      this.pending.delete(id);
      const description = await this.describe(call.name, call.input);
      const reason = this.refusals.get(id);
      events.push({ type: "tool", text: reason === undefined ? description : `Refused: ${description} (${reason})` });
    }
    return events;
  }

  private async describe(name: string, input: Record<string, unknown>): Promise<string> {
    const { file_path: file, pattern, path: dir } = input;
    const within = typeof dir === "string" && path.resolve(this.worktree, dir) !== path.resolve(this.worktree) ? ` in ${await this.folder(dir)}` : "";
    if (name === "Glob" && typeof pattern === "string") return `Glob ${pattern}${within}`;
    if (name === "Grep" && typeof pattern === "string") return `Grep '${pattern}'${within}`;
    if (typeof file === "string") return `${name} ${this.relative(file)}`;
    return name;
  }

  /** A worktree-relative path, or the path as given when it isn't inside the worktree. */
  private relative(target: string): string {
    if (!path.isAbsolute(target)) return target;
    const relative = path.relative(this.worktree, target);
    return relative.startsWith("..") || path.isAbsolute(relative) ? target : relative;
  }

  /** Like `relative`, with a trailing slash when it's a folder. */
  private async folder(target: string): Promise<string> {
    const isFolder = await stat(path.resolve(this.worktree, target)).then((s) => s.isDirectory(), () => false);
    return this.relative(target) + (isFolder ? "/" : "");
  }
}

function resultIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const { type, tool_use_id: id } = block as { type?: string; tool_use_id?: unknown };
    return type === "tool_result" && typeof id === "string" ? [id] : [];
  });
}

/** The real path of `target`, following symlinks in whatever part of it exists. */
async function realpathOfNearest(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  while (true) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Turns the SDK's per-message usage into incremental usage events, with fresh
 * input, cache reads, cache writes and output kept apart. A message can
 * arrive in several parts with growing usage, so each id's latest usage
 * counts once; the final per-model totals then top up anything missed.
 */
class UsageTracker {
  private readonly perMessage = new Map<string, UsageCounts>();
  private readonly reported: UsageCounts = zeroUsage();

  seeMessage(id: string, usage: Record<string, number | undefined> | undefined): TokenUsage | undefined {
    if (!usage) return undefined;
    const latest: UsageCounts = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    };
    const previous = this.perMessage.get(id) ?? zeroUsage();
    this.perMessage.set(id, combine(previous, latest, Math.max));
    return this.report(combine(latest, previous, (a, b) => Math.max(0, a - b)));
  }

  seeTotals(modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>): TokenUsage | undefined {
    const totals = zeroUsage();
    for (const usage of Object.values(modelUsage ?? {})) {
      addUsage(totals, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadInputTokens, cacheWriteTokens: usage.cacheCreationInputTokens });
    }
    return this.report(combine(totals, this.reported, (a, b) => Math.max(0, a - b)));
  }

  /** Every token so far, of all four kinds. */
  total(): number {
    return USAGE_KINDS.reduce((sum, kind) => sum + this.reported[kind], 0);
  }

  private report(delta: UsageCounts): TokenUsage | undefined {
    if (USAGE_KINDS.every((kind) => delta[kind] === 0)) return undefined;
    addUsage(this.reported, delta);
    return delta;
  }
}

function combine(a: UsageCounts, b: UsageCounts, f: (a: number, b: number) => number): UsageCounts {
  return Object.fromEntries(USAGE_KINDS.map((kind) => [kind, f(a[kind], b[kind])])) as UsageCounts;
}
