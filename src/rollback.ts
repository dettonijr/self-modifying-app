import type { LandedChange } from "./canvas-repository.ts";
import { MAX_REPLAY_DIFF_LENGTH } from "./replay.ts";

/**
 * What a Rollback is for, in a sentence the Agent can act on, e.g. as "this
 * change's Prompt" when resolving a conflict.
 */
export function rollbackIntent(original: { commit: string; nickname: string; prompt: string }): string {
  return `Roll back ${original.nickname}'s change for the Prompt "${original.prompt}" (commit ${original.commit}), keeping everything that Landed after it.`;
}

/**
 * What the Agent is asked when a Rollback doesn't revert cleanly: undo the
 * original change, given its Prompt and diff, while keeping the changes that
 * Landed after it.
 */
export function rollbackInstructions(options: { original: LandedChange; diff: string; since: LandedChange[] }): string {
  const { original, diff, since } = options;
  const shownDiff = diff.length > MAX_REPLAY_DIFF_LENGTH ? `${diff.slice(0, MAX_REPLAY_DIFF_LENGTH)}\n… (diff cut short)` : diff;
  const later =
    since.length === 0
      ? ["No other changes Landed after it."]
      : ["The Prompts that Landed after it, oldest first. Keep what they did:", ...since.map((change) => `- ${change.nickname}: ${change.prompt}`)];
  return [
    "This is a Rollback. Undo this change, and keep what came after.",
    "Later changes touched the same code, so it couldn't be reverted mechanically. Remove what it added and bring back what it removed, adapting to the code as it is now.",
    "",
    `The Prompt of the change to undo, by ${original.nickname}:`,
    original.prompt,
    "",
    "The diff of that change, for reference only. The Canvas has changed since, so don't apply it in reverse blindly:",
    "```diff",
    shownDiff,
    "```",
    "",
    ...later,
    "",
    "Don't undo the later changes.",
  ].join("\n");
}
