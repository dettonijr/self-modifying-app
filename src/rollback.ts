import type { LandedChange } from "./canvas-repository.ts";
import { promptList, shownDiff } from "./change-context.ts";

/** Why a Rollback is rejected when reverting its change changes nothing. */
export const ALREADY_ROLLED_BACK_MESSAGE = "That change is already undone";

/**
 * What a Rollback is for, in a sentence the Agent can act on, e.g. as "this
 * change's Prompt" when resolving a conflict.
 */
export function rollbackIntent(original: { commit: string; nickname: string; prompt: string }): string {
  return `Roll back ${original.nickname}'s change for the Prompt "${original.prompt}" (commit ${original.commit}), keeping everything that Landed after it.`;
}

/**
 * What the Agent is asked when a Rollback doesn't revert cleanly: roll back
 * the original change, given its Prompt and diff, while keeping the changes
 * that Landed after it.
 */
export function rollbackInstructions(options: { original: LandedChange; diff: string; since: LandedChange[] }): string {
  const { original, diff, since } = options;
  return [
    "This is a Rollback. Roll back this change, and keep what came after.",
    "Later changes touched the same code, so it couldn't be reverted mechanically. Remove what it added and bring back what it removed, adapting to the code as it is now.",
    "",
    `The Prompt of the change to roll back, by ${original.nickname}:`,
    original.prompt,
    "",
    "The diff of that change, for reference only. The Canvas has changed since, so don't apply it in reverse blindly:",
    "```diff",
    shownDiff(diff),
    "```",
    "",
    ...promptList(since, { heading: "The Prompts that Landed after it, oldest first. Keep what they did:", none: "No other changes Landed after it." }),
    "",
    "Don't roll back the later changes.",
  ].join("\n");
}
