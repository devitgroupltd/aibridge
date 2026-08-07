import { monotonicNowMs } from "./monotonic-clock.ts";

export interface ChannelConnectCoordinatorOptions {
  /** How long an early "connected" signal is remembered before it's considered stale and ignored -
   * long enough to cover the real race window (the channel's handshake completing before the caller
   * even starts waiting for it), short enough that some later, unrelated reconnect for the same slug
   * (a `resumeSession` relaunch - nothing outside `/new` ever calls `waitFor` at all) doesn't get
   * misread as still belonging to an abandoned wait. Lazily checked at read time, no timer of its
   * own - same TTL convention as confirm-registry.ts. */
  earlyConnectTtlMs?: number;
  /** Clock injection for tests - never `Date.now()`/`monotonicNowMs()` directly in the class body. */
  now?: () => number;
}

const DEFAULT_EARLY_CONNECT_TTL_MS = 20_000;

/**
 * Coordinates the two-sided race between a channel server's MCP handshake completing
 * (`onConnected`) and a caller starting to wait for it (`waitFor`) - confirmed live 2026-08-07
 * ("check-what-is-left-to"): a channel that connects in well under a second can complete its
 * handshake before `index.ts`'s `/new` handler even reaches its `waitForChannelConnected` call,
 * silently losing the resolve. The old plain `Map<string, () => void>` had no way to represent "this
 * already happened" - only "someone is waiting" - so the wait then burned its full 15s timeout for a
 * signal that had already arrived, before the very first write hit a *separately* dead PTY
 * write-socket (a real, still-open node-pty/ConPTY bug this class doesn't fix). Losing 15 real
 * seconds to an avoidable lost signal was worth closing on its own regardless.
 */
export class ChannelConnectCoordinator {
  private readonly waiters = new Map<string, () => void>();
  private readonly earlyConnects = new Map<string, number>();
  private readonly earlyConnectTtlMs: number;
  private readonly now: () => number;

  constructor(opts: ChannelConnectCoordinatorOptions = {}) {
    this.earlyConnectTtlMs = opts.earlyConnectTtlMs ?? DEFAULT_EARLY_CONNECT_TTL_MS;
    this.now = opts.now ?? monotonicNowMs;
  }

  /** Call every time a channel's handshake completes - including reconnects nothing is waiting for
   * (a `resumeSession` relaunch), which just get recorded and later lazily expire unconsumed. */
  onConnected(slug: string): void {
    const waiter = this.waiters.get(slug);
    if (waiter) {
      this.waiters.delete(slug);
      waiter();
      return;
    }
    this.earlyConnects.set(slug, this.now());
  }

  /** Resolves `true` once `onConnected(slug)` has fired - whether that already happened (within
   * `earlyConnectTtlMs`) or happens later - or `false` after `timeoutMs` if it never does. At most
   * one waiter per slug, same "a slug can have at most one pending waiter at a time" constraint the
   * old map-based version documented - nothing writes a session's first message before it's even
   * launched, so this is never called twice concurrently for the same slug. */
  waitFor(slug: string, timeoutMs = 15_000): Promise<boolean> {
    const connectedAt = this.earlyConnects.get(slug);
    if (connectedAt !== undefined) {
      this.earlyConnects.delete(slug);
      if (this.now() - connectedAt <= this.earlyConnectTtlMs) return Promise.resolve(true);
      // Stale - this earlier "connected" belongs to some prior, already-abandoned wait for the same
      // slug. Fall through and wait for a fresh signal instead of trusting old news.
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(slug);
        resolve(false);
      }, timeoutMs);
      this.waiters.set(slug, () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }
}
