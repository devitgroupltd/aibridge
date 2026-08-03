/**
 * §5.4's two-token, three-lane budget. **P0** (permission prompts/resolutions/
 * `answerCallbackQuery`) and **P1** (`reply` messages, lifecycle notices) share the control bot's
 * bucket, with P0 always drained first; **P2** (feed card edits) is the feed bot's own bucket and
 * is droppable - a P2 call made while its bucket is empty is discarded outright, never queued,
 * because a stale intermediate frame has no value once a newer one exists. The two buckets are
 * separate `TokenBucket` instances specifically so saturating one can never delay the other (§9
 * scenario 15) - that independence is the entire reason the design uses two bot tokens.
 */

export type Lane = "P0" | "P1" | "P2";

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

/** Thrown by a `schedule()` callback to report a real Telegram 429 - `retryAfterSec` should come
 * straight from the response body's `retry_after` (§5.4: "honour `retry_after` ... exactly"). */
export class RateLimitedError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`rate limited for ${retryAfterSec}s`);
    this.retryAfterSec = retryAfterSec;
  }
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
}

interface ControlTask {
  lane: "P0" | "P1";
  run: () => Promise<void>;
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
  log?: LogFn;
}

export class RateGovernor {
  private readonly controlBucket: TokenBucket;
  private readonly feedBucket: TokenBucket;
  private readonly p0Queue: ControlTask[] = [];
  private readonly p1Queue: ControlTask[] = [];
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly log: LogFn;
  private p2DroppedCount = 0;

  constructor(opts: RateGovernorOptions = {}) {
    const now = opts.now ?? Date.now;
    const capacity = opts.capacity ?? 20;
    const refillIntervalMs = opts.refillIntervalMs ?? 60_000;
    this.controlBucket = new TokenBucket(capacity, refillIntervalMs, now);
    this.feedBucket = new TokenBucket(capacity, refillIntervalMs, now);
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.log = opts.log ?? (() => {});
  }

  /** P0/P1 are queued when their bucket is empty and drained as tokens free up (never dropped);
   * P2 is attempted once and discarded on failure to acquire a token (§9 scenario 16). */
  schedule(lane: Lane, fn: () => Promise<void>): void {
    if (lane === "P2") {
      this.scheduleP2(fn);
      return;
    }
    this.enqueueControl({ lane, run: fn, retriesLeft: 3, backoffMs: 1000 });
  }

  private scheduleP2(fn: () => Promise<void>): void {
    if (!this.feedBucket.tryTake()) {
      this.p2DroppedCount += 1;
      this.log("WARN", "P2 feed edit dropped - feed bucket empty");
      return;
    }
    fn().catch((err) => {
      if (err instanceof RateLimitedError) {
        this.feedBucket.pauseFor(err.retryAfterSec * 1000);
      }
      // Never retried, success or failure (§5.4): a newer frame supersedes a dropped one anyway.
    });
  }

  private enqueueControl(task: ControlTask): void {
    (task.lane === "P0" ? this.p0Queue : this.p1Queue).push(task);
    // Deferred to a microtask rather than drained synchronously: a hook batch that schedules a
    // P1 lifecycle notice and a P0 permission prompt in the same tick must still let P0 win the
    // one available token (§9 scenario 16) - draining inline here would hand it to whichever of
    // the two happened to call `schedule()` first instead.
    queueMicrotask(() => this.drainControl());
  }

  /** Drains whatever P0/P1 work the control bucket can currently afford, P0 first. Call again
   * after advancing time (production: a real interval; tests: manually) to pick up anything a
   * 429 pause or an empty bucket deferred. */
  pump(): void {
    this.drainControl();
  }

  private drainControl(): void {
    for (;;) {
      const task = this.p0Queue[0] ?? this.p1Queue[0];
      if (!task) return;
      if (!this.controlBucket.tryTake()) return;
      if (this.p0Queue[0] === task) this.p0Queue.shift();
      else this.p1Queue.shift();
      void this.runControlTask(task);
    }
  }

  private async runControlTask(task: ControlTask): Promise<void> {
    try {
      await task.run();
    } catch (err) {
      if (err instanceof RateLimitedError) {
        this.controlBucket.pauseFor(err.retryAfterSec * 1000);
        // Re-queued ahead of newer work, retry budget untouched - a 429 is the bucket's fault,
        // not this task's, so it shouldn't spend one of the task's 3 retries.
        (task.lane === "P0" ? this.p0Queue : this.p1Queue).unshift(task);
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
    }
  }

  get droppedP2Count(): number {
    return this.p2DroppedCount;
  }
}
