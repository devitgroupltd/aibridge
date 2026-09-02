/**
 * Exponential backoff with a floor, a ceiling, and a reset - the shape both of telegram.ts's retry
 * loops need: `startPolling`'s `getUpdates` loop, and `awaitTokenValidation`'s boot-time wait for an
 * unreachable Telegram.
 *
 * Extracted because those two are meant to behave identically and said so only in a doc comment
 * ("mirrors `startPolling`"). A comment is not a mechanism. The poll loop's own backoff was a *flat*
 * delay for months - a sustained Telegram outage polled forever at a fixed ~1/s - and was only fixed
 * after being found live on 2026-08-09; nothing would have carried that fix into a second copy
 * written afterwards, and the second copy is now the one that runs at boot before anything can
 * report a problem.
 *
 * Deliberately NOT shared with `packages/channel-server`'s pipe-client or `packages/hook-client`'s
 * ask-once, which also back off. Those are separate processes with their own reconnect semantics
 * (the hook client uses `base * 2 ** attempt` against an attempt counter, not a running double), and
 * hoisting this into `@aibridge/protocol` to unify all four would put it inside the hook client's
 * compiled single-file binary, where startup latency is load-bearing (§2.2). Two call sites in one
 * file is the duplication worth collapsing; four across three packages is a different decision that
 * nobody has needed to make.
 */
export interface Backoff {
  /** How long to wait before the next attempt. Reading it never advances anything - `advance()` is
   * the only thing that moves it, so a caller can pass the same value to a log line and to its
   * sleep without them disagreeing. */
  readonly delayMs: number;
  /** An attempt failed: double the delay, up to the ceiling. */
  advance(): void;
  /** An attempt succeeded: back to the floor, so a later blip starts short again instead of
   * inheriting the last outage's ceiling. */
  reset(): void;
}

/**
 * Defaults match what both call sites already used (1s doubling to 30s). No clamping of either
 * bound: this is a faithful extraction, and silently repairing a caller's arguments here would be a
 * behaviour change smuggled in under a refactor.
 */
export function createBackoff(baseMs = 1000, maxMs = 30_000): Backoff {
  let current = baseMs;
  return {
    get delayMs() {
      return current;
    },
    advance() {
      current = Math.min(current * 2, maxMs);
    },
    reset() {
      current = baseMs;
    },
  };
}
