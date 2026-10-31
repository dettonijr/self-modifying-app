import type { LandedChange } from "./canvas-repository.ts";

/**
 * What a Rollback stands for when the Agent has to do it, e.g. as "this
 * change's Prompt" in a conflict resolution.
 */
export function rollbackIntent(original: { commit: string; prompt: string }): string {
  return `Roll back the change made for the Prompt "${original.prompt}" (commit ${original.commit}), keeping everything that Landed after it.`;
}

/**
 * What the Agent is asked when a Rollback doesn't revert cleanly: undo the
 * original change, given its Prompt and diff, while keeping the changes that
 * Landed after it.
 */
export function rollbackInstructions(options: { original: LandedChange; diff: string; since: LandedChange[] }): string {
  const { original, diff, since } = options;
  const later =
    since.length === 0
      ? ["No other changes Landed after it."]
      : ["The Prompts of the changes that Landed after it, oldest first. Keep what they did:", ...since.map((change) => `- ${change.nickname}: ${change.prompt}`)];
  return [
    "Undo this change, and keep what came after.",
    `It was made by ${original.nickname} for the Prompt below, but later changes touched the same code, so it can't be reverted mechanically.`,
    "Remove what it added and bring back what it removed, adapting to the code as it is now. Don't undo the later changes.",
    "",
    "The Prompt of the change to undo:",
    original.prompt,
    "",
    "Its diff, for reference (the code has moved on since, so don't apply it blindly):",
    diff,
    "",
    ...later,
  ].join("\n");
}
