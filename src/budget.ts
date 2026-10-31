import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Model, TokenUsage } from "./agent.ts";

/**
 * US dollars per million tokens, Anthropic first-party API rates (checked
 * 2026-10-31). The only place prices live: update here when they change.
 */
export const PRICES: Record<Model, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
};

export function costOf(model: Model, usage: TokenUsage): number {
  const price = PRICES[model];
  return (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
}

/** Used when the host doesn't configure a cap. */
export const DEFAULT_SPENDING_CAP_USD = 10;

export interface Spending {
  totalUsd: number;
  capUsd: number;
  /** The total has reached the cap: new Prompts, Replays and Rollbacks are refused. */
  paused: boolean;
}

/** Reads the configured cap from `SPENDING_CAP_USD`, shared by the platform and the command line. */
export function configuredCapUsd(env: NodeJS.ProcessEnv = process.env): number {
  if (env.SPENDING_CAP_USD === undefined || env.SPENDING_CAP_USD === "") return DEFAULT_SPENDING_CAP_USD;
  const cap = Number(env.SPENDING_CAP_USD);
  if (!Number.isFinite(cap) || cap < 0) throw new Error(`SPENDING_CAP_USD must be a number of dollars, not "${env.SPENDING_CAP_USD}"`);
  return cap;
}

/**
 * The cap in force: the configured cap, or the one the host raised it to from
 * the command line (kept in `spending-cap.json`), whichever is higher.
 */
export function currentCapUsd(dataDir: string, configuredCap: number): number {
  return Math.max(configuredCap, readNumber(capFile(dataDir), "capUsd") ?? 0);
}

/** Raises the cap of a platform, running or not, that uses this data folder. Returns the new cap. */
export function raiseCap(dataDir: string, newCapUsd: number, configuredCap: number): number {
  const current = currentCapUsd(dataDir, configuredCap);
  if (!Number.isFinite(newCapUsd) || newCapUsd <= current) {
    throw new Error(`The new cap must be higher than the current one, ${formatUsd(current)}`);
  }
  writeJsonAtomically(capFile(dataDir), { capUsd: newCapUsd });
  return newCapUsd;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

const capFile = (dataDir: string) => path.join(dataDir, "spending-cap.json");

/**
 * Records the token usage the Agent reports for every Run and adds up what it
 * costs. Once the total reaches the cap, the Console is paused. The total is
 * kept in `spending.json` in the data folder, rewritten on every usage report.
 * The cap is re-read on every check, so raising it from the command line
 * resumes a running platform.
 */
export class Budget {
  private readonly dataDir: string;
  private readonly totalFile: string;
  private totalUsd: number;
  private readonly configuredCap: number;

  constructor(options: { dataDir: string; capUsd?: number }) {
    this.dataDir = options.dataDir;
    this.totalFile = path.join(options.dataDir, "spending.json");
    this.totalUsd = readNumber(this.totalFile, "totalUsd") ?? 0;
    this.configuredCap = options.capUsd ?? DEFAULT_SPENDING_CAP_USD;
  }

  record(model: Model, usage: TokenUsage): void {
    this.totalUsd += costOf(model, usage);
    writeJsonAtomically(this.totalFile, { totalUsd: this.totalUsd });
  }

  spending(): Spending {
    const capUsd = currentCapUsd(this.dataDir, this.configuredCap);
    return { totalUsd: this.totalUsd, capUsd, paused: this.totalUsd >= capUsd };
  }
}

function readNumber(file: string, key: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value: unknown = (JSON.parse(text) as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${file} has no valid ${key}`);
  return value;
}

/** Writes to a temporary file first, so a crash never leaves a half-written file. */
function writeJsonAtomically(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n");
  renameSync(temporary, file);
}
