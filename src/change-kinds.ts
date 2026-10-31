import type { CanvasRepository, ChangeKind, LandedChange, OriginalChange, Worktree } from "./canvas-repository.ts";
import { replayInstructions } from "./replay.ts";
import { ALREADY_ROLLED_BACK_MESSAGE, rollbackInstructions, rollbackIntent } from "./rollback.ts";

/** What the per-kind rules need to know about a Run. */
export interface KindRun {
  prompt: string;
  /** The earlier change a Replay re-applies or a Rollback rolls back. */
  original?: OriginalChange;
}

/** How Runs of one kind of change are worked on. */
export interface ChangeKindRules {
  /** Whether the Player picks the model; otherwise the Run uses `DEFAULT_MODEL`. */
  playerPicksModel: boolean;
  /**
   * Makes the change without the Agent if it can, as uncommitted edits in
   * the worktree. Returns whether it did; if not, the worktree is as it was
   * and the Agent is asked.
   */
  mechanically?(repo: CanvasRepository, worktree: Worktree, run: KindRun): Promise<boolean>;
  /** Why the Run is rejected when the mechanical change changes nothing. */
  nothingToDo?: string;
  /** What the Agent is asked to do, as of the worktree's base. */
  instructions(repo: CanvasRepository, worktree: Worktree, run: KindRun): Promise<string>;
  /** What the Run is for, in words the resolving Agent can act on. */
  intent(run: KindRun): string;
}

/**
 * Instructions built from the original change, its diff and the Prompts that
 * Landed after it, up to the worktree's base, so a Run that waited or
 * restarted gets the current list.
 */
function fromOriginal(build: (options: { original: LandedChange; diff: string; since: LandedChange[] }) => string): ChangeKindRules["instructions"] {
  return async (repo, worktree, run) => {
    if (!run.original) throw new Error("The Run has no original change");
    const original = await repo.landedChange(run.original.commit);
    if (!original) throw new Error(`The original change ${run.original.commit} is no longer in the history`);
    const [diff, since] = await Promise.all([repo.diff(original.commit), repo.changesBetween(original.commit, worktree.base)]);
    return build({ original, diff, since });
  };
}

export const CHANGE_KIND_RULES: Record<ChangeKind, ChangeKindRules> = {
  Prompt: {
    playerPicksModel: true,
    instructions: async (_repo, _worktree, run) => run.prompt,
    intent: (run) => run.prompt,
  },
  Replay: {
    playerPicksModel: true,
    instructions: fromOriginal(replayInstructions),
    intent: (run) => run.prompt,
  },
  Rollback: {
    playerPicksModel: false,
    // A mechanical revert first; the Agent only if it conflicts.
    mechanically: (repo, worktree, run) => (run.original ? repo.revert(worktree, run.original.commit) : Promise.resolve(false)),
    nothingToDo: ALREADY_ROLLED_BACK_MESSAGE,
    instructions: fromOriginal(rollbackInstructions),
    intent: (run) => (run.original ? rollbackIntent({ ...run.original, prompt: run.prompt }) : run.prompt),
  },
};

/** The rules for a Run's kind; a Run without a kind is a Player's own Prompt. */
export function rulesFor(run: { kind?: ChangeKind }): ChangeKindRules {
  return CHANGE_KIND_RULES[run.kind ?? "Prompt"];
}
