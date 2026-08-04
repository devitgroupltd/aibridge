import { readFileSync, writeFileSync } from "node:fs";

/**
 * Persists `startPolling`'s Telegram `getUpdates` offset across a restart (§4.5.1/§9) - see
 * `telegram.ts`'s own note on why an in-memory-only offset replays stale history on every restart.
 * A tiny standalone JSON file rather than a table in `aibridge.db`: this has nothing to do with
 * session state, and reading it must never depend on the DB's own schema/migration being current.
 */
export function loadOffset(offsetPath: string): number {
  try {
    const parsed = JSON.parse(readFileSync(offsetPath, "utf8")) as { offset?: unknown };
    return typeof parsed.offset === "number" ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

/** Synchronous and best-effort - called on the hot path of every single update, before that
 * update is handled, so a slow or failing write must never block or crash the poll loop. */
export function saveOffset(offsetPath: string, offset: number, onError?: (err: unknown) => void): void {
  try {
    writeFileSync(offsetPath, JSON.stringify({ offset }));
  } catch (err) {
    onError?.(err);
  }
}
