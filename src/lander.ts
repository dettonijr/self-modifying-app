import type { CanvasRepository, ChangeMetadata, Worktree } from "./canvas-repository.ts";
import type { RenderCheck } from "./render-check.ts";

/**
 * Why a change didn't Land, for the Player (`reason`) and for the platform
 * (`failure`): `unchanged` means the Agent changed nothing, `render` that the
 * candidate commit failed the render check.
 */
export type LandResult = { landed: true; commit: string } | { landed: false; reason: string; failure?: LandFailure };
export type LandFailure = "unchanged" | "render";

/**
 * Lands a finished Run: commits its worktree with the change's metadata,
 * render-checks that commit and fast-forwards `main` to it. The Canvas server
 * reads `main`, so the change is live the moment `main` moves. Landing only ever moves `main`; it
 * never touches the Canvas repo's own working folder.
 */
export class Lander {
  private readonly repo: CanvasRepository;
  private readonly renderCheck: RenderCheck;

  constructor(repo: CanvasRepository, renderCheck: RenderCheck) {
    this.repo = repo;
    this.renderCheck = renderCheck;
  }

  async land(worktree: Worktree, change: ChangeMetadata): Promise<LandResult> {
    const base = await this.repo.main();
    const commit = await this.repo.commitWorktree(worktree, change);
    if (commit === undefined) return { landed: false, reason: "The Agent didn't change anything", failure: "unchanged" };
    const render = await this.renderCheck.check(commit);
    if (!render.rendered) {
      console.warn(`Commit ${commit} failed the render check: ${render.problem}`);
      return { landed: false, reason: "Canvas didn't render", failure: "render" };
    }
    await this.repo.moveMain(commit, base);
    return { landed: true, commit };
  }
}
