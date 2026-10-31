import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitBytes, GitError } from "./git.ts";

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

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
