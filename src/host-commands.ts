import { configuredCapUsd, formatUsd, raiseCap } from "./budget.ts";
import { setMaxParallelRuns } from "./parallel-limit.ts";

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
    if (command === "set-parallel-runs" && rest.length === 1) {
      const limit = setMaxParallelRuns(dataDir, Number(rest[0]));
      return { exitCode: 0, output: `Up to ${limit} Runs may now be in progress at once. Runs already in progress carry on.` };
    }
    return {
      exitCode: 2,
      output: [
        "Usage: raise-cap <dollars>          Raise the spending cap, e.g. raise-cap 20",
        "       set-parallel-runs <count>    Set how many Runs may be in progress at once, e.g. set-parallel-runs 2",
      ].join("\n"),
    };
  } catch (error) {
    return { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
  }
}
