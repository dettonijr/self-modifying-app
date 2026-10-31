import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_MODEL, MODELS, type Agent, type Model } from "./agent.ts";
import type { CanvasRepository, Worktree } from "./canvas-repository.ts";
import type { Lander, LandResult } from "./lander.ts";

export const MAX_PROMPT_LENGTH = 500;
export const MAX_NICKNAME_LENGTH = 40;

/**
 * How many Runs may be in progress at once. Prompts beyond this wait in the
 * queue. The only place this limit lives (ticket 06 raises it).
 */
export const MAX_PARALLEL_RUNS = 1;

/** `waiting → running → landing → landed`, or `rejected` if the Agent fails or nothing Lands. */
export type RunState = "waiting" | "running" | "landing" | "landed" | "rejected";

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
  /** What the Agent has reported so far, oldest first (the latest `MAX_PROGRESS_EVENTS`). */
  progress: RunProgress[];
}

export interface RunProgress {
  message: string;
  file?: string;
}

/** What Console clients are told, live. */
export type RunsEvent =
  /** The waiting Prompts, oldest first, whenever they change. */
  | { type: "queue"; queue: RunView[] }
  /** A Run changed state (including joining the queue). */
  | { type: "run"; run: RunView }
  /** The Agent reported progress on a Run. */
  | ({ type: "progress"; runId: string } & RunProgress);

/** What a Console client needs on connecting: the queue, and Runs in progress or recently finished, oldest first. */
export interface RunsSnapshot {
  queue: RunView[];
  runs: RunView[];
}

const MAX_PROGRESS_EVENTS = 50;
const MAX_RECENT_RUNS = 20;

export interface PromptRequest {
  nickname: unknown;
  prompt: unknown;
  model?: unknown;
}

export class PromptRefused extends Error {
  /** `invalid`: the request breaks a rule. `already-waiting`: the Player already has a Prompt in the queue. */
  readonly reason: "invalid" | "already-waiting";
  constructor(reason: "invalid" | "already-waiting", message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Turns Prompts into Runs and drives each Run's lifecycle: a worktree branched
 * from `main`, the Agent editing it, then the Lander. The worktree is removed
 * whatever happens. Prompts wait in a queue, oldest first, until one of the
 * `MAX_PARALLEL_RUNS` slots is free.
 */
export class Runs {
  private readonly repo: CanvasRepository;
  private readonly agent: Agent;
  private readonly lander: Lander;
  private readonly worktreesDir: string;
  private readonly runs = new Map<string, RunView>();
  private readonly queue: RunView[] = [];
  /** Runs that have left the queue, oldest first, capped at `MAX_RECENT_RUNS` finished ones. */
  private readonly recent: RunView[] = [];
  private readonly listeners = new Set<(event: RunsEvent) => void>();
  private closed = false;
  private readonly inProgress = new Map<string, { abort: AbortController; done: Promise<void> }>();

  constructor(options: { repo: CanvasRepository; agent: Agent; lander: Lander; worktreesDir: string }) {
    this.repo = options.repo;
    this.agent = options.agent;
    this.lander = options.lander;
    this.worktreesDir = options.worktreesDir;
  }

  /** Validates a Prompt and queues its Run, or throws `PromptRefused`. Each Player (nickname) may have one Prompt waiting. */
  start(request: PromptRequest): RunView {
    const { nickname, prompt, model } = validate(request);
    if (this.queue.some((waiting) => waiting.nickname === nickname)) {
      throw new PromptRefused("already-waiting", "You already have a Prompt waiting; you can send another once it starts running");
    }
    const run: RunView = { id: randomUUID(), state: "waiting", nickname, prompt, model, progress: [] };
    this.runs.set(run.id, run);
    this.queue.push(run);
    const view = copy(run);
    this.publish({ type: "run", run: copy(run) });
    this.publishQueue();
    this.startWaitingRuns();
    return view;
  }

  get(id: string): RunView | undefined {
    const run = this.runs.get(id);
    return run && copy(run);
  }

  snapshot(): RunsSnapshot {
    return { queue: this.queue.map(copy), runs: this.recent.map(copy) };
  }

  /** Calls `listener` with every event from now on; returns a function that stops it. */
  subscribe(listener: (event: RunsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drops the queue, aborts Runs in progress and waits for them to clean up. */
  async close(): Promise<void> {
    this.closed = true;
    this.queue.length = 0;
    const all = [...this.inProgress.values()];
    for (const { abort } of all) abort.abort();
    await Promise.all(all.map(({ done }) => done));
  }

  private startWaitingRuns(): void {
    let started = false;
    while (!this.closed && this.inProgress.size < MAX_PARALLEL_RUNS && this.queue.length > 0) {
      const run = this.queue.shift()!;
      started = true;
      this.recent.push(run);
      this.setState(run, "running");
      const abort = new AbortController();
      const done = this.execute(run, abort.signal);
      this.inProgress.set(run.id, { abort, done });
    }
    if (started) this.publishQueue();
  }

  private setState(run: RunView, state: RunState): void {
    run.state = state;
    this.publish({ type: "run", run: copy(run) });
  }

  private publishQueue(): void {
    this.publish({ type: "queue", queue: this.queue.map(copy) });
  }

  private publish(event: RunsEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("A Runs listener failed", error);
      }
    }
  }

  /** Drops the oldest finished Runs beyond `MAX_RECENT_RUNS`. */
  private forgetOldRuns(): void {
    let finished = this.recent.filter((run) => run.state === "landed" || run.state === "rejected").length;
    for (let i = 0; i < this.recent.length && finished > MAX_RECENT_RUNS; ) {
      const run = this.recent[i];
      if (run.state === "landed" || run.state === "rejected") {
        this.recent.splice(i, 1);
        finished--;
      } else i++;
    }
  }

  private async execute(run: RunView, signal: AbortSignal): Promise<void> {
    const outcome = await this.workAndLand(run, signal);
    // Only now, with the worktree gone, does the Run count as finished.
    this.inProgress.delete(run.id);
    if (outcome.landed) {
      run.commit = outcome.commit;
      this.setState(run, "landed");
    } else {
      run.error = outcome.reason;
      this.setState(run, "rejected");
    }
    this.forgetOldRuns();
    this.startWaitingRuns();
  }

  /** Lets the Agent edit a fresh worktree, Lands the result and removes the worktree, whatever happens. */
  private async workAndLand(run: RunView, signal: AbortSignal): Promise<LandResult> {
    let worktree: Worktree | undefined;
    try {
      worktree = await this.repo.createWorktree(path.join(this.worktreesDir, run.id), `run/${run.id}`);
      const failure = await this.runAgent(run, worktree, signal);
      if (failure !== undefined) return { landed: false, reason: failure };
      this.setState(run, "landing");
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
      if (event.type === "progress") {
        const progress: RunProgress = event.file === undefined ? { message: event.message } : { message: event.message, file: event.file };
        run.progress.push(progress);
        if (run.progress.length > MAX_PROGRESS_EVENTS) run.progress.shift();
        this.publish({ type: "progress", runId: run.id, ...progress });
      }
      if (event.type === "result") return event.outcome === "failure" ? event.error : undefined;
    }
    return "The Agent stopped without a result";
  }
}

function copy(run: RunView): RunView {
  return { ...run, progress: run.progress.map((progress) => ({ ...progress })) };
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
