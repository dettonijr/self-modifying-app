import type { CanvasRepository, ChangeMetadata, Worktree } from "./canvas-repository.ts";
import type { RenderCheck } from "./render-check.ts";

/**
 * Why a change didn't Land, for the Player (`reason`) and for the platform
 * (`failure`): `unchanged` means the Agent changed nothing, `conflict` that
 * rebasing onto `main` conflicted, `render` that the candidate commit failed
 * the render check (`problem` says what was wrong, for the Agent).
 */
export type LandResult = { landed: true; commit: string } | { landed: false; reason: string; failure?: LandFailure; problem?: string };
export type LandFailure = "unchanged" | "conflict" | "render";
/** The steps of Landing a change that a Player sees in the Run's log. */
export type LandStep = "rebasing" | "render-check";

/**
 * Lands finished Runs one at a time, in the order they arrive (docs/adr/0001):
 * commits the worktree with the change's metadata, rebases it onto the
 * current `main`, render-checks the result and fast-forwards `main` to it. The Canvas server
 * reads `main`, so the change is live the moment `main` moves. Landing only ever moves `main`; it
 * never touches the Canvas repo's own working folder.
 */
export class Lander {
  private readonly repo: CanvasRepository;
  private readonly renderCheck: RenderCheck;
  /** The Land in progress, if any; the next one waits for it. */
  private previous: Promise<unknown> = Promise.resolve();

  constructor(repo: CanvasRepository, renderCheck: RenderCheck) {
    this.repo = repo;
    this.renderCheck = renderCheck;
  }

  /** Lands the worktree's change, calling `onStep` as each step begins. */
  land(worktree: Worktree, change: ChangeMetadata, onStep: (step: LandStep) => void = () => {}): Promise<LandResult> {
    const result = this.previous.then(() => this.landNow(worktree, change, onStep));
    this.previous = result.catch(() => undefined);
    return result;
  }

  private async landNow(worktree: Worktree, change: ChangeMetadata, onStep: (step: LandStep) => void): Promise<LandResult> {
    if ((await this.repo.commitWorktree(worktree, change)) === undefined) {
      return { landed: false, reason: "The Agent didn't change anything", failure: "unchanged" };
    }
    onStep("rebasing");
    const base = await this.repo.main();
    const commit = await this.repo.rebaseWorktree(worktree, base);
    if (commit === undefined) {
      return { landed: false, reason: "The change conflicts with one that Landed while it was being made", failure: "conflict" };
    }
    onStep("render-check");
    const render = await this.renderCheck.check(commit);
    if (!render.rendered) {
      console.warn(`Commit ${commit} failed the render check: ${render.problem}`);
      return { landed: false, reason: "Canvas didn't render", failure: "render", problem: render.problem };
    }
    await this.repo.moveMain(commit, base);
    return { landed: true, commit };
  }
}
