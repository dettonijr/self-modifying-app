import { DatabaseSync } from "node:sqlite";
import type { LogEntry, RunState, RunView } from "./runs.ts";

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
 * schema change. Rows keep the order Prompts were sent in. Each Run's log is
 * kept in its own table, one row per entry, so adding one never rewrites the
 * rest.
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
      CREATE TABLE IF NOT EXISTS log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        entry TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS log_by_run ON log (run_id, seq);
    `);
  }

  /** Adds a Run, or updates it if it's already saved. Its log is saved separately, by `appendLog`. */
  save(run: RunView): void {
    const { progress: _progress, log: _log, ...saved } = run;
    this.db
      .prepare("INSERT INTO runs (id, state, run) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, run = excluded.run")
      .run(run.id, run.state, JSON.stringify(saved));
  }

  /** Adds an entry to the end of a Run's log. */
  appendLog(runId: string, entry: LogEntry): void {
    this.db.prepare("INSERT INTO log (run_id, entry) VALUES (?, ?)").run(runId, JSON.stringify(entry));
  }

  /** Every saved Run with its whole log, in the order they were sent. */
  all(): SavedRun[] {
    const logs = new Map<string, LogEntry[]>();
    for (const row of this.db.prepare("SELECT run_id, entry FROM log ORDER BY seq").all()) {
      const id = row.run_id as string;
      if (!logs.has(id)) logs.set(id, []);
      logs.get(id)!.push(JSON.parse(row.entry as string) as LogEntry);
    }
    return this.select("SELECT run FROM runs ORDER BY seq").map((run) => ({ ...run, log: logs.get(run.id) ?? [] }));
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
