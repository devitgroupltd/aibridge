import { createRequire } from "node:module";

/**
 * Small global key/value store for fleet-wide preferences that need to survive a Bridge restart -
 * first user is the NL-router's destructive-command confirm toggle (`nl-router.ts`/`nl-confirm.ts`),
 * which is deliberately *not* a `session-store.ts` column: it isn't scoped to any one session, the
 * same reasoning `/budget`/`/settings` already use for staying control-topic-only rather than
 * per-session. Lives in the same `aibridge.db` file (not a second database) - one `CREATE TABLE IF
 * NOT EXISTS` alongside `sessions`, same runtime SQLite binding as `session-store.ts` (see that
 * file's own doc comment for why bun:sqlite/node:sqlite are chosen at runtime, not statically).
 */
interface SqliteStatementLike {
  run(params: Record<string, unknown>): unknown;
  get(params: Record<string, unknown>): unknown;
}
interface SqliteHandleLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}
type DatabaseCtor = new (path: string) => SqliteHandleLike;

function loadDatabaseCtor(): DatabaseCtor {
  const req = createRequire(import.meta.url);
  if (typeof Bun !== "undefined") {
    return (req("bun:sqlite") as { Database: DatabaseCtor }).Database;
  }
  return (req("node:sqlite") as { DatabaseSync: DatabaseCtor }).DatabaseSync;
}

export class SettingsStore {
  private readonly db: SqliteHandleLike;

  constructor(dbPath: string) {
    const Database = loadDatabaseCtor();
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Absent key -> `fallback`, not `undefined` - every call site already knows its own default
   * (e.g. "nl_confirm_enabled" defaults to `"true"`), so this never forces a null-check at the
   * read site for a row that was simply never written yet. */
  get(key: string, fallback: string): string {
    const row = this.db.prepare("SELECT value FROM bridge_settings WHERE key = $key").get({ $key: key }) as { value: string } | undefined;
    return row?.value ?? fallback;
  }

  set(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO bridge_settings (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run({ $key: key, $value: value });
  }

  close(): void {
    this.db.close();
  }
}
