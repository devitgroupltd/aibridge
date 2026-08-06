/**
 * §5.4 point 2: per-session flush interval `max(3s, 3s × activeSessions)`, and a render is skipped
 * entirely if the text hasn't actually changed since the last frame sent. This sits above
 * `rate-governor.ts`: the governor decides whether a P2 call that's *made* goes through; this
 * decides *whether and when* to make one, so an idle session with an unchanged card costs nothing
 * and a burst of 50 events in one second collapses to a single scheduled render (§9 scenario 14).
 */

export interface FeedCoalescerOptions {
  activeSessionCount: () => number;
  /** §5.4 point 4's automatic quiet mode: while this returns true, the coalescing interval
   * doubles. Optional and defaulted to "never quiet" so every existing/test caller that doesn't
   * pass it keeps today's behaviour unchanged. Expected to be backed by
   * `RateGovernor.p2PressureExceeded()` - this class only consumes the signal, it doesn't compute
   * it, so the pressure calculation stays unit-testable on its own. */
  quietMode?: () => boolean;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Called at most once per flush, with the latest text at the time of the flush - never the
   * text captured when the timer was originally armed, so a rapid burst always sends the final
   * state rather than a stale intermediate one. */
  onFlush: (slug: string, text: string) => void;
}

export class FeedCoalescer {
  private readonly lastSentAtMs = new Map<string, number>();
  private readonly lastSentText = new Map<string, string>();
  private readonly pendingTimers = new Map<string, unknown>();
  private readonly latestText = new Map<string, string>();
  private readonly opts: FeedCoalescerOptions;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  // Plain field assignment, not a TS constructor parameter property: the Bridge runs under
  // `node --experimental-strip-types`, which does not implement that syntax (confirmed live -
  // see the matching note in rate-governor.ts's TokenBucket).
  constructor(opts: FeedCoalescerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  private interval(): number {
    const base = Math.max(3000, 3000 * this.opts.activeSessionCount());
    return this.opts.quietMode?.() ? base * 2 : base;
  }

  /** Call on every card re-render (i.e. on every hook event that changed the state), not just
   * ones you want sent - the "unchanged" and "too soon" skips happen in here. */
  notify(slug: string, text: string): void {
    if (this.lastSentText.get(slug) === text) return;
    this.latestText.set(slug, text);

    if (this.pendingTimers.has(slug)) return; // already armed - it will pick up latestText.

    const elapsedMs = this.now() - (this.lastSentAtMs.get(slug) ?? -Infinity);
    const waitMs = this.interval() - elapsedMs;
    if (waitMs <= 0) {
      this.flush(slug);
      return;
    }
    const handle = this.setTimeoutFn(() => {
      this.pendingTimers.delete(slug);
      this.flush(slug);
    }, waitMs);
    this.pendingTimers.set(slug, handle);
  }

  private flush(slug: string): void {
    const text = this.latestText.get(slug);
    if (text === undefined || text === this.lastSentText.get(slug)) return;
    this.lastSentText.set(slug, text);
    this.lastSentAtMs.set(slug, this.now());
    this.opts.onFlush(slug, text);
  }

  /** For session teardown - drops any armed timer without flushing, and forgets every per-slug
   * entry. Forgetting matters as much as the timer: a slug is derived from a prompt's first words
   * (`slug.ts`), so a later session can legitimately be handed the same one and would otherwise
   * inherit the removed session's dedupe state and have its first identical render skipped. */
  cancel(slug: string): void {
    const handle = this.pendingTimers.get(slug);
    if (handle !== undefined) {
      this.clearTimeoutFn(handle);
      this.pendingTimers.delete(slug);
    }
    this.forget(slug);
  }

  /** Turn boundary (§5.3: one card per turn). The next turn posts a *new* message, so the
   * "unchanged since the last frame sent" skip must not carry across it - the first render of turn
   * N+1 is frequently byte-identical to the last render of turn N (same header, same first step),
   * and skipping it would leave the new card empty until something else changed.
   *
   * Flushes any armed timer *first*, into the outgoing turn's own card. Without that, a render
   * pending when the turn ended would instead fire after the boundary and carry the *new* turn's
   * text, leaving the old card permanently missing everything after its last flush. */
  reset(slug: string): void {
    const armed = this.pendingTimers.get(slug);
    if (armed !== undefined) {
      this.clearTimeoutFn(armed);
      this.pendingTimers.delete(slug);
      this.flush(slug);
    }
    // `lastSentText` and `latestText` only - `lastSentAtMs` deliberately survives, so §5.4's
    // `max(3s, 3s × sessions)` interval still governs the new turn's first send. Clearing it too would
    // make every turn boundary an ungated immediate send, defeating the per-session budget this class
    // exists to enforce.
    this.lastSentText.delete(slug);
    this.latestText.delete(slug);
  }

  private forget(slug: string): void {
    this.lastSentText.delete(slug);
    this.lastSentAtMs.delete(slug);
    this.latestText.delete(slug);
  }
}
