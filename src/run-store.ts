import { DatabaseSync } from "node:sqlite";
import type { RunState, RunView } from "./runs.ts";

/** What's saved about a Run: everything but its progress, which only matters while it's live. */
export type SavedRun = Omit<RunView, "progress">;

const FINISHED: readonly RunState[] = ["landed", "rejected"];

/** Whether a Run in `state` has finished. Any state not listed in `FINISHED` counts as unfinished. */
export function isFinished(state: RunState): boolean {
  return FINISHED.includes(state);
}

/**
 * Saves the queue and Run records in a SQLite file in the data folder, so they
 * survive a restart. Each Run is one row: its state in its own column, so it
 * can be queried, and the rest as JSON, so new fields and states need no
 * schema change. Rows keep the order Prompts were sent in.
 */
export class RunStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        run TEXT NOT NULL
      );
    `);
  }

  /** Adds a Run, or updates it if it's already saved. */
  save(run: RunView): void {
    const { progress: _progress, ...saved } = run;
    this.db
      .prepare("INSERT INTO runs (id, state, run) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, run = excluded.run")
      .run(run.id, run.state, JSON.stringify(saved));
  }

  /** Runs that haven't finished (waiting or in progress), oldest first. */
  unfinished(): SavedRun[] {
    return this.select(`SELECT run FROM runs WHERE state NOT IN (${FINISHED.map(() => "?").join(", ")}) ORDER BY seq`, ...FINISHED);
  }

  /** The latest `limit` finished Runs, oldest first. */
  recentlyFinished(limit: number): SavedRun[] {
    const placeholders = FINISHED.map(() => "?").join(", ");
    return this.select(`SELECT run FROM (SELECT seq, run FROM runs WHERE state IN (${placeholders}) ORDER BY seq DESC LIMIT ?) ORDER BY seq`, ...FINISHED, limit);
  }

  close(): void {
    this.db.close();
  }

  private select(sql: string, ...params: Array<string | number>): SavedRun[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => JSON.parse(row.run as string) as SavedRun);
  }
}
