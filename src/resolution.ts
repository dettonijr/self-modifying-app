import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MODEL, type Model } from "./agent.ts";
import type { LandedChange } from "./canvas-repository.ts";
import { promptList } from "./change-context.ts";

/** Conflict resolution always uses this model, whatever the Run's own model. */
export const RESOLUTION_MODEL: Model = DEFAULT_MODEL;

/** Up to this many resolution attempts before a Run starts over. */
export const MAX_RESOLUTION_ATTEMPTS = 2;

export const COLLIDED_MESSAGE =
  "Your Prompt collided with changes that Landed while it was being made, and couldn't be reconciled. Try again with a different Prompt.";

/** Why a change needs resolving. */
export type ResolutionProblem =
  /** Rebasing onto `main` conflicted; these files hold git conflict markers. */
  | { kind: "conflict"; files: string[] }
  /** The result failed the render check. */
  | { kind: "render"; problem: string };

/**
 * What the Agent is asked when a change couldn't Land: the problem, the
 * change's own Prompt and the Prompts of the changes it collided with, so
 * that both intentions are respected.
 */
export function resolutionInstructions(options: { prompt: string; problem: ResolutionProblem; collided: LandedChange[] }): string {
  const { prompt, problem, collided } = options;
  const what =
    problem.kind === "conflict"
      ? [
          "This change conflicts with changes that Landed on the Canvas while it was being made.",
          `These files contain git conflict markers (<<<<<<<, =======, >>>>>>>): ${problem.files.join(", ")}.`,
          "Resolve every conflict and remove all the markers.",
        ]
      : [`After this change, the Canvas page didn't render: ${problem.problem}.`, "Fix it so that the page renders."];
  return [
    ...what,
    "Respect both intentions: keep what this change's Prompt asked for and what the other Prompts asked for. Don't undo the other changes.",
    "",
    "This change's Prompt:",
    prompt,
    "",
    ...promptList(collided, { heading: "The Prompts of the changes it collided with, oldest first:", none: "No other changes Landed in the meantime." }),
  ].join("\n");
}

/** Whether any of `files` (relative to `dir`) still holds a git conflict marker. */
export async function hasConflictMarkers(dir: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    const contents = await readFile(path.join(dir, file), "utf8").catch(() => "");
    if (/^(<<<<<<<|>>>>>>>)( |$)/m.test(contents)) return true;
  }
  return false;
}
