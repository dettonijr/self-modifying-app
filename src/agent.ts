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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AgentEvent =
  /** Something worth showing a Player, e.g. a file being edited. */
  | { type: "progress"; message: string; file?: string }
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
