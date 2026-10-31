import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, AgentEvent, AgentTask, TokenUsage } from "../../src/agent.ts";

/** What a script can do while it plays the Agent for one Run. */
export interface FakeAgentContext {
  task: AgentTask;
  /** Writes a file in the Run's worktree (path relative to it) and reports progress. */
  writeFile(relativePath: string, contents: string): Promise<void>;
  deleteFile(relativePath: string): Promise<void>;
  progress(message: string, file?: string): void;
  /** Says something as Claude would, for the Run's log. */
  message(text: string): void;
  usage(usage: TokenUsage): void;
  /** Resolves when the task's signal is aborted; await it to simulate hanging. */
  aborted(): Promise<void>;
}

/** Plays one Run. Returning ends it with success; throwing ends it with failure (a crash). */
export type FakeAgentScript = (context: FakeAgentContext) => Promise<void> | void;

/**
 * A scripted stand-in for Claude behind the Agent interface. Queue one script
 * per expected Run with `enqueue`; Runs consume them in start order. A Run with
 * no script queued fails. Every task received is recorded in `tasks`.
 */
export class FakeAgent implements Agent {
  readonly tasks: AgentTask[] = [];
  private readonly scripts: FakeAgentScript[] = [];
  private readonly startWaiters: Array<{ count: number; resolve: () => void }> = [];

  enqueue(...scripts: FakeAgentScript[]): this {
    this.scripts.push(...scripts);
    return this;
  }

  /** Resolves once `count` Runs in total have started. */
  started(count = 1): Promise<void> {
    if (this.tasks.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.startWaiters.push({ count, resolve }));
  }

  run(task: AgentTask): AsyncIterable<AgentEvent> {
    this.tasks.push(task);
    for (const waiter of this.startWaiters.filter((w) => this.tasks.length >= w.count)) {
      this.startWaiters.splice(this.startWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    const script = this.scripts.shift();
    const events = new EventChannel<AgentEvent>();
    const context: FakeAgentContext = {
      task,
      async writeFile(relativePath, contents) {
        const target = insideWorktree(task.worktree, relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents);
        events.push({ type: "progress", message: `Editing ${relativePath}`, file: relativePath });
      },
      async deleteFile(relativePath) {
        await rm(insideWorktree(task.worktree, relativePath), { force: true });
        events.push({ type: "progress", message: `Deleting ${relativePath}`, file: relativePath });
      },
      progress: (message, file) => events.push({ type: "progress", message, file }),
      message: (text) => events.push({ type: "message", text }),
      usage: (usage) => events.push({ type: "usage", usage }),
      aborted: () =>
        new Promise((resolve) => {
          if (task.signal?.aborted) resolve();
          else task.signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
    };
    void (async () => {
      try {
        if (!script) throw new Error("FakeAgent has no script queued for this Run");
        await script(context);
        events.end({ type: "result", outcome: "success" });
      } catch (error) {
        events.end({ type: "result", outcome: "failure", error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return events;
  }
}

/**
 * A gate a script can hold on until the test releases it, to force exact
 * orderings between parallel Runs without sleeps.
 */
export class Gate {
  private open = false;
  private waiters: Array<() => void> = [];

  wait(): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    this.open = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

function insideWorktree(worktree: string, relativePath: string): string {
  const target = path.resolve(worktree, relativePath);
  if (!target.startsWith(path.resolve(worktree) + path.sep)) {
    throw new Error(`FakeAgent script tried to write outside the worktree: ${relativePath}`);
  }
  return target;
}

/** A push-based async iterable that finishes after its final value. */
class EventChannel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private done = false;
  private wake: (() => void) | undefined;

  push(value: T): void {
    if (this.done) return;
    this.buffer.push(value);
    this.wake?.();
  }

  end(last: T): void {
    this.push(last);
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}
