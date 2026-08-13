/**
 * §5.4's two-token, three-lane budget. **P0** (permission prompts/resolutions/
 * `answerCallbackQuery`) and **P1** (`reply` messages, lifecycle notices) share the control bot's
 * bucket, with P0 always drained first; **P2** (feed card edits) is the feed bot's own bucket and
 * is droppable - a P2 call made while its bucket is empty is discarded outright, never queued,
 * because a stale intermediate frame has no value once a newer one exists. The two buckets are
 * separate `TokenBucket` instances specifically so saturating one can never delay the other (§9
 * scenario 15) - that independence is the entire reason the design uses two bot tokens.
 */

import type { LogFn } from "./logger.ts";

export type Lane = "P0" | "P1" | "P2";

/** Thrown by a `schedule()` callback to report a real Telegram 429 - `retryAfterSec` should come
 * straight from the response body's `retry_after` (§5.4: "honour `retry_after` ... exactly"). */
export class RateLimitedError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`rate limited for ${retryAfterSec}s`);
    this.retryAfterSec = retryAfterSec;
  }
}

/** §5.4 says to honour `retry_after` exactly, but a bucket paused on an unbounded number taken
 * straight off the wire is a bucket that may never resume - a garbled or hostile `retry_after` of
 * 10^9 would mute the fleet for the process's lifetime. One hour is longer than any real Telegram
 * flood-wait and still finite; a non-finite or negative value falls back to one second. */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** How soon to re-check a queue the bucket couldn't afford. Short enough that a refilled token is
 * spent promptly (the control bucket refills continuously, ~one token every 3s at 20/min), long
 * enough not to spin. */
const DRAIN_RETRY_MS = 1000;

export function clampRetryAfterMs(retryAfterSec: number): number {
  if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) return 1000;
  return Math.min(retryAfterSec * 1000, MAX_RETRY_AFTER_MS);
}

/** A classic continuous-refill token bucket: `capacity` tokens available per `refillIntervalMs`,
 * refilling smoothly rather than in one lump at the interval boundary (so "20/minute" doesn't
 * mean "all 20 the instant a new minute starts"). `pauseFor` implements the 429 handling - while
 * paused, `tryTake` always fails regardless of accumulated tokens. */
class TokenBucket {
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillMs: number;
  private pausedUntilMs = 0;

  // Plain field assignment rather than TS constructor parameter properties: the Bridge runs
  // under `node --experimental-strip-types`, which strips TypeScript syntax but does not
  // implement parameter-property semantics - confirmed live the hard way (§9's own convention of
  // catching this kind of thing before it ships would have caught it sooner as a `node -c` smoke
  // check; recorded here so the next class in this file doesn't repeat it).
  constructor(capacity: number, refillIntervalMs: number, now: () => number) {
    this.capacity = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.now = now;
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) return;
    const rate = this.capacity / this.refillIntervalMs;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * rate);
    this.lastRefillMs = nowMs;
  }

  tryTake(): boolean {
    if (this.now() < this.pausedUntilMs) return false;
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  pauseFor(ms: number): void {
    this.pausedUntilMs = Math.max(this.pausedUntilMs, this.now() + ms);
  }

  /** How long this bucket stays paused, or 0 if it isn't - lets the governor schedule one wake at the
   * end of a 429 pause instead of polling through it. */
  pausedForMs(): number {
    return Math.max(0, this.pausedUntilMs - this.now());
  }
}

interface ControlTask {
  lane: "P0" | "P1";
  run: () => Promise<unknown>;
  /** Resolves/rejects `scheduleAsync`'s returned promise once this task's own outcome is final
   * (delivered, or retries exhausted). `schedule()` wires no-op callbacks here - it stays
   * fire-and-forget, same as before this existed. */
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  retriesLeft: number;
  backoffMs: number;
}

export interface RateGovernorOptions {
  /** Tokens available per `refillIntervalMs`, for both buckets. Default 20 (§5.4's Telegram limit). */
  capacity?: number;
  /** Default 60_000 (one minute). */
  refillIntervalMs?: number;
  now?: () => number;
  /** Injectable so `runControlTask`'s backoff schedule (1s/2s/4s, §5.4) is fake-clock-testable
   * rather than a real wall-clock wait. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** Paired with `setTimeoutFn` so the self-arming drain retry can be cancelled by `pump()`; tests
   * inject both together. */
  clearTimeoutFn?: (handle: unknown) => void;
  log?: LogFn;
}

/** §5.4 point 4's window: 60s, and a minimum sample count before the drop rate means anything -
 * one dropped edit out of one attempt is a 100% "rate" that says nothing about pressure, so
 * quiet mode never engages below `MIN_SAMPLES_FOR_PRESSURE` P2 attempts in the window (§9's
 * silent-wrong discipline: an unguarded ratio on tiny volume would false-trigger on ordinary,
 * healthy single-session traffic). */
const QUIET_MODE_WINDOW_MS = 60_000;
const MIN_SAMPLES_FOR_PRESSURE = 4;

export class RateGovernor {
  private readonly controlBucket: TokenBucket;
  private readonly feedBucket: TokenBucket;
  private readonly p0Queue: ControlTask[] = [];
  private readonly p1Queue: ControlTask[] = [];
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private drainRetryTimer: unknown;
  private readonly log: LogFn;
  private readonly now: () => number;
  private p2DroppedCount = 0;
  /** Guards `drainControl` against running twice concurrently (0.101.0) - see that method's own
   * doc comment for what running twice used to cost. */
  private draining = false;
  /** Rolling window of recent P2 outcomes, pruned to the last 60s on every read/write - backs
   * `p2PressureExceeded()` (§5.4 point 4: "if P2 drops exceed 50% over a 60s window"). */
  private readonly p2Outcomes: Array<{ atMs: number; dropped: boolean }> = [];

  constructor(opts: RateGovernorOptions = {}) {
    const now = opts.now ?? Date.now;
    const capacity = opts.capacity ?? 20;
    const refillIntervalMs = opts.refillIntervalMs ?? 60_000;
    this.controlBucket = new TokenBucket(capacity, refillIntervalMs, now);
    this.feedBucket = new TokenBucket(capacity, refillIntervalMs, now);
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.log = opts.log ?? (() => {});
    this.now = now;
  }

  /** P0/P1 are queued when their bucket is empty and drained as tokens free up (never dropped);
   * P2 is attempted once and discarded on failure to acquire a token (§9 scenario 16).
   *
   * Returns a promise that resolves once this attempt settles (0.97.0, for `FeedCoalescer.onFlush`
   * callers that want to await it - see `scheduleP2Async`'s own doc comment) - existing callers that
   * treated this as fire-and-forget are unaffected, since they never captured the old `void` return
   * either. Never rejects, on any lane: that was already true for P2, and for P0/P1 this keeps the
   * exact "swallow the rejection, the ERROR log inside `runControlTask` is the record of a real
   * failure" contract `schedule()` always had, rather than newly surfacing an unhandled rejection to
   * whichever caller happens to be the first to await it. */
  schedule(lane: Lane, fn: () => Promise<void>): Promise<void> {
    if (lane === "P2") return this.scheduleP2Async(fn);
    // Fire-and-forget: swallow the rejection `scheduleAsync` would otherwise surface, so a
    // caller that doesn't need the result (and doesn't await anything) never sees an unhandled
    // rejection - the ERROR log inside `runControlTask` is still the record of a real failure.
    return this.scheduleAsync(lane, fn).then(
      () => undefined,
      () => undefined,
    );
  }

  /** Same P0/P1 semantics as `schedule()`, but returns a promise resolving to `fn`'s own result
   * once actually delivered (or rejecting once the 3-retry budget is exhausted) - what a caller
   * that needs a `message_id` back (a permission card, a question card) actually needs, since
   * `schedule()` alone has nowhere to hand that back. */
  scheduleAsync<T>(lane: "P0" | "P1", fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.enqueueControl({
        lane,
        run: fn,
        resolve: resolve as (value: unknown) => void,
        reject,
        retriesLeft: 3,
        backoffMs: 1000,
      });
    });
  }

  /** Same P2 semantics as `schedule("P2", fn)` (attempted once, dropped outright - never queued,
   * never retried - if the feed bucket is empty), but returns a promise that resolves once this
   * attempt is actually *settled*, not merely scheduled. A dropped attempt resolves immediately -
   * there is nothing in flight to wait for. Never rejects: a P2 failure has nothing for a waiter to
   * react to (§5.4 - a newer frame supersedes a dropped one either way), so the only thing this
   * promise communicates is "this attempt is over, one way or another".
   *
   * Exists for 0.97.0's reply/feed ordering fix: `onBeforeReply` (pipe-server.ts) used to fire this
   * lane's send fire-and-forget, which only gave the feed card a *head start* on the reply's own,
   * separately-throttled P1 lane - still a race, just a narrower one (§9's live-observed 0.91.0
   * report). Awaiting this instead means the reply's own send genuinely cannot begin until the feed
   * bot's HTTP call for the card describing it has already completed - the same "await each send
   * before issuing the next" discipline every Telegram bot library recommends for in-order delivery,
   * extended across the P1/P2 boundary specifically at the one moment they're causally linked. */
  scheduleP2Async(fn: () => Promise<void>): Promise<void> {
    if (!this.feedBucket.tryTake()) {
      this.p2DroppedCount += 1;
      this.recordP2Outcome(true);
      this.log("WARN", "P2 feed edit dropped - feed bucket empty");
      return Promise.resolve();
    }
    this.recordP2Outcome(false);
    return fn().catch((err) => {
      if (err instanceof RateLimitedError) {
        this.feedBucket.pauseFor(clampRetryAfterMs(err.retryAfterSec));
      }
      // Never retried, success or failure (§5.4): a newer frame supersedes a dropped one anyway.
    });
  }

  private recordP2Outcome(dropped: boolean): void {
    const nowMs = this.now();
    this.p2Outcomes.push({ atMs: nowMs, dropped });
    this.prunePressureWindow(nowMs);
  }

  private prunePressureWindow(nowMs: number): void {
    while (this.p2Outcomes.length > 0 && nowMs - this.p2Outcomes[0]!.atMs > QUIET_MODE_WINDOW_MS) {
      this.p2Outcomes.shift();
    }
  }

  /** §5.4 point 4's quiet-mode trigger: more than half of P2 attempts in the last 60s were
   * dropped. Below `MIN_SAMPLES_FOR_PRESSURE` attempts in the window this always reads false -
   * there isn't enough signal yet to call it pressure rather than noise. Pure and clock-driven
   * (via the same injectable `now` as the token buckets), so a caller can poll it on any cadence
   * without this class needing its own timer. */
  p2PressureExceeded(): boolean {
    const nowMs = this.now();
    this.prunePressureWindow(nowMs);
    if (this.p2Outcomes.length < MIN_SAMPLES_FOR_PRESSURE) return false;
    const droppedCount = this.p2Outcomes.filter((o) => o.dropped).length;
    return droppedCount / this.p2Outcomes.length > 0.5;
  }

  private enqueueControl(task: ControlTask): void {
    (task.lane === "P0" ? this.p0Queue : this.p1Queue).push(task);
    // Deferred to a microtask rather than drained synchronously: a hook batch that schedules a
    // P1 lifecycle notice and a P0 permission prompt in the same tick must still let P0 win the
    // one available token (§9 scenario 16) - draining inline here would hand it to whichever of
    // the two happened to call `schedule()` first instead.
    queueMicrotask(() => this.drainControl());
  }

  /** Drains whatever P0/P1 work the control bucket can currently afford, P0 first. The governor
   * arms its own retry timers now (see `armDrainRetry`), so production no longer depends on an
   * external interval calling this; tests still call it to drain deterministically after advancing
   * their injected clock. */
  pump(): void {
    // Cancel the pending wake rather than only clearing the flag - otherwise it fires later against a
    // cleared flag and the next `armDrainRetry` adds a second concurrent timer, quietly breaking the
    // "at most one" invariant below (harmless in effect, since `drainControl` is idempotent, but it
    // would make that invariant untestable).
    if (this.drainRetryTimer !== undefined) {
      this.clearTimeoutFn(this.drainRetryTimer);
      this.drainRetryTimer = undefined;
    }
    this.drainControl();
  }

  /** At most one retry timer in flight - a queue of 200 deferred tasks must not become 200 timers,
   * and while the bucket is *paused* by a 429 there is no point waking every second for what may be
   * up to an hour (`clampRetryAfterMs`), so the wake is scheduled for when the pause actually ends.
   *
   * §9, found live 2026-08-09: this used to track "is a wake already armed?" in a second boolean
   * field (`drainRetryTimerArmed`) alongside `drainRetryTimer` itself - both were always set/cleared
   * together in every one of the three places that touch either (here, `pump()`, and this timer's
   * own callback), so the two could never actually disagree; `drainRetryTimer !== undefined` alone
   * already carries the exact same information `drainRetryTimerArmed` did, just without a second
   * field a future edit could accidentally desync from the first. */
  private armDrainRetry(): void {
    if (this.drainRetryTimer !== undefined) return;
    const pausedForMs = this.controlBucket.pausedForMs();
    this.drainRetryTimer = this.setTimeoutFn(
      () => {
        this.drainRetryTimer = undefined;
        this.drainControl();
      },
      pausedForMs > 0 ? pausedForMs + 50 : DRAIN_RETRY_MS,
    );
  }

  /** Drained one task at a time, awaiting each one's actual Telegram send before starting the
   * next - not just dequeuing in FIFO order and firing every affordable task's HTTP call at once.
   *
   * 0.101.0: it used to be the latter (`void this.runControlTask(task)` inside this same loop,
   * never awaited), which kept strict *dequeue* order but not strict *delivery* order - two P1
   * sends dequeued back-to-back (e.g. a turn-start "Click Details" lifecycle notice, then a
   * `reply`) each fired their own `fetch` and raced each other over the network, so whichever HTTP
   * response actually reached Telegram first decided the messages' visible order, not which was
   * dequeued first. Live-reproduced 2026-08-08: a reply sent within the same tick as a lifecycle
   * notice landed ahead of it in the topic even though the notice was enqueued (and dequeued)
   * first - the same "reply appears out of order" symptom 0.97.0 already fixed for the P2-vs-P1
   * boundary, just one lane over. Awaiting each send before starting the next is the same "await
   * every send before issuing the next" discipline `scheduleP2Async`'s own doc comment already
   * cites - now applied within a lane, not just across the P1/P2 boundary.
   *
   * `draining` guards against two overlapping loops (one already awaiting a send, a second started
   * by a fresh `enqueueControl` or `armDrainRetry` wake landing mid-await) - re-entering would
   * reintroduce the exact concurrent-send race this method exists to remove. A task enqueued while
   * a loop is already running doesn't need a second loop anyway: this `for` re-reads the queue
   * fronts every iteration, so the running loop picks it up itself. */
  private async drainControl(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const task = this.p0Queue[0] ?? this.p1Queue[0];
        if (!task) return;
        if (!this.controlBucket.tryTake()) {
          // The bucket is empty (or paused) but work is still queued - nothing else is guaranteed to
          // come along and re-drain it, so own the retry. Without this, a burst that exhausts the
          // 20/min budget leaves the overflow parked until the operator happens to trigger another
          // send: buttons keep spinning on the phone even though tokens refilled seconds later.
          this.armDrainRetry();
          return;
        }
        if (this.p0Queue[0] === task) this.p0Queue.shift();
        else this.p1Queue.shift();
        await this.runControlTask(task);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runControlTask(task: ControlTask): Promise<void> {
    try {
      const result = await task.run();
      task.resolve(result);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        const pauseMs = clampRetryAfterMs(err.retryAfterSec);
        this.controlBucket.pauseFor(pauseMs);
        // Re-queued ahead of newer work, retry budget untouched - a 429 is the bucket's fault,
        // not this task's, so it shouldn't spend one of the task's 3 retries.
        (task.lane === "P0" ? this.p0Queue : this.p1Queue).unshift(task);
        // ...and a wake armed for the end of the pause. Without this, the only things that ever
        // re-drain are a *new* `enqueueControl` and the non-429 retry path - so a 429 on the last
        // send before an idle stretch leaves the requeued task parked indefinitely. When that task is
        // the permission card a session is blocked waiting on, nothing else will ever call
        // `schedule()` for that session, and the fleet deadlocks until the §6.5 sweep or a restart.
        // `armDrainRetry` (not a bare `setTimeout`) so a burst of 429s shares one wake.
        this.armDrainRetry();
        return;
      }
      if (task.retriesLeft > 0) {
        const delayMs = task.backoffMs;
        task.retriesLeft -= 1;
        task.backoffMs *= 2;
        this.setTimeoutFn(() => {
          (task.lane === "P0" ? this.p0Queue : this.p1Queue).unshift(task);
          this.drainControl();
        }, delayMs);
        return;
      }
      // §9 scenario 41: exhausted the retry budget - log loud, leave whatever this task was
      // supposed to deliver (a permission prompt, a reply) undelivered rather than pretend it went out.
      this.log("ERROR", `${task.lane} send failed after 3 retries: ${(err as Error).message}`);
      task.reject(err);
    }
  }

  get droppedP2Count(): number {
    return this.p2DroppedCount;
  }
}
