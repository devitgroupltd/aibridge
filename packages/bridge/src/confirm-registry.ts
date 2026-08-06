/**
 * The one pending-operator-confirmation registry behind `nl-confirm.ts`, `fleet-confirm.ts`,
 * `stale-confirm.ts` and `voice-confirm.ts`. Those four had grown byte-identical `add`/`resolve`
 * bodies over four different payload types, which cost two real bugs rather than only duplication:
 *
 * - **Expired taps were silently dead.** Every handler did `const p = registry.resolve(id); if (!p)
 *   return;`, and `resolve` returned `undefined` for "expired" and "never existed" alike. Since
 *   `answerCallbackQuery` had already cleared the spinner, tapping a card one minute past its TTL
 *   produced no edit, no message and no log - "a stale button left live would look tappable but
 *   silently do nothing", which is the exact failure §6.5 forbids. `take` reports expiry separately
 *   so the caller can say so.
 * - **Nothing ever swept them.** Entries were dropped only by `resolve`, so an untapped card leaked
 *   for the lifetime of a daemon designed to run for weeks - a 200-message backlog burst pinned 200
 *   full message payloads permanently. `takeExpired` gives the periodic sweep in `index.ts` (which
 *   already swept `browse-nav.ts`'s registry) the same handle for these four.
 *
 * Clock injection defaults to `monotonicNowMs` (§7.4) exactly as each copy did: these only ever
 * compute a duration, and a wall clock is the wrong tool for that across a sleep.
 */
import { monotonicNowMs } from "./monotonic-clock.ts";

export interface ConfirmRegistryOptions {
  ttlMs?: number;
  /** Clock injection for expiry tests - never `Date.now()` directly in the class body. */
  now?: () => number;
}

/** Anything keyed by a short id and stamped on insert. */
export interface ConfirmEntry {
  id: string;
  createdAt: number;
}

export class ConfirmRegistry<T extends ConfirmEntry> {
  private readonly pending = new Map<string, T>();
  protected readonly ttlMs: number;
  protected readonly now: () => number;

  // Plain field assignment, not TS parameter properties - the Bridge runs under
  // `node --experimental-strip-types`, which strips the syntax without implementing the semantics
  // (see the matching notes in rate-governor.ts and feed-coalescer.ts).
  constructor(defaultTtlMs: number, opts: ConfirmRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? defaultTtlMs;
    this.now = opts.now ?? monotonicNowMs;
  }

  add(entry: Omit<T, "createdAt">): void {
    this.pending.set(entry.id, { ...entry, createdAt: this.now() } as T);
  }

  /** Pops the entry and says whether it was already past its TTL. `undefined` means the id is
   * genuinely unknown (a duplicate tap on an already-answered card, or a tap left over from before
   * a Bridge restart) - the one case where saying nothing is right. */
  take(id: string): { entry: T; expired: boolean } | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    return { entry, expired: this.now() - entry.createdAt > this.ttlMs };
  }

  /** An unknown *or* expired id is a no-op - kept for callers that genuinely don't distinguish the
   * two. Prefer `take` anywhere an operator is waiting for feedback from their own tap. */
  resolve(id: string): T | undefined {
    const taken = this.take(id);
    return taken && !taken.expired ? taken.entry : undefined;
  }

  /** Removes and returns everything past its TTL, so the caller can mark each card expired. */
  takeExpired(): T[] {
    const now = this.now();
    const out: T[] = [];
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt > this.ttlMs) {
        this.pending.delete(id);
        out.push(entry);
      }
    }
    return out;
  }

  get size(): number {
    return this.pending.size;
  }
}
