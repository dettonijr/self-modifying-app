import path from "node:path";
import { readNumber, writeJsonAtomically } from "./data-files.ts";
import { positiveNumberFromEnvironment } from "./environment.ts";

/**
 * How many Runs may be in progress at once unless the host sets
 * `MAX_PARALLEL_RUNS`. Prompts beyond the limit wait in the queue.
 */
export const DEFAULT_MAX_PARALLEL_RUNS = 3;

/** Reads the starting parallel Run limit from `MAX_PARALLEL_RUNS`, a whole number of at least 1. */
export function maxParallelRunsFromEnvironment(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumberFromEnvironment(env, "MAX_PARALLEL_RUNS", DEFAULT_MAX_PARALLEL_RUNS, { whole: true });
}

/**
 * The limit in force: the one the host last set from the command line (kept
 * in `parallel-runs.json`), or the configured starting limit if they haven't.
 */
export function currentMaxParallelRuns(dataDir: string, configured: number): number {
  return readNumber(limitFile(dataDir), "maxParallelRuns") ?? configured;
}

/**
 * Sets the limit of a platform, running or not, that uses this data folder.
 * Lowering it never stops Runs in progress; it only holds back waiting ones.
 */
export function setMaxParallelRuns(dataDir: string, limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("The parallel Run limit must be a whole number of at least 1");
  writeJsonAtomically(limitFile(dataDir), { maxParallelRuns: limit });
  return limit;
}

const limitFile = (dataDir: string) => path.join(dataDir, "parallel-runs.json");
