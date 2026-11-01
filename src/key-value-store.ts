import { DatabaseSync } from "node:sqlite";

export interface Entry {
  key: string;
  value: unknown;
}

/**
 * The platform's key-value store for Canvas features, in a SQLite file in the
 * data folder. Every entry belongs to one feature, so features can use the
 * same keys without clashing. It lives outside the Canvas repo, so nothing
 * that changes the Canvas (Landing, Replay) changes it. Values are
 * stored as JSON text.
 */
export class KeyValueStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entries (
        feature TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (feature, key)
      ) WITHOUT ROWID;
    `);
  }

  get(feature: string, key: string): unknown {
    const row = this.db.prepare("SELECT value FROM entries WHERE feature = ? AND key = ?").get(feature, key);
    return row === undefined ? undefined : JSON.parse(row.value as string);
  }

  set(feature: string, key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO entries (feature, key, value) VALUES (?, ?, ?) ON CONFLICT (feature, key) DO UPDATE SET value = excluded.value")
      .run(feature, key, JSON.stringify(value));
  }

  delete(feature: string, key: string): void {
    this.db.prepare("DELETE FROM entries WHERE feature = ? AND key = ?").run(feature, key);
  }

  /** A feature's entries whose keys start with `prefix`, sorted by key. */
  list(feature: string, prefix = ""): Entry[] {
    // substr rather than LIKE, so "%" and "_" in a prefix are taken literally.
    const rows = this.db
      .prepare("SELECT key, value FROM entries WHERE feature = ? AND substr(key, 1, length(?)) = ? ORDER BY key")
      .all(feature, prefix, prefix);
    return rows.map((row) => ({ key: row.key as string, value: JSON.parse(row.value as string) }));
  }

  close(): void {
    this.db.close();
  }
}
