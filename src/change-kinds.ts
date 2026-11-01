import type { CanvasRepository, ChangeKind, LandedChange, OriginalChange, Worktree } from "./canvas-repository.ts";
import { replayInstructions } from "./replay.ts";

/** What the per-kind rules need to know about a Run. */
export interface KindRun {
  prompt: string;
  /** The earlier change a Replay re-applies. */
  original?: OriginalChange;
}

/** How Runs of one kind of change are worked on. */
export interface ChangeKindRules {
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
    instructions: async (_repo, _worktree, run) => run.prompt,
    intent: (run) => run.prompt,
  },
  Replay: {
    instructions: fromOriginal(replayInstructions),
    intent: (run) => run.prompt,
  },
};

/** The rules for a Run's kind; a Run without a kind is a Player's own Prompt. */
export function rulesFor(run: { kind?: ChangeKind }): ChangeKindRules {
  return CHANGE_KIND_RULES[run.kind ?? "Prompt"];
}
