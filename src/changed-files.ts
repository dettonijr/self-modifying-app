import type { CanvasRepository } from "./canvas-repository.ts";
import type { RunView } from "./runs.ts";

/**
 * A file a Run changed, as the Run page shows it. While the Run is in
 * progress only `path` is known; once finished, its added and removed line
 * counts and its part of the unified diff too.
 */
export interface ChangedFile {
  path: string;
  added?: number;
  removed?: number;
  diff?: string;
}

/**
 * The files a Run changed: those it's editing while in progress, those its
 * commit changed once Landed (read from git), and the change it last tried
 * once rejected (saved with the Run).
 */
export async function changedFilesOf(run: RunView, repo: CanvasRepository): Promise<ChangedFile[]> {
  if (run.state === "landed" && run.commit !== undefined) return changedFiles(await repo.diff(run.commit));
  if (run.state === "rejected") return changedFiles(run.attempted ?? "");
  return (run.editing ?? []).map((file) => ({ path: file }));
}

/**
 * Splits a unified diff (as `git diff --no-renames` writes it) into one entry
 * per file, counting its added and removed lines. Works for any saved diff.
 */
export function changedFiles(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: pathOf(line), added: 0, removed: 0, diff: line };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (current === undefined) continue;
    current.diff += `\n${line}`;
    if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+")) current.added!++;
    else if (inHunk && line.startsWith("-")) current.removed!++;
  }
  for (const file of files) file.diff = file.diff!.replace(/\n+$/, "");
  return files;
}

/** The path in a `diff --git a/<path> b/<path>` header; both halves are the same without renames. */
function pathOf(header: string): string {
  const both = header.slice("diff --git ".length);
  const half = both.slice(0, (both.length - 1) / 2);
  const unquoted = half.startsWith('"') ? half.slice(1, -1) : half;
  return unquoted.replace(/^a\//, "");
}
