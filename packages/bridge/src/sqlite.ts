import { createRequire } from "node:module";

/**
 * The one SQLite handle factory behind `session-store.ts`, `settings-store.ts`, `cost-store.ts` and
 * `details-anchor-store.ts`. All four had grown a verbatim copy of the same three interfaces, the
 * same `loadDatabaseCtor()`, and the same three-line constructor preamble - four places to keep in
 * step for something whose behaviour must be identical across all of them by definition (they all
 * open the *same* `aibridge.db` file).
 *
 * The binding is chosen at runtime rather than statically importing `bun:sqlite`: a node-pty
 * (Windows ConPTY) write that succeeds against a perfectly healthy child process still throws an
 * unhandled "Socket is closed" from node-pty's internal stream on the very next tick when the
 * Bridge itself runs under Bun (confirmed live, 2026-08-03, with a minimal repro outside this
 * codebase) - so production keeps running under plain Node (`node:sqlite`), while `bun test` (§9's
 * test runner) picks up `bun:sqlite` instead. Both expose the same `.exec`/`.prepare(sql)
 * .run/.get/.all`/`.close` shape, confirmed live against this exact Bun version.
 *
 * `createRequire` rather than a dynamic `import()` so this stays synchronous - both modules are
 * built-ins reachable through either runtime's CJS interop, so there's no reason to make every
 * store's construction (and every caller of `new SessionStore(...)`) async just to pick one of two
 * built-in modules.
 */
export interface SqliteStatementLike {
  run(params?: Record<string, unknown>): unknown;
  get(params?: Record<string, unknown>): unknown;
  all(params?: Record<string, unknown>): unknown[];
}

export interface SqliteHandleLike {
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

/**
 * How long a blocked writer waits for the write lock before giving up with `SQLITE_BUSY`.
 *
 * Both bindings default this to 0 - i.e. a contended write throws immediately rather than waiting.
 * Within a single Bridge process that never mattered: every store call here is synchronous, so the
 * event loop already serializes them and the four handles can't contend. The window that *is* real
 * is `respawnSelfAndExit` (index.ts), which starts the successor process and only then calls
 * `process.exit(0)` - for that moment two Bridge processes hold `aibridge.db` open at once, and a
 * `SQLITE_BUSY` there would reach `process.on("uncaughtException")` and take the new Bridge down on
 * the spot. Five seconds is far longer than any write here takes and costs nothing when uncontended.
 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens (creating if needed) `dbPath` with the pragmas every store in this codebase needs, and
 * nothing else - each store still owns its own `CREATE TABLE IF NOT EXISTS`, since the schema is
 * the one part that genuinely differs between them.
 */
export function openDatabase(dbPath: string): SqliteHandleLike {
  const Database = loadDatabaseCtor();
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return db;
}
