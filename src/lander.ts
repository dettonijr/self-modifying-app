import type { CanvasRepository, ChangeMetadata, Worktree } from "./canvas-repository.ts";

export type LandResult = { landed: true; commit: string } | { landed: false; reason: string };

/**
 * Lands a finished Run: commits its worktree with the change's metadata and
 * fast-forwards `main` to that commit. The Canvas server reads `main`, so the
 * change is live the moment `main` moves. Landing only ever moves `main`; it
 * never touches the Canvas repo's own working folder.
 */
export class Lander {
  private readonly repo: CanvasRepository;

  constructor(repo: CanvasRepository) {
    this.repo = repo;
  }

  async land(worktree: Worktree, change: ChangeMetadata): Promise<LandResult> {
    const base = await this.repo.main();
    const commit = await this.repo.commitWorktree(worktree, change);
    if (commit === undefined) return { landed: false, reason: "The Agent didn't change anything" };
    await this.repo.moveMain(commit, base);
    return { landed: true, commit };
  }
}
