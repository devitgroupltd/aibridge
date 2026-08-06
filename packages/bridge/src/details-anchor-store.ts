import { createRequire } from "node:module";

/**
 * §5.5's `details` button anchor - remembers which Telegram message_id carries which
 * (`slug`, `turnSeq`) button, so a later tap can *edit that message in place* (full log + button
 * removed) instead of always posting a brand-new message alongside it. Persisted (not just an
 * in-memory map) on the operator's own explicit request: an in-memory-only map would lose every
 * pending anchor on a `/restart`/`/deploy`, silently reverting to "send a new message" for every
 * button posted before that restart - correct as a *fallback*, but not as the normal case for a
 * Bridge that restarts far more often than an operator taps a two-day-old button. Same runtime
 * SQLite binding and same `aibridge.db` file as `session-store.ts`/`settings-store.ts`/
 * `cost-store.ts` - see `session-store.ts`'s own doc comment for why bun:sqlite/node:sqlite are
 * chosen at runtime, not statically.
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

/** How long an untapped anchor stays edit-in-place-able before `deleteOlderThan` sweeps it - long
 * enough that "I'll check that later" genuinely still works, short enough the table doesn't grow
 * forever. Not a hard UX guarantee: past this window the button just falls back to posting a new
 * message instead of editing (`index.ts`'s "no anchor on record" branch), never a dead button. */
export const DETAILS_ANCHOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function loadDatabaseCtor(): DatabaseCtor {
  const req = createRequire(import.meta.url);
  if (typeof Bun !== "undefined") {
    return (req("bun:sqlite") as { Database: DatabaseCtor }).Database;
  }
  return (req("node:sqlite") as { DatabaseSync: DatabaseCtor }).DatabaseSync;
}

export class DetailsAnchorStore {
  private readonly db: SqliteHandleLike;

  constructor(dbPath: string) {
    const Database = loadDatabaseCtor();
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS details_anchors (
        slug       TEXT    NOT NULL,
        turn_seq   INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        created_ms INTEGER NOT NULL,
        PRIMARY KEY (slug, turn_seq)
      );
    `);
  }

  /** Called once, right after `postDetailsButton` posts the anchor - `ON CONFLICT` rather than a
   * plain INSERT purely for replay-safety (a retried send after a transient failure shouldn't
   * throw on the primary key), not because the same (slug, turnSeq) is ever legitimately reposted. */
  set(slug: string, turnSeq: number, messageId: number, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO details_anchors (slug, turn_seq, message_id, created_ms)
         VALUES ($slug, $turn_seq, $message_id, $created_ms)
         ON CONFLICT(slug, turn_seq) DO UPDATE SET message_id = excluded.message_id, created_ms = excluded.created_ms`,
      )
      .run({ $slug: slug, $turn_seq: turnSeq, $message_id: messageId, $created_ms: nowMs });
  }

  get(slug: string, turnSeq: number): number | undefined {
    const row = this.db
      .prepare("SELECT message_id FROM details_anchors WHERE slug = $slug AND turn_seq = $turn_seq")
      .get({ $slug: slug, $turn_seq: turnSeq }) as { message_id: number } | undefined;
    return row?.message_id;
  }

  /** Called once the anchor has actually been edited-in-place (button removed - nothing will ever
   * need to look it up again), so the table only ever holds rows for buttons that are *still
   * tappable*, not one row per turn a session has ever run. */
  delete(slug: string, turnSeq: number): void {
    this.db.prepare("DELETE FROM details_anchors WHERE slug = $slug AND turn_seq = $turn_seq").run({ $slug: slug, $turn_seq: turnSeq });
  }

  /** Safety net for the buttons that are never tapped at all (the common case) - without this the
   * table grows by one row per turn, forever. A much longer window than `cost-store.ts`'s: these
   * rows are meant to stay usable for as long as an operator might plausibly scroll back and tap
   * one, not just a budget-alarm's rolling week. */
  deleteOlderThan(cutoffMs: number): void {
    this.db.prepare("DELETE FROM details_anchors WHERE created_ms < $cutoff").run({ $cutoff: cutoffMs });
  }

  close(): void {
    this.db.close();
  }
}
