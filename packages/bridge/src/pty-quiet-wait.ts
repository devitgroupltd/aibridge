/**
 * Closes the third leg of `/new`'s first-write race - `session-lifecycle-commands.ts`'s doc comment
 * on `handleNewCommand` already names two ("`session.ready` - otherwise the write lands on the
 * still-open dev-channels dialog", "`waitForChannelConnected` - otherwise the trailing Enter can be
 * silently lost even with the dialog long since confirmed"). Both close *before* the first
 * `sendChannelText` write for a brand-new session. Live-confirmed 2026-08-11
 * ("why are new sessions always stuck on Thinking"): even after both of those resolve, Claude Code's
 * own startup can still be busy registering its *other* MCP servers - `claude-config.ts`'s Playwright
 * entry in particular, which cold-spawns `npx -y @playwright/mcp@latest` on every brand-new worktree
 * path (never cached, unlike a resumed session's second-and-later turns). That startup chatter
 * produces real PTY output that lands inside `pty-io.ts`'s `confirmSubmitted` detection window,
 * which only checks "did *any* output happen" - so it reads as "the Enter landed" when it didn't.
 * Net effect: the prompt sits typed but unsubmitted forever, no hook ever fires (confirmed live:
 * `UserPromptSubmit` never arrives, the session's `state` never leaves `idle`), and the "🤔
 * Thinking..." placeholder - sent optimistically the instant the write happens, not once Claude Code
 * actually accepts it - is never cleared.
 *
 * The fix is a fourth gate, not a smarter `confirmSubmitted`: wait for the PTY to actually go quiet
 * (no output for `quietMs`) before writing the first message at all, so by the time it's written,
 * any further output really is a reaction to *this* message rather than leftover startup noise.
 * Bounded by `timeoutMs` so a chronically noisy PTY (or a genuinely slow `npx` cold-start) can't wedge
 * `/new` forever - `false` means "gave up, proceed anyway", the same "don't wedge over a signal that
 * might never arrive" contract `waitForChannelConnected` already has.
 */
export interface WaitForPtyQuietOptions {
  /** Same accessor as `pty-io.ts`'s `lastActivityAt` - the last time this slug's PTY produced any
   * (non-ANSI-stripped-empty) output, or `undefined` if it never has. */
  lastActivityAt: (slug: string) => number | undefined;
  /** How long the PTY must have produced no output before it's considered quiet. */
  quietMs?: number;
  /**
   * Only treat the PTY as quiet once it has produced output *newer* than this timestamp - i.e. wait
   * for something to start before waiting for it to stop.
   *
   * Needed by `pty-io.ts`'s `sendChannelText` (P2-7), which waits for the echo of the body it has
   * just written. Without this the wait is measured against activity from *before* that write, and
   * a PTY that was already idle is trivially "quiet" the microsecond after a write is issued - the
   * echo has not reached it yet. Live 2026-08-13 that made the wait a no-op and left the fix it
   * exists for doing nothing at all, while looking exactly like a working fix.
   *
   * Callers pass the `lastActivityAt` they read immediately *before* their write. Omitted (the
   * default) keeps the original "quiet, whenever that started" behaviour, which is what
   * `handleNewCommand`'s startup gate wants - there is no write of its own to wait for there.
   */
  afterActivityAt?: number;
  /** Overall ceiling on how long to wait for quiet at all. */
  timeoutMs?: number;
  /** How often to re-check while waiting for quiet. */
  pollMs?: number;
  /** Clock injection for tests - never `Date.now()` directly in the function body. */
  now?: () => number;
  /** Injectable in place of the real `setTimeout`, same convention as `pty-io.ts`'s
   * `confirmSubmitted` - lets the polling loop be driven by a fake scheduler in tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

export const DEFAULT_QUIET_MS = 800;
export const DEFAULT_QUIET_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_MS = 150;

/**
 * Resolves `true` once `slug`'s PTY has produced no output for `quietMs`, or `false` after
 * `timeoutMs` total if it never goes quiet that long. Resolves immediately (no polling delay at all)
 * when the PTY is already quiet the moment this is called - the common case for every write *after*
 * the first, and for a first write that happens to land after startup chatter has already settled.
 */
export function waitForPtyQuiet(slug: string, opts: WaitForPtyQuietOptions): Promise<boolean> {
  const { lastActivityAt } = opts;
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUIET_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? Date.now;
  const setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const deadline = now() + timeoutMs;

  return new Promise((resolve) => {
    function poll(): void {
      const last = lastActivityAt(slug);
      // `Infinity` for a PTY that has never produced anything is the "already quiet" fast path - but
      // only when the caller isn't waiting for its own write to show up first, or a never-echoing
      // write would resolve instantly and defeat the wait entirely.
      const started = opts.afterActivityAt === undefined || (last !== undefined && last > opts.afterActivityAt);
      const quietFor = last === undefined ? Infinity : now() - last;
      if (started && quietFor >= quietMs) {
        resolve(true);
        return;
      }
      if (now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeoutFn(poll, pollMs);
    }
    poll();
  });
}
