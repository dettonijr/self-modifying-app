import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "./agent.ts";
import { git, gitBytes, GitError } from "./git.ts";

/** What every commit on `main` records about the change (besides the Starter Canvas). */
export interface ChangeMetadata {
  kind: "Prompt";
  nickname: string;
  prompt: string;
  model: Model;
}

/** A change that Landed, as listed in the history. */
export interface LandedChange extends ChangeMetadata {
  commit: string;
  /** When it Landed, as an ISO 8601 timestamp. */
  time: string;
}

/** A Run's own checkout of the Canvas, on its own branch. */
export interface Worktree {
  dir: string;
  branch: string;
  /** The `main` commit it was branched from. */
  base: string;
}

const STARTER_CANVAS = fileURLToPath(new URL("../starter-canvas", import.meta.url));

/**
 * Owns the git repo holding the Canvas. `main` is the live Canvas; every commit
 * on `main` is a version. Files are read from git objects, never from the
 * working folder (see docs/adr/0003).
 */
export class CanvasRepository {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  /** Opens the repo at `dir`, seeding it with the starter Canvas if it doesn't exist yet. */
  static async open(dir: string): Promise<CanvasRepository> {
    const repo = new CanvasRepository(dir);
    if (!(await exists(path.join(dir, ".git")))) await repo.seed();
    await git(dir, ["worktree", "prune"]);
    return repo;
  }

  private async seed(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await cp(STARTER_CANVAS, this.dir, { recursive: true });
    await git(this.dir, ["init", "--quiet", "--initial-branch=main"]);
    await git(this.dir, ["add", "--all"]);
    await git(this.dir, ["commit", "--quiet", "--message=Starter Canvas"]);
  }

  /** The commit `main` points to. */
  main(): Promise<string> {
    return git(this.dir, ["rev-parse", "--verify", "main^{commit}"]);
  }

  /** Creates a worktree at `dir` on a new branch `branch`, starting from the current `main`. */
  async createWorktree(dir: string, branch: string): Promise<Worktree> {
    await git(this.dir, ["worktree", "add", "--quiet", "-b", branch, dir, "main"]);
    return { dir, branch, base: await git(dir, ["rev-parse", "HEAD"]) };
  }

  /** Removes a worktree and its branch. Safe to call on one that's partly or fully gone. */
  async removeWorktree(worktree: Worktree): Promise<void> {
    await git(this.dir, ["worktree", "remove", "--force", worktree.dir]).catch(() => undefined);
    await git(this.dir, ["worktree", "prune"]);
    await git(this.dir, ["branch", "--quiet", "-D", worktree.branch]).catch(() => undefined);
  }

  /** Removes every worktree and every branch whose name starts with `branchPrefix`, even ones that are partly gone. */
  async removeWorktreesAndBranches(branchPrefix: string): Promise<void> {
    await git(this.dir, ["worktree", "prune"]);
    const worktrees = (await git(this.dir, ["worktree", "list", "--porcelain"]))
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((dir) => path.resolve(dir) !== path.resolve(this.dir));
    for (const dir of worktrees) await git(this.dir, ["worktree", "remove", "--force", dir]).catch(() => undefined);
    await git(this.dir, ["worktree", "prune"]);
    const branches = await git(this.dir, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${branchPrefix}`]);
    for (const branch of branches.split("\n").filter(Boolean)) await git(this.dir, ["branch", "--quiet", "-D", branch]);
  }

  /**
   * Commits everything in a worktree with the change's metadata, and returns
   * the new commit, or `undefined` if nothing changed.
   */
  async commitWorktree(worktree: Worktree, change: ChangeMetadata): Promise<string | undefined> {
    await git(worktree.dir, ["add", "--all"]);
    if ((await git(worktree.dir, ["status", "--porcelain"])) === "") return undefined;
    await git(worktree.dir, ["commit", "--quiet", "--cleanup=verbatim", "--file=-"], commitMessage(change));
    return git(worktree.dir, ["rev-parse", "HEAD"]);
  }

  /**
   * Rebases a worktree's commits onto `onto` and returns the new tip, or
   * `undefined` if the rebase conflicts, in which case the worktree is left
   * as it was.
   */
  async rebaseWorktree(worktree: Worktree, onto: string): Promise<string | undefined> {
    try {
      await git(worktree.dir, ["rebase", "--quiet", onto]);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      await git(worktree.dir, ["rebase", "--abort"]).catch(() => undefined);
      return undefined;
    }
    return git(worktree.dir, ["rev-parse", "HEAD"]);
  }

  /** The commit a worktree is at. */
  head(worktree: Worktree): Promise<string> {
    return git(worktree.dir, ["rev-parse", "HEAD"]);
  }

  /**
   * Resets a worktree to `onto` and reapplies `change` (a single commit) as
   * uncommitted edits, so that committing again gives one commit on `onto`.
   * Returns the paths that conflict, which are left with git's conflict
   * markers in them.
   */
  async reopenOnto(worktree: Worktree, change: string, onto: string): Promise<string[]> {
    await git(worktree.dir, ["reset", "--quiet", "--hard", onto]);
    try {
      await git(worktree.dir, ["cherry-pick", "--no-commit", change]);
      return [];
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      const conflicts = await git(worktree.dir, ["diff", "--name-only", "--diff-filter=U"]);
      await git(worktree.dir, ["cherry-pick", "--quit"]);
      return conflicts === "" ? [] : conflicts.split("\n");
    }
  }

  /** Moves `main` to `commit`, only if `main` is still at `expected`. */
  async moveMain(commit: string, expected: string): Promise<void> {
    await git(this.dir, ["update-ref", "refs/heads/main", commit, expected]);
  }

  /** Every change that Landed on `main`, newest first. */
  history(): Promise<LandedChange[]> {
    return this.changes(["main"]);
  }

  /**
   * The changes after `from` up to and including `to`, oldest first; only
   * those touching `paths`, if given.
   */
  async changesBetween(from: string, to: string, paths?: string[]): Promise<LandedChange[]> {
    return (await this.changes([`${from}..${to}`, ...(paths ? ["--", ...paths] : [])])).reverse();
  }

  /** The changes `git log <args>` lists, newest first. */
  private async changes(args: string[]): Promise<LandedChange[]> {
    const fields = ["%H", "%cI", "%(trailers:key=Kind,valueonly)", "%(trailers:key=Nickname,valueonly)", "%(trailers:key=Model,valueonly)", "%B"];
    const log = await git(this.dir, ["log", `--format=${fields.join("%x1f")}%x1e`, ...args]);
    const changes: LandedChange[] = [];
    for (const entry of log.split("\x1e")) {
      const [commit, time, kind, nickname, model, message] = entry.trim().split("\x1f");
      if (!commit || kind?.trim() !== "Prompt") continue;
      changes.push({
        commit,
        time,
        kind: "Prompt",
        nickname: nickname.trim(),
        model: model.trim() as Model,
        prompt: promptFromMessage(message),
      });
    }
    return changes;
  }

  /** The contents of a file at a commit, or `undefined` if there's no such file. */
  async readFile(commit: string, filePath: string): Promise<Buffer | undefined> {
    try {
      return await gitBytes(this.dir, ["cat-file", "blob", `${commit}:${filePath}`]);
    } catch (error) {
      if (error instanceof GitError) return undefined;
      throw error;
    }
  }
}

/**
 * A commit message is a subject line, the Prompt verbatim, then the metadata
 * as git trailers, separated by blank lines.
 */
function commitMessage(change: ChangeMetadata): string {
  const firstLine = change.prompt.split("\n")[0];
  const summary = firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
  return [
    `${change.kind} by ${change.nickname}: ${summary}`,
    change.prompt,
    [`Kind: ${change.kind}`, `Nickname: ${change.nickname}`, `Model: ${change.model}`].join("\n"),
  ].join("\n\n") + "\n";
}

function promptFromMessage(message: string): string {
  const body = message.slice(message.indexOf("\n\n") + 2).replace(/\n+$/, "");
  return body.slice(0, body.lastIndexOf("\n\n"));
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
