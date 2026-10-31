/**
 * The Agent is the single interface that hides Claude from the rest of the
 * platform. The real implementation (Claude Agent SDK) arrives in ticket 03;
 * tests substitute the scripted fake in `test/support/fake-agent.ts`.
 *
 * An Agent works on one worktree: it edits files there and reports what it is
 * doing as a stream of events, which always ends with exactly one `result`.
 */

export const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5"] as const;
export type Model = (typeof MODELS)[number];
export const DEFAULT_MODEL: Model = "claude-sonnet-5-5";

export interface AgentTask {
  /** Absolute path of the Run's worktree; the Agent may only edit files here. */
  worktree: string;
  /** Everything Claude is asked to do: the Prompt plus any platform context. */
  instructions: string;
  model: Model;
  /** Aborted when the platform gives up on the Run (time cap, shutdown). */
  signal?: AbortSignal;
}

/** Tokens by kind, each priced at its own rate. The cache counts are 0 when absent. */
export interface TokenUsage {
  /** Fresh input: not read from or written to the prompt cache. */
  inputTokens: number;
  outputTokens: number;
  /** Input read from the prompt cache. */
  cacheReadTokens?: number;
  /** Input written to the prompt cache. */
  cacheWriteTokens?: number;
}

/** All four token counts, none optional. */
export type UsageCounts = Required<TokenUsage>;

export const USAGE_KINDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const satisfies ReadonlyArray<keyof UsageCounts>;

export const zeroUsage = (): UsageCounts => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** Adds `usage` into `sum` (absent cache counts are 0) and returns `sum`. */
export function addUsage<T extends UsageCounts>(sum: T, usage: TokenUsage): T {
  sum.inputTokens += usage.inputTokens;
  sum.outputTokens += usage.outputTokens;
  sum.cacheReadTokens += usage.cacheReadTokens ?? 0;
  sum.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  return sum;
}

export type AgentEvent =
  /** Something worth showing a Player, e.g. a file being edited. */
  | { type: "progress"; message: string; file?: string }
  /** A piece of Claude's own text reply, for the Run's log. Never tool calls, tool results or thinking. */
  | { type: "message"; text: string }
  /** A summary of Claude's thinking, for the Run's log. */
  | { type: "thinking"; text: string }
  /** One tool call, e.g. "Read index.html" or "Refused: Read /etc/hostname (outside the Canvas)", for the Run's log. Never its output. */
  | { type: "tool"; text: string }
  /** Tokens consumed since the previous usage event (incremental). */
  | { type: "usage"; usage: TokenUsage }
  /** The final event. */
  | { type: "result"; outcome: "success" }
  | { type: "result"; outcome: "failure"; error: string };

export interface Agent {
  run(task: AgentTask): AsyncIterable<AgentEvent>;
}

/** Stand-in until the real Claude Agent exists: every Run fails. */
export const unavailableAgent: Agent = {
  async *run() {
    yield { type: "result", outcome: "failure", error: "No Agent is configured" };
  },
};
