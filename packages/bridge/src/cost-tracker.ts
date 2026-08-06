/**
 * §5.7/§10.5's per-session spend tracking, fed by `otlp-listener.ts`'s `claude_code.api_request`
 * log events (confirmed live 2026-08-04 against a real `claude -p` run pointed at a throwaway OTLP
 * capture server - see the 0.24.0 changelog entry). Each event already carries a complete `cost_usd`
 * for that one API call, so this is a plain running sum per `session.id`, not a delta reconstruction
 * off the `/v1/metrics` cumulative-vs-delta ambiguity the plan's original §5.7 design assumed.
 *
 * Pure and dependency-free by default - the optional `CostStorePort` (backed live by
 * `cost-store.ts`'s SQLite table) is injected, not imported, so this stays unit-testable without a
 * database. Found during the `/deep-check` sweep: without persistence, `/budget`'s rolling 5-hour
 * spend and the burn-rate alarm silently reset to $0 on every `/restart`/`/deploy` - a laptop-class
 * bug that's easy to never notice (nothing crashes, the number is just quietly wrong).
 */

const RETENTION_MS = 8 * 24 * 60 * 60 * 1000; // just past the weekly window, so /budget's weekly figure never loses an entry early

interface SpendEntry {
  atMs: number;
  costUsd: number;
}

export interface CostStorePort {
  insert(sessionId: string, atMs: number, costUsd: number): void;
  all(): { sessionId: string; atMs: number; costUsd: number }[];
  deleteOlderThan(cutoffMs: number): void;
}

export class CostTracker {
  private readonly bySession = new Map<string, SpendEntry[]>();
  private readonly store?: CostStorePort;

  /** `store` is optional and defaults to none (today's in-memory-only behaviour, still what every
   * existing test constructs) - `index.ts` is the only caller expected to pass a real one. Reseeds
   * `bySession` synchronously from `store.all()` so the very first `/budget`/`/ls` after a restart
   * already reflects spend from before the restart, not just whatever accrues from this point on. */
  constructor(store?: CostStorePort) {
    this.store = store;
    for (const e of store?.all() ?? []) {
      const entries = this.bySession.get(e.sessionId) ?? [];
      entries.push({ atMs: e.atMs, costUsd: e.costUsd });
      this.bySession.set(e.sessionId, entries);
    }
  }

  record(sessionId: string, atMs: number, costUsd: number): void {
    const entries = this.bySession.get(sessionId) ?? [];
    entries.push({ atMs, costUsd });
    this.bySession.set(sessionId, entries);
    this.store?.insert(sessionId, atMs, costUsd);
  }

  /** Drops entries older than `RETENTION_MS` - called opportunistically on record, not on a timer,
   * since spend for a dead/removed session simply stops accumulating new entries to prune. Mirrors
   * the same cutoff into `store` so the on-disk table doesn't grow forever either. */
  prune(nowMs: number): void {
    for (const [sessionId, entries] of this.bySession) {
      const kept = entries.filter((e) => nowMs - e.atMs <= RETENTION_MS);
      if (kept.length === 0) this.bySession.delete(sessionId);
      else this.bySession.set(sessionId, kept);
    }
    this.store?.deleteOlderThan(nowMs - RETENTION_MS);
  }

  /** Sum of every recorded call for this session, no time window - what `/ls`'s cost column shows
   * (§5.7: "Per-session spend in `/ls`"). */
  lifetimeSpend(sessionId: string): number {
    return (this.bySession.get(sessionId) ?? []).reduce((sum, e) => sum + e.costUsd, 0);
  }

  /** Spend within `windowMs` of `nowMs` for one session - what `/budget`'s per-session breakdown and
   * the burn-rate alarm both key off of. */
  spendSince(sessionId: string, windowMs: number, nowMs: number): number {
    return (this.bySession.get(sessionId) ?? [])
      .filter((e) => nowMs - e.atMs <= windowMs)
      .reduce((sum, e) => sum + e.costUsd, 0);
  }

  /** Fleet-wide spend within `windowMs` of `nowMs`, across every session this tracker has ever seen
   * a request for (dead or alive - a killed session's spend still counts against the rolling window
   * it was actually incurred in). */
  fleetSpendSince(windowMs: number, nowMs: number): number {
    let total = 0;
    for (const sessionId of this.bySession.keys()) {
      total += this.spendSince(sessionId, windowMs, nowMs);
    }
    return total;
  }

  /** Every session_id with at least one recorded call - callers join this against the routing table
   * to resolve a slug for display. */
  sessionIds(): string[] {
    return [...this.bySession.keys()];
  }
}

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
