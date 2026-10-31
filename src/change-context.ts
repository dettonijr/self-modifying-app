import type { LandedChange } from "./canvas-repository.ts";

/** Longer diffs shown to the Agent are cut to this many characters; they're only a reference. */
export const MAX_DIFF_LENGTH = 40_000;

/** A diff for the Agent, cut to `MAX_DIFF_LENGTH` characters. */
export function shownDiff(diff: string): string {
  return diff.length > MAX_DIFF_LENGTH ? `${diff.slice(0, MAX_DIFF_LENGTH)}\n… (diff cut short)` : diff;
}

/**
 * Lines listing the nickname and Prompt of each change, oldest first, under
 * `heading`; or just `none` if there are no changes.
 */
export function promptList(changes: LandedChange[], text: { heading: string; none: string }): string[] {
  return changes.length === 0 ? [text.none] : [text.heading, ...changes.map((change) => `- ${change.nickname}: ${change.prompt}`)];
}
