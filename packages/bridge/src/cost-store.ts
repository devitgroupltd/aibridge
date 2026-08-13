import { openDatabase, type SqliteHandleLike } from "./sqlite.ts";

/**
 * Persists `cost-tracker.ts`'s spend events so `/budget`'s rolling 5-hour figure and burn-rate
 * alarm survive a `/restart`/`/merge` - found during the `/deep-check` sweep: `CostTracker` was
 * in-memory only, so a routine restart silently reset the fleet's spend to $0 and could re-arm the
 * burn-rate alarm's cooldown for no real reason. Lives in the same `aibridge.db` file (not a
 * second database) - one more `CREATE TABLE IF NOT EXISTS`, same shared handle (`sqlite.ts`) as
 * `session-store.ts`/`settings-store.ts` (see that module's own doc comment for why bun:sqlite/
 * node:sqlite are chosen at runtime, not statically).
 *
 * Deliberately a thin, dumb persistence shim - `cost-tracker.ts` stays the one place that knows
 * anything about windows/pruning/aggregation, so it's still unit-testable with no SQLite at all
 * (this class is injected as an optional `CostStorePort`, not a hard dependency).
 */
export interface CostEventRow {
  sessionId: string;
  atMs: number;
  costUsd: number;
}

export class CostStore {
  private readonly db: SqliteHandleLike;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cost_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        at_ms      INTEGER NOT NULL,
        cost_usd   REAL NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS cost_events_at_ms ON cost_events (at_ms);");
  }

  insert(sessionId: string, atMs: number, costUsd: number): void {
    this.db
      .prepare("INSERT INTO cost_events (session_id, at_ms, cost_usd) VALUES ($session_id, $at_ms, $cost_usd)")
      .run({ $session_id: sessionId, $at_ms: atMs, $cost_usd: costUsd });
  }

  /** Loaded once, at `CostTracker` construction, to reseed its in-memory maps after a restart. */
  all(): CostEventRow[] {
    const rows = this.db.prepare("SELECT session_id, at_ms, cost_usd FROM cost_events").all() as unknown as {
      session_id: string;
      at_ms: number;
      cost_usd: number;
    }[];
    return rows.map((r) => ({ sessionId: r.session_id, atMs: r.at_ms, costUsd: r.cost_usd }));
  }

  /** Mirrors `CostTracker.prune`'s in-memory retention window, so the table doesn't grow forever. */
  deleteOlderThan(cutoffMs: number): void {
    this.db.prepare("DELETE FROM cost_events WHERE at_ms < $cutoff").run({ $cutoff: cutoffMs });
  }

  close(): void {
    this.db.close();
  }
}
