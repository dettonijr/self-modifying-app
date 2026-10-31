import type { LandedChange } from "./canvas-repository.ts";
import { promptList, shownDiff } from "./change-context.ts";

/**
 * What the Agent is asked for a Replay: make the Canvas fulfil the original
 * Prompt again, with the original diff as a reference only, winning over the
 * Prompts that Landed since on this subject and keeping everything else.
 */
export function replayInstructions(options: { original: LandedChange; diff: string; since: LandedChange[] }): string {
  const { original, diff, since } = options;
  return [
    "This is a Replay: a Player wants an earlier Prompt to work again on the current Canvas.",
    "",
    `The original Prompt, by ${original.nickname}:`,
    original.prompt,
    "",
    "The diff of the original change, for reference only. The Canvas has changed since, so don't apply it blindly:",
    "```diff",
    shownDiff(diff),
    "```",
    "",
    ...promptList(since, { heading: "The Prompts that Landed since, oldest first:", none: "No other changes have Landed since." }),
    "",
    "Make the Canvas fulfil the original Prompt again. Where a later change altered or undid this specific subject, this Replay wins over it.",
    "Keep everything unrelated that Landed since; don't undo other changes.",
  ].join("\n");
}
