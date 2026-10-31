import { configuredCapUsd, formatUsd, raiseCap } from "./budget.ts";

export interface HostCommandResult {
  exitCode: number;
  output: string;
}

/**
 * The host's command-line commands, run by `src/cli.ts`. They work on the data
 * folder, so they act on a running platform without talking to it.
 */
export function runHostCommand(args: string[], env: NodeJS.ProcessEnv = process.env): HostCommandResult {
  const [command, ...rest] = args;
  const dataDir = env.DATA_DIR ?? "./data";
  try {
    if (command === "raise-cap" && rest.length === 1) {
      const cap = raiseCap(dataDir, Number(rest[0]), configuredCapUsd(env));
      return { exitCode: 0, output: `The spending cap is now ${formatUsd(cap)}. The Console resumes if the total is below it.` };
    }
    return { exitCode: 2, output: "Usage: raise-cap <dollars>   Raise the spending cap, e.g. raise-cap 20" };
  } catch (error) {
    return { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
  }
}
