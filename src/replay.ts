import type { LandedChange } from "./canvas-repository.ts";

/** Longer diffs are cut to this many characters; they're only a reference. */
export const MAX_REPLAY_DIFF_LENGTH = 40_000;

/**
 * What the Agent is asked for a Replay: make the Canvas fulfil the original
 * Prompt again, with the original diff as a reference only, winning over the
 * Prompts that Landed since on this subject and keeping everything else.
 */
export function replayInstructions(options: { original: LandedChange; diff: string; since: LandedChange[] }): string {
  const { original, diff, since } = options;
  const shownDiff = diff.length > MAX_REPLAY_DIFF_LENGTH ? `${diff.slice(0, MAX_REPLAY_DIFF_LENGTH)}\n… (diff cut short)` : diff;
  const later =
    since.length === 0
      ? ["No other changes have Landed since."]
      : ["The Prompts that Landed since, oldest first:", ...since.map((change) => `- ${change.nickname}: ${change.prompt}`)];
  return [
    "This is a Replay: a Player wants an earlier Prompt to work again on the current Canvas.",
    "",
    `The original Prompt, by ${original.nickname}:`,
    original.prompt,
    "",
    "The diff of the original change, for reference only. The Canvas has changed since, so don't apply it blindly:",
    "```diff",
    shownDiff,
    "```",
    "",
    ...later,
    "",
    "Make the Canvas fulfil the original Prompt again. Where a later change altered or undid this specific subject, this Replay wins over it.",
    "Keep everything unrelated that Landed since; don't undo other changes.",
  ].join("\n");
}
