import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MODEL, MODELS, type Agent, type Model, type TokenUsage } from "./agent.ts";
import type { CanvasRepository, ChangeKind, ChangeMetadata, LandedChange, OriginalChange, Worktree } from "./canvas-repository.ts";
import type { Lander, LandResult, LandStep } from "./lander.ts";
import { rulesFor } from "./change-kinds.ts";
import { COLLIDED_MESSAGE, hasConflictMarkers, MAX_RESOLUTION_ATTEMPTS, RESOLUTION_MODEL, resolutionInstructions, type ResolutionProblem } from "./resolution.ts";
import { DEFAULT_MAX_PARALLEL_RUNS } from "./parallel-limit.ts";
import { costOf } from "./pricing.ts";
import { isFinished, type RunStore } from "./run-store.ts";

export const MAX_PROMPT_LENGTH = 500;
export const MAX_NICKNAME_LENGTH = 40;

/**
 * `waiting → running → landing → landed`. If Landing conflicts or fails the
 * render check, the Run goes `resolving → landing` up to twice, then
 * `restarted → landing` once. It ends `rejected` if the Agent fails, nothing
 * Lands, or the restart fails too.
 */
export type RunState = "waiting" | "running" | "landing" | "resolving" | "restarted" | "landed" | "rejected";

export interface RunView {
  id: string;
  state: RunState;
  nickname: string;
  prompt: string;
  model: Model;
  /** What kind of change the Run makes; a Player's own Prompt if absent. */
  kind?: ChangeKind;
  /** The earlier change a Replay re-applies or a Rollback rolls back; `prompt` is that change's Prompt. */
  original?: OriginalChange;
  /** Why the Run was rejected. */
  error?: string;
  /** The commit that Landed. */
  commit?: string;
  /**
   * When the Prompt was sent, as an ISO 8601 timestamp. For a Landed change
   * with no Run record, when it Landed. Absent for Runs saved before times
   * were recorded that never Landed.
   */
  time?: string;
  /** What the Agent has reported so far, oldest first (the latest `MAX_PROGRESS_EVENTS`). */
  progress: RunProgress[];
  /** The files the Agent has edited so far, from its progress events, in the order first edited. Saved with the Run. */
  editing?: string[];
  /**
   * The change a rejected Run last tried to make, as a unified diff, saved
   * before its worktree is removed. Empty if it changed nothing.
   */
  attempted?: string;
  /** What Claude said and what the platform did, oldest first. Every entry is kept, with no limit. */
  log: LogEntry[];
  /**
   * Every token the Run's Agent calls used, per model, including conflict
   * fixes and start-overs. Saved with the Run. Absent for Runs from before
   * usage was recorded.
   */
  usageByModel?: UsageByModel;
  /** The totals of `usageByModel` and their estimated cost, worked out whenever the Run is read. Never saved. */
  usage?: RunUsage;
}

export type UsageByModel = Partial<Record<Model, Required<TokenUsage>>>;

/** A Run's tokens of each kind, over every model, and their estimated cost in US dollars, each model priced at its own rates. */
export interface RunUsage extends Required<TokenUsage> {
  cost: number;
}

/** One line of a Run's log. */
export interface LogEntry {
  /** When it happened, as an ISO 8601 timestamp. */
  time: string;
  source: "claude" | "platform";
  text: string;
}

/**
 * What the Prompts list shows about a Run: everything but its progress and
 * the files it's editing, its log and its attempted change, which only the
 * Run's own endpoint serves.
 */
export type RunSummary = Omit<RunView, "progress" | "editing" | "log" | "attempted" | "usageByModel">;

export interface RunProgress {
  message: string;
  file?: string;
}

/** What Console clients are told, live. */
export type RunsEvent =
  /** The waiting Prompts, oldest first, whenever they change. */
  | { type: "queue"; queue: RunSummary[] }
  /** A Run changed state (including joining the queue): its Prompts list entry, replacing the one with the same id. */
  | { type: "run"; run: RunSummary }
  /** The Agent reported progress on a Run. */
  | ({ type: "progress"; runId: string } & RunProgress)
  /** The files a Run in progress is editing changed: all of them, in the order first edited. */
  | { type: "files"; runId: string; files: string[] }
  /** A new entry at the end of a Run's log. */
  | { type: "log"; runId: string; entry: LogEntry };

/** What a Console client needs on connecting: the queue, oldest first, and the Prompts list. */
export interface RunsSnapshot {
  queue: RunSummary[];
  /** Every Run, newest first (see `Runs.list()`). */
  runs: RunSummary[];
}

const MAX_PROGRESS_EVENTS = 50;

/** What the log says as each step of Landing begins. */
const LAND_STEP_TEXT: Record<LandStep, string> = {
  rebasing: "Rebasing onto the latest Canvas",
  "render-check": "Checking that the Canvas renders",
};
export const RESTARTED_LOG_TEXT = "Platform restarted, starting over";
/**
 * While Prompts are waiting, how often to check whether the host raised the
 * parallel Run limit. `set-parallel-runs` only writes a file, so nothing
 * tells the platform.
 */
const WAITING_RECHECK_MS = 500;

export interface PromptRequest {
  nickname: unknown;
  prompt: unknown;
  model?: unknown;
}

/** Roll back the change that Landed as `commit`, keeping what Landed after it. */
export interface RollbackRequest {
  nickname: unknown;
  commit: unknown;
}

/** A Replay: send the Prompt of the change that Landed as `commit` again. */
export interface ReplayRequest {
  nickname: unknown;
  commit: unknown;
  model?: unknown;
}

export class ChangeRefused extends Error {
  /**
   * `invalid`: the request breaks a rule. `already-waiting`: the Player already has a Prompt in the queue.
   * `not-found`: no such change in the history.
   */
  readonly reason: "invalid" | "already-waiting" | "not-found";
  constructor(reason: ChangeRefused["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Turns Prompts into Runs and drives each Run's lifecycle: a worktree branched
 * from `main`, the Agent editing it, then the Lander. The worktree is removed
 * whatever happens. Prompts wait in a queue, oldest first, until one of the
 * `maxParallelRuns` slots is free. Every Run is saved in the `RunStore`, and
 * `resume()` picks up where the last platform left off.
 */
export class Runs {
  private readonly repo: CanvasRepository;
  private readonly agent: Agent;
  private readonly lander: Lander;
  private readonly store: RunStore;
  private readonly worktreesDir: string;
  /** The parallel Run limit in force, read each time waiting Prompts might start. */
  private readonly maxParallelRuns: () => number;
  /**
   * Every Run, in the order it was sent, kept forever. Landed changes with no
   * Run record come first: they're from before Runs were saved.
   */
  private readonly runs = new Map<string, RunView>();
  private readonly queue: RunView[] = [];
  /**
   * Runs that were in progress when the platform last stopped, oldest first.
   * They start before waiting Prompts, within the limit: they were already
   * let in.
   */
  private readonly resuming: RunView[] = [];
  private readonly listeners = new Set<(event: RunsEvent) => void>();
  private closed = false;
  private readonly inProgress = new Map<string, { abort: AbortController; done: Promise<void> }>();
  /** Set while Prompts are waiting, to start them if the host raises the limit. */
  private waitingRecheck: NodeJS.Timeout | undefined;

  constructor(options: { repo: CanvasRepository; agent: Agent; lander: Lander; store: RunStore; worktreesDir: string; maxParallelRuns?: number | (() => number) }) {
    this.repo = options.repo;
    this.agent = options.agent;
    this.lander = options.lander;
    this.store = options.store;
    this.worktreesDir = options.worktreesDir;
    const limit = options.maxParallelRuns ?? DEFAULT_MAX_PARALLEL_RUNS;
    this.maxParallelRuns = typeof limit === "number" ? () => limit : limit;
  }

  /** Validates a Prompt and queues its Run, or throws `ChangeRefused`. Each Player (nickname) may have one Prompt waiting. */
  start(request: PromptRequest): RunView {
    const { nickname, prompt, model } = validate(request);
    return this.enqueue({ id: randomUUID(), state: "waiting", nickname, prompt, model, time: now(), progress: [], log: [], usageByModel: {} });
  }

  /**
   * Queues a Replay of a change in the history, or throws `ChangeRefused`. It
   * follows the same rules as a Prompt, including the one waiting slot.
   */
  replay(request: ReplayRequest): Promise<RunView> {
    return this.enqueueAbout("Replay", request);
  }

  /**
   * Queues a Rollback of a change in the history, or throws `ChangeRefused`.
   * It follows the same rules as a Prompt, including the one waiting slot.
   */
  rollback(request: RollbackRequest): Promise<RunView> {
    return this.enqueueAbout("Rollback", request);
  }

  /** Queues a Run of `kind` about the change that Landed as `request.commit`, with that change's Prompt. */
  private async enqueueAbout(kind: "Replay" | "Rollback", request: { nickname: unknown; commit: unknown; model?: unknown }): Promise<RunView> {
    const nickname = validNickname(request.nickname);
    if (nickname === undefined) throw new ChangeRefused("invalid", "Pick a nickname first");
    const model = rulesFor({ kind }).playerPicksModel ? validModel(request.model) : DEFAULT_MODEL;
    const original = typeof request.commit === "string" ? await this.repo.landedChange(request.commit) : undefined;
    if (original === undefined) throw new ChangeRefused("not-found", "There's no such change in the history");
    return this.enqueue({
      id: randomUUID(),
      state: "waiting",
      nickname,
      prompt: original.prompt,
      model,
      kind,
      original: { commit: original.commit, nickname: original.nickname },
      time: now(),
      progress: [],
      log: [],
      usageByModel: {},
    });
  }

  /** Queues a new Run, unless its Player already has one waiting. */
  private enqueue(run: RunView): RunView {
    if (this.queue.some((waiting) => waiting.nickname === run.nickname)) {
      throw new ChangeRefused("already-waiting", "You already have a Prompt waiting; you can send another once it starts running");
    }
    this.runs.set(run.id, run);
    this.queue.push(run);
    this.store.save(run);
    this.publish({ type: "run", run: summary(run) });
    this.log(run, "platform", "Queued");
    const view = copy(run);
    this.publishQueue();
    this.startWaitingRuns();
    return view;
  }

  /**
   * Picks up every saved Run after a restart. Leftover worktrees are removed;
   * Runs that were in progress start again from scratch on the latest `main`,
   * ahead of the queue; waiting Prompts are queued again in the same
   * order. Landed changes on `main` with no Run record are listed as Landed
   * Runs, older than every saved one.
   */
  async resume(): Promise<void> {
    await this.removeLeftoverWorktrees();
    const saved = this.store.all();
    const history = (await this.repo.history()).reverse();
    const ids = new Set(saved.map((run) => run.id));
    const commits = new Set(saved.flatMap((run) => (run.commit ? [run.commit] : [])));
    for (const change of history) {
      if ((change.run !== undefined && ids.has(change.run)) || commits.has(change.commit)) continue;
      const run = unrecordedRun(change);
      this.runs.set(run.id, run);
    }
    // A Run can have Landed just before the platform stopped, without being saved as Landed.
    const landed = new Map(history.flatMap((change) => (change.run ? [[change.run, change] as const] : [])));
    for (const record of saved) {
      const run: RunView = { ...record, progress: [], log: record.log ?? [] };
      this.runs.set(run.id, run);
      if (isFinished(run.state)) {
        if (run.time === undefined && run.commit !== undefined) run.time = history.find((change) => change.commit === run.commit)?.time;
        continue;
      }
      const change = landed.get(run.id);
      if (change !== undefined) {
        run.commit = change.commit;
        this.setState(run, "landed");
        this.log(run, "platform", "Landed");
      } else if (run.state === "waiting") this.queue.push(run);
      else {
        this.log(run, "platform", RESTARTED_LOG_TEXT);
        this.resuming.push(run);
      }
    }
    this.startWaitingRuns();
  }

  /** A Run by its id, or else the Run that Landed as commit `id` (as a Replay or Rollback refers to its original). */
  get(id: string): RunView | undefined {
    const run = this.runs.get(id) ?? [...this.runs.values()].find((candidate) => candidate.commit === id);
    return run && copy(run);
  }

  /** The Prompts list: every Run ever sent, whatever its kind or state, newest first. */
  list(): RunSummary[] {
    return [...this.runs.values()].reverse().map(summary);
  }

  snapshot(): RunsSnapshot {
    return { queue: this.queue.map(summary), runs: this.list() };
  }

  /** Calls `listener` with every event from now on; returns a function that stops it. */
  subscribe(listener: (event: RunsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls `listener` with a Run each time one joins the queue or changes state. Returns a function that stops it. */
  onChange(listener: (run: RunSummary) => void): () => void {
    return this.subscribe((event) => {
      if (event.type === "run") listener(event.run);
    });
  }

  /** Runs that have started but haven't finished yet. */
  inProgressRuns(): RunView[] {
    return [...this.inProgress.keys()].flatMap((id) => this.get(id) ?? []);
  }

  /** Drops the queue, aborts Runs in progress and waits for them to clean up. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.waitingRecheck);
    this.queue.length = 0;
    this.resuming.length = 0;
    const all = [...this.inProgress.values()];
    for (const { abort } of all) abort.abort();
    await Promise.all(all.map(({ done }) => done));
  }

  /**
   * Starts waiting Prompts, oldest first, while slots are free. Lowering the
   * limit never stops Runs in progress.
   */
  private startWaitingRuns(): void {
    clearTimeout(this.waitingRecheck);
    this.waitingRecheck = undefined;
    if (this.closed || this.queue.length + this.resuming.length === 0) return;
    const limit = this.maxParallelRuns();
    while (this.inProgress.size < limit && this.resuming.length > 0) this.startRun(this.resuming.shift()!);
    let started = false;
    while (this.inProgress.size < limit && this.queue.length > 0) {
      started = true;
      this.startRun(this.queue.shift()!);
    }
    if (started) this.publishQueue();
    if (this.queue.length + this.resuming.length > 0) {
      this.waitingRecheck = setTimeout(() => this.startWaitingRuns(), WAITING_RECHECK_MS);
      this.waitingRecheck.unref();
    }
  }

  private startRun(run: RunView): void {
    this.setState(run, "running");
    this.log(run, "platform", "Started");
    const abort = new AbortController();
    const done = this.execute(run, abort.signal);
    this.inProgress.set(run.id, { abort, done });
  }

  /** Removes every Run worktree and `run/` branch, e.g. left by a platform that stopped mid-Run. */
  private async removeLeftoverWorktrees(): Promise<void> {
    const entries = await readdir(this.worktreesDir).catch(() => []);
    for (const entry of entries) await rm(path.join(this.worktreesDir, entry), { recursive: true, force: true });
    await this.repo.removeWorktreesAndBranches("run/");
  }

  private setState(run: RunView, state: RunState): void {
    run.state = state;
    this.store.save(run);
    this.publish({ type: "run", run: summary(run) });
  }

  /** Adds an entry to the end of the Run's log, saves it and tells Console clients. */
  private log(run: RunView, source: LogEntry["source"], text: string): void {
    const entry: LogEntry = { time: now(), source, text };
    run.log.push(entry);
    this.store.appendLog(run.id, entry);
    this.publish({ type: "log", runId: run.id, entry: { ...entry } });
  }

  private publishQueue(): void {
    this.publish({ type: "queue", queue: this.queue.map(summary) });
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

  private async execute(run: RunView, signal: AbortSignal): Promise<void> {
    const outcome = await this.workAndLand(run, signal);
    // Only now, with the worktree gone, does the Run count as finished.
    this.inProgress.delete(run.id);
    // Stopped by `close()`: it stays saved as in progress, so it starts again after a restart.
    if (!outcome.landed && signal.aborted) return;
    if (outcome.landed) {
      run.commit = outcome.commit;
      delete run.attempted;
      this.setState(run, "landed");
      this.log(run, "platform", "Landed");
    } else {
      run.error = outcome.reason;
      this.setState(run, "rejected");
      this.log(run, "platform", `Rejected: ${outcome.reason}`);
    }
    this.startWaitingRuns();
  }

  /**
   * Works on the Run and Lands it. A change that conflicts or fails the
   * render check is resolved by the Agent (up to `MAX_RESOLUTION_ATTEMPTS`),
   * then started over once from the latest `main`, then rejected.
   */
  private async workAndLand(run: RunView, signal: AbortSignal): Promise<LandResult> {
    try {
      const first = await this.inWorktree(run, (worktree) => this.workAndResolve(run, worktree, signal));
      if (first.landed || !needsResolving(first) || signal.aborted) return first;
      this.setState(run, "restarted");
      this.log(run, "platform", "Starting over from the latest Canvas");
      const restart = await this.inWorktree(run, (worktree) => this.workOnce(run, worktree, signal));
      if (restart.landed || restart.failure !== "conflict") return restart;
      return { ...restart, reason: COLLIDED_MESSAGE };
    } catch (error) {
      console.error(`Run ${run.id} failed`, error);
      return { landed: false, reason: "Something went wrong on the platform" };
    }
  }

  /**
   * Runs `work` in a fresh worktree branched from `main`, and removes the
   * worktree whatever happens, keeping the change it held as the Run's
   * `attempted` change, so the last attempt's is the one kept.
   */
  private async inWorktree(run: RunView, work: (worktree: Worktree) => Promise<LandResult>): Promise<LandResult> {
    let worktree: Worktree | undefined;
    try {
      worktree = await this.repo.createWorktree(path.join(this.worktreesDir, run.id), `run/${run.id}`);
      return await work(worktree);
    } finally {
      if (worktree) {
        run.attempted = await this.repo.worktreeChange(worktree).catch((error) => {
          console.error("Couldn't read a Run's change", error);
          return "";
        });
        await this.repo.removeWorktree(worktree).catch((error) => console.error("Couldn't remove a worktree", error));
      }
    }
  }

  /**
   * Lets the Agent do the Run's work in the worktree, then Lands it. Some
   * kinds of change (a Rollback) are first tried mechanically, and only need
   * the Agent if that fails.
   */
  private async workOnce(run: RunView, worktree: Worktree, signal: AbortSignal): Promise<LandResult> {
    const rules = rulesFor(run);
    const mechanical = rules.mechanically !== undefined && (await rules.mechanically(this.repo, worktree, run));
    if (!mechanical) {
      const failure = await this.runAgent(run, worktree, signal, await rules.instructions(this.repo, worktree, run), run.model);
      if (failure !== undefined) return { landed: false, reason: failure };
    }
    this.setState(run, "landing");
    const result = await this.land(run, worktree);
    if (mechanical && !result.landed && result.failure === "unchanged" && rules.nothingToDo) return { ...result, reason: rules.nothingToDo };
    return result;
  }

  /** `workOnce`, then up to `MAX_RESOLUTION_ATTEMPTS` resolutions if the change conflicts or doesn't render. */
  private async workAndResolve(run: RunView, worktree: Worktree, signal: AbortSignal): Promise<LandResult> {
    let result = await this.workOnce(run, worktree, signal);
    // The committed change to resolve; a failed resolution leaves the worktree in a mess, so it's kept.
    let change = await this.repo.head(worktree);
    for (let attempt = 0; attempt < MAX_RESOLUTION_ATTEMPTS && needsResolving(result) && !signal.aborted; attempt++) {
      this.setState(run, "resolving");
      const problem = result.failure === "conflict" ? "a conflict" : "a render failure";
      this.log(run, "platform", `Fixing ${problem} (attempt ${attempt + 1} of ${MAX_RESOLUTION_ATTEMPTS})`);
      if (!(await this.resolve(run, worktree, change, result, signal))) continue;
      this.setState(run, "landing");
      result = await this.land(run, worktree);
      if (!result.landed) change = await this.repo.head(worktree);
    }
    return result;
  }

  /**
   * Reapplies `change` onto the latest `main` and asks the Agent to fix the
   * conflict or render failure, given the Run's Prompt and the Prompts of the
   * changes it collided with. Returns whether the Agent succeeded and left no
   * conflict markers; the fixed change is left uncommitted for the Lander.
   */
  private async resolve(run: RunView, worktree: Worktree, change: string, failed: LandResult & { landed: false }, signal: AbortSignal): Promise<boolean> {
    const onto = await this.repo.main();
    const conflicts = await this.repo.reopenOnto(worktree, change, onto);
    let problem: ResolutionProblem;
    if (failed.failure === "conflict") {
      // Main moved on and the change now applies cleanly: nothing for the Agent to do.
      if (conflicts.length === 0) return true;
      problem = { kind: "conflict", files: conflicts };
    } else {
      problem = { kind: "render", problem: failed.problem ?? "unknown" };
    }
    const collided = await this.repo.changesBetween(worktree.base, onto, problem.kind === "conflict" ? conflicts : undefined);
    const instructions = resolutionInstructions({ prompt: rulesFor(run).intent(run), problem, collided });
    if ((await this.runAgent(run, worktree, signal, instructions, RESOLUTION_MODEL)) !== undefined) return false;
    return !(await hasConflictMarkers(worktree.dir, conflicts));
  }

  /** Lands the Run's change, logging each step. */
  private land(run: RunView, worktree: Worktree): Promise<LandResult> {
    return this.lander.land(worktree, this.change(run), (step) => this.log(run, "platform", LAND_STEP_TEXT[step]));
  }

  private change(run: RunView): ChangeMetadata {
    const change: ChangeMetadata = { kind: run.kind ?? "Prompt", nickname: run.nickname, prompt: run.prompt, model: run.model, run: run.id };
    if (run.original) change.original = run.original;
    return change;
  }

  /** Adds tokens `model` used to the Run's usage, saves it and tells Console clients. */
  private addUsage(run: RunView, model: Model, usage: TokenUsage): void {
    run.usageByModel ??= {};
    const sum = (run.usageByModel[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    sum.inputTokens += usage.inputTokens;
    sum.outputTokens += usage.outputTokens;
    sum.cacheReadTokens += usage.cacheReadTokens ?? 0;
    sum.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.store.save(run);
    this.publish({ type: "run", run: summary(run) });
  }

  /** Lets the Agent work in the worktree; returns why it failed, if it did. */
  private async runAgent(run: RunView, worktree: Worktree, signal: AbortSignal, instructions: string, model: Model): Promise<string | undefined> {
    const events = this.agent.run({ worktree: worktree.dir, instructions, model, signal });
    for await (const event of events) {
      if (event.type === "progress") {
        const progress: RunProgress = event.file === undefined ? { message: event.message } : { message: event.message, file: event.file };
        run.progress.push(progress);
        if (run.progress.length > MAX_PROGRESS_EVENTS) run.progress.shift();
        this.publish({ type: "progress", runId: run.id, ...progress });
        if (event.file !== undefined && !run.editing?.includes(event.file)) {
          run.editing = [...(run.editing ?? []), event.file];
          this.store.save(run);
          this.publish({ type: "files", runId: run.id, files: [...run.editing] });
        }
      }
      if (event.type === "message" && event.text.trim() !== "") this.log(run, "claude", event.text);
      if (event.type === "usage") this.addUsage(run, model, event.usage);
      if (event.type === "result") return event.outcome === "failure" ? event.error : undefined;
    }
    return "The Agent stopped without a result";
  }
}

/** Whether a failed Land is one the Agent may be able to fix. */
function needsResolving(result: LandResult): result is LandResult & { landed: false } {
  return !result.landed && (result.failure === "conflict" || result.failure === "render");
}

function copy(run: RunView): RunView {
  return {
    ...run,
    progress: run.progress.map((progress) => ({ ...progress })),
    log: run.log.map((entry) => ({ ...entry })),
    ...(run.editing && { editing: [...run.editing] }),
    ...(run.usageByModel && { usageByModel: structuredClone(run.usageByModel), usage: totalUsage(run.usageByModel) }),
  };
}

function summary(run: RunView): RunSummary {
  const { progress: _progress, editing: _editing, log: _log, attempted: _attempted, usageByModel, ...rest } = run;
  return { ...rest, ...(run.original && { original: { ...run.original } }), ...(usageByModel && { usage: totalUsage(usageByModel) }) };
}

/** The tokens of each kind over every model, and their cost with each model at its own prices. */
function totalUsage(byModel: UsageByModel): RunUsage {
  const total: RunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
  for (const [model, usage] of Object.entries(byModel) as Array<[Model, Required<TokenUsage>]>) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    total.cost += costOf(model, usage);
  }
  return total;
}

/** A Landed change from before Runs were saved, as a Landed Run. Its id is its `Run` trailer, or else its commit. */
function unrecordedRun(change: LandedChange): RunView {
  const run: RunView = {
    id: change.run ?? change.commit,
    state: "landed",
    nickname: change.nickname,
    prompt: change.prompt,
    model: change.model,
    commit: change.commit,
    time: change.time,
    progress: [],
    log: [],
  };
  if (change.kind !== "Prompt") run.kind = change.kind;
  if (change.original) run.original = { ...change.original };
  return run;
}

const now = () => new Date().toISOString();

function validate(request: PromptRequest): { nickname: string; prompt: string; model: Model } {
  const nickname = validNickname(request.nickname);
  if (nickname === undefined) throw new ChangeRefused("invalid", "Pick a nickname first");
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") throw new ChangeRefused("invalid", "The Prompt is empty");
  if (request.prompt.length > MAX_PROMPT_LENGTH) {
    throw new ChangeRefused("invalid", `Prompts are limited to ${MAX_PROMPT_LENGTH} characters`);
  }
  return { nickname, prompt: request.prompt.trim(), model: validModel(request.model) };
}

function validModel(value: unknown): Model {
  const model = value ?? DEFAULT_MODEL;
  if (!MODELS.includes(model as Model)) throw new ChangeRefused("invalid", `The model must be one of ${MODELS.join(", ")}`);
  return model as Model;
}

/** A nickname is 1–40 characters on one line, with surrounding spaces trimmed. */
export function validNickname(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const nickname = value.trim();
  if (nickname === "" || nickname.length > MAX_NICKNAME_LENGTH || /\p{Cc}/u.test(nickname)) return undefined;
  return nickname;
}
