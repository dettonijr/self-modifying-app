import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { query as sdkQuery, type CanUseTool, type Options, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { unavailableAgent, type Agent, type AgentEvent, type AgentTask, type TokenUsage } from "./agent.ts";
import { positiveNumberFromEnvironment } from "./environment.ts";

/** The one call into the Claude Agent SDK; tests substitute a scripted stream. */
export type ClaudeQuery = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeAgentOptions {
  /** The host's Anthropic API key. Only ever handed to Claude's own process. */
  apiKey: string;
  /** A Run still working after this long is stopped and fails. */
  timeLimitMs: number;
  /** A Run that uses more tokens than this (input, cached input and output) is stopped and fails. */
  tokenLimit: number;
  query?: ClaudeQuery;
}

/** The only tools Claude gets: reading and editing files, all confined to the worktree. */
const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];
/** Belt and braces: refused even if some default would offer them. */
const FORBIDDEN_TOOLS = ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch", "Agent", "Task", "NotebookEdit", "Skill", "Workflow"];

const PLATFORM_RULES = `You are editing the Canvas, a website shared by the Players of a game, in your current working directory.
Players send Prompts; do what the Prompt asks by editing files there.
You can only read and edit files inside the working directory: there is no shell and no network access.
Make the change and stop; don't ask questions, nobody will answer them.`;

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
    try {
      const options = await this.sdkOptions(task, abort);
      for await (const message of this.query({ prompt: promptFor(task), options })) {
        if (message.type === "assistant") {
          for (const event of eventsOf(message.message.content as unknown[], task.worktree)) yield event;
          const delta = usage.seeMessage(message.message.id, message.message.usage as unknown as Record<string, number | undefined>);
          if (delta) yield { type: "usage", usage: delta };
          if (usage.total() > this.options.tokenLimit) stop(`The Run went over its limit of ${this.options.tokenLimit} tokens`);
          if (stopReason !== undefined) break;
        } else if (message.type === "result") {
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

  private async sdkOptions(task: AgentTask, abort: AbortController): Promise<Options> {
    const conventions = await readFile(path.join(task.worktree, "CLAUDE.md"), "utf8").catch(() => "");
    return {
      cwd: task.worktree,
      model: task.model,
      abortController: abort,
      tools: [...FILE_TOOLS],
      disallowedTools: [...FORBIDDEN_TOOLS],
      canUseTool: confineTo(task.worktree),
      permissionMode: "default",
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

/**
 * Turns Claude's text replies into message events, and file-editing tool calls
 * into progress events with worktree-relative paths. Hidden reasoning and other
 * tool calls are left out.
 */
function eventsOf(content: unknown[], worktree: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const block of content) {
    const { type, name, input, text } = block as { type?: string; name?: string; input?: { file_path?: unknown }; text?: unknown };
    if (type === "text" && typeof text === "string" && text.trim() !== "") events.push({ type: "message", text });
    if (type !== "tool_use" || (name !== "Write" && name !== "Edit") || typeof input?.file_path !== "string") continue;
    const file = path.relative(worktree, input.file_path);
    events.push({ type: "progress", message: `Editing ${file}`, file });
  }
  return events;
}

/**
 * Permission check for every tool call: only file tools, and only on paths
 * inside the worktree (after following symlinks), never in `.git`.
 */
export function confineTo(worktree: string): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (!FILE_TOOLS.includes(toolName)) return { behavior: "deny", message: `${toolName} isn't available; only file tools are` };
    const target = input.file_path ?? input.path;
    if (target === undefined) return { behavior: "allow", updatedInput: input };
    if (typeof target !== "string" || !path.isAbsolute(target)) return { behavior: "deny", message: "Use an absolute path inside the working directory" };
    if (!(await isInside(worktree, target))) return { behavior: "deny", message: "Only files inside the working directory can be used" };
    return { behavior: "allow", updatedInput: input };
  };
}

async function isInside(worktree: string, target: string): Promise<boolean> {
  const root = await realpath(worktree);
  const resolved = await realpathOfNearest(path.resolve(target));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;
  return !path.relative(root, resolved).split(path.sep).includes(".git");
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
 * Turns the SDK's per-message usage into incremental usage events. A message
 * can arrive in several parts with growing usage, so each id's latest usage
 * counts once; the final per-model totals then top up anything missed.
 */
class UsageTracker {
  private readonly perMessage = new Map<string, TokenUsage>();
  private readonly reported: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  seeMessage(id: string, usage: Record<string, number | undefined> | undefined): TokenUsage | undefined {
    if (!usage) return undefined;
    const latest = {
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
    };
    const previous = this.perMessage.get(id) ?? { inputTokens: 0, outputTokens: 0 };
    this.perMessage.set(id, { inputTokens: Math.max(previous.inputTokens, latest.inputTokens), outputTokens: Math.max(previous.outputTokens, latest.outputTokens) });
    return this.report(Math.max(0, latest.inputTokens - previous.inputTokens), Math.max(0, latest.outputTokens - previous.outputTokens));
  }

  seeTotals(modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>): TokenUsage | undefined {
    let input = 0;
    let output = 0;
    for (const usage of Object.values(modelUsage ?? {})) {
      input += usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
      output += usage.outputTokens;
    }
    return this.report(Math.max(0, input - this.reported.inputTokens), Math.max(0, output - this.reported.outputTokens));
  }

  total(): number {
    return this.reported.inputTokens + this.reported.outputTokens;
  }

  private report(inputTokens: number, outputTokens: number): TokenUsage | undefined {
    if (inputTokens === 0 && outputTokens === 0) return undefined;
    this.reported.inputTokens += inputTokens;
    this.reported.outputTokens += outputTokens;
    return { inputTokens, outputTokens };
  }
}
