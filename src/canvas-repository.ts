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
    return { dir, branch };
  }

  /** Removes a worktree and its branch. Safe to call on one that's partly or fully gone. */
  async removeWorktree(worktree: Worktree): Promise<void> {
    await git(this.dir, ["worktree", "remove", "--force", worktree.dir]).catch(() => undefined);
    await git(this.dir, ["worktree", "prune"]);
    await git(this.dir, ["branch", "--quiet", "-D", worktree.branch]).catch(() => undefined);
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

  /** Moves `main` to `commit`, only if `main` is still at `expected`. */
  async moveMain(commit: string, expected: string): Promise<void> {
    await git(this.dir, ["update-ref", "refs/heads/main", commit, expected]);
  }

  /** Every change that Landed on `main`, newest first. */
  async history(): Promise<LandedChange[]> {
    const fields = ["%H", "%cI", "%(trailers:key=Kind,valueonly)", "%(trailers:key=Nickname,valueonly)", "%(trailers:key=Model,valueonly)", "%B"];
    const log = await git(this.dir, ["log", "main", `--format=${fields.join("%x1f")}%x1e`]);
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
