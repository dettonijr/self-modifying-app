import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_MODEL, MODELS, type Agent, type Model } from "./agent.ts";
import type { CanvasRepository, Worktree } from "./canvas-repository.ts";
import type { Lander, LandResult } from "./lander.ts";

export const MAX_PROMPT_LENGTH = 500;
export const MAX_NICKNAME_LENGTH = 40;

/** `running → landing → landed`, or `rejected` if the Agent fails or nothing Lands. */
export type RunState = "running" | "landing" | "landed" | "rejected";

export interface RunView {
  id: string;
  state: RunState;
  nickname: string;
  prompt: string;
  model: Model;
  /** Why the Run was rejected. */
  error?: string;
  /** The commit that Landed. */
  commit?: string;
}

export interface PromptRequest {
  nickname: unknown;
  prompt: unknown;
  model?: unknown;
}

export class PromptRefused extends Error {
  /** `invalid`: the request breaks a rule. `busy`: another Run is in progress. */
  readonly reason: "invalid" | "busy";
  constructor(reason: "invalid" | "busy", message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Turns Prompts into Runs and drives each Run's lifecycle: a worktree branched
 * from `main`, the Agent editing it, then the Lander. The worktree is removed
 * whatever happens. Only one Run happens at a time for now.
 */
export class Runs {
  private readonly repo: CanvasRepository;
  private readonly agent: Agent;
  private readonly lander: Lander;
  private readonly worktreesDir: string;
  private readonly runs = new Map<string, RunView>();
  private readonly inProgress = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly listeners = new Set<(run: RunView) => void>();

  constructor(options: { repo: CanvasRepository; agent: Agent; lander: Lander; worktreesDir: string }) {
    this.repo = options.repo;
    this.agent = options.agent;
    this.lander = options.lander;
    this.worktreesDir = options.worktreesDir;
  }

  /** Validates a Prompt and starts its Run, or throws `PromptRefused`. */
  start(request: PromptRequest): RunView {
    const { nickname, prompt, model } = validate(request);
    if (this.inProgress.size > 0) throw new PromptRefused("busy", "Another Run is in progress; try again when it's done");
    const run: RunView = { id: randomUUID(), state: "running", nickname, prompt, model };
    this.runs.set(run.id, run);
    const abort = new AbortController();
    const done = this.execute(run, abort.signal);
    this.inProgress.set(run.id, { abort, done });
    this.changed(run);
    return { ...run };
  }

  /** Calls `listener` with a Run each time one starts or changes state. Returns a function that stops it. */
  onChange(listener: (run: RunView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs that haven't finished yet. */
  inProgressRuns(): RunView[] {
    return [...this.inProgress.keys()].flatMap((id) => this.get(id) ?? []);
  }

  get(id: string): RunView | undefined {
    const run = this.runs.get(id);
    return run && { ...run };
  }

  /** Aborts Runs in progress and waits for them to clean up. */
  async close(): Promise<void> {
    const all = [...this.inProgress.values()];
    for (const { abort } of all) abort.abort();
    await Promise.all(all.map(({ done }) => done));
  }

  private async execute(run: RunView, signal: AbortSignal): Promise<void> {
    const outcome = await this.workAndLand(run, signal);
    // Only now, with the worktree gone, does the Run count as finished.
    this.inProgress.delete(run.id);
    if (outcome.landed) {
      run.state = "landed";
      run.commit = outcome.commit;
    } else {
      run.state = "rejected";
      run.error = outcome.reason;
    }
    this.changed(run);
  }

  private changed(run: RunView): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...run });
      } catch (error) {
        console.error("A Run listener failed", error);
      }
    }
  }

  /** Lets the Agent edit a fresh worktree, Lands the result and removes the worktree, whatever happens. */
  private async workAndLand(run: RunView, signal: AbortSignal): Promise<LandResult> {
    let worktree: Worktree | undefined;
    try {
      worktree = await this.repo.createWorktree(path.join(this.worktreesDir, run.id), `run/${run.id}`);
      const failure = await this.runAgent(run, worktree, signal);
      if (failure !== undefined) return { landed: false, reason: failure };
      run.state = "landing";
      this.changed(run);
      return await this.lander.land(worktree, { kind: "Prompt", nickname: run.nickname, prompt: run.prompt, model: run.model });
    } catch (error) {
      console.error(`Run ${run.id} failed`, error);
      return { landed: false, reason: "Something went wrong on the platform" };
    } finally {
      if (worktree) await this.repo.removeWorktree(worktree).catch((error) => console.error("Couldn't remove a worktree", error));
    }
  }

  /** Lets the Agent work in the worktree; returns why it failed, if it did. */
  private async runAgent(run: RunView, worktree: Worktree, signal: AbortSignal): Promise<string | undefined> {
    const events = this.agent.run({ worktree: worktree.dir, instructions: run.prompt, model: run.model, signal });
    for await (const event of events) {
      if (event.type === "result") return event.outcome === "failure" ? event.error : undefined;
    }
    return "The Agent stopped without a result";
  }
}

function validate(request: PromptRequest): { nickname: string; prompt: string; model: Model } {
  const nickname = validNickname(request.nickname);
  if (nickname === undefined) throw new PromptRefused("invalid", "Pick a nickname first");
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") throw new PromptRefused("invalid", "The Prompt is empty");
  if (request.prompt.length > MAX_PROMPT_LENGTH) {
    throw new PromptRefused("invalid", `Prompts are limited to ${MAX_PROMPT_LENGTH} characters`);
  }
  const model = request.model ?? DEFAULT_MODEL;
  if (!MODELS.includes(model as Model)) throw new PromptRefused("invalid", `The model must be one of ${MODELS.join(", ")}`);
  return { nickname, prompt: request.prompt.trim(), model: model as Model };
}

/** A nickname is 1–40 characters on one line, with surrounding spaces trimmed. */
export function validNickname(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const nickname = value.trim();
  if (nickname === "" || nickname.length > MAX_NICKNAME_LENGTH || /\p{Cc}/u.test(nickname)) return undefined;
  return nickname;
}
