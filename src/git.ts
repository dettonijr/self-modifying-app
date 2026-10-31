import { execFile } from "node:child_process";

export class GitError extends Error {
  readonly stderr: string;
  constructor(args: string[], stderr: string) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    this.stderr = stderr;
  }
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "Platform",
  GIT_AUTHOR_EMAIL: "platform@self-modifying-app.local",
  GIT_COMMITTER_NAME: "Platform",
  GIT_COMMITTER_EMAIL: "platform@self-modifying-app.local",
};

/** Runs git in `cwd` and returns stdout as raw bytes. */
export function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...IDENTITY } },
      (error, stdout, stderr) => {
        if (error) reject(new GitError(args, stderr.toString()));
        else resolve(stdout);
      },
    );
  });
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitBytes(cwd, args)).toString("utf8").trim();
}
