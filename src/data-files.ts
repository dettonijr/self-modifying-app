import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Reads a non-negative number stored under `key` in a JSON file in the data
 * folder, or `undefined` if the file doesn't exist.
 */
export function readNumber(file: string, key: string): number | undefined {
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
export function writeJsonAtomically(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n");
  renameSync(temporary, file);
}
