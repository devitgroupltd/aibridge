import { escapeForFeed } from "./feed-escape.ts";
import { renderWithBoundedTail } from "./fleet-commands.ts";
import type { SessionState } from "./session-store.ts";

/**
 * The generalized form of a failure that has now bitten three times in two days, each time from a
 * different dialog: **a fleet session has no human at its terminal, so any modal Claude Code opens
 * swallows the next message written into that topic, silently.**
 *
 * The three instances, all live:
 *   1. A target repo's own `.mcp.json` raising "8 new MCP servers found in this project" during
 *      `/new` - the first prompt was typed into it and its trailing `\r` picked the highlighted
 *      option (fixed at source by `project-mcp-policy.ts`, made loud by `startup-gate-notice.ts`).
 *   2. Whatever else was still on screen when `startFirstTurn`'s gates gave up and wrote anyway.
 *   3. `/auto-mode-setup`, Claude Code's environment-onboarding dialog, which opens *after* the
 *      first turn completes - so neither of the two fixes above can see it. That one ate the second
 *      instruction of a §13 check 5 run and cost a full re-run to diagnose.
 *
 * Patching dialogs one at a time is the wrong shape: the list is not aibridge's to control and grew
 * by one the same day two entries were closed. What every instance has in common is observable and
 * dialog-independent - **the message reached the PTY and no turn ever started.**
 *
 * ## Why the existing detector cannot cover this
 *
 * `pty-io.ts`'s `confirmSubmitted` asks "did the PTY produce any output after the Enter". A modal
 * being answered and redrawn is plenty of output, so every one of the three cases reads to it as a
 * successful submit. It is measuring the wrong thing for this failure - not measuring it badly.
 *
 * The unambiguous signal is Claude Code's own `UserPromptSubmit` hook: it fires when the text is
 * accepted *as a prompt*, which is exactly the thing that did not happen. `pty-quiet-wait.ts`'s doc
 * comment already recorded the symptom in those terms ("no hook ever fires - `UserPromptSubmit`
 * never arrives, the session's `state` never leaves `idle`"); this turns that observation into the
 * check.
 *
 * ## Why it does not retry
 *
 * Deliberately reporting-only. `confirmSubmitted` retries the Enter, and a blind retry is how case
 * (1) answered a security dialog by accident in the first place - a second `\r` into an open modal
 * picks whatever is highlighted. When a turn has not started, the useful action is to *show the
 * operator the terminal*, since the tail is the diagnosis: it holds the dialog verbatim.
 */

/** Long enough that `confirmSubmitted`'s own ladder (a 2.5s window, one retried Enter, a second 2.5s
 * window) has fully played out and rescued whatever it can, so this only speaks about messages that
 * survived every cheaper mechanism. Short enough to still be useful on a phone. */
export const DEFAULT_TURN_START_TIMEOUT_MS = 20_000;

export interface TurnStartWatchdogOptions {
  /** The session's current §4.3 state, read at both arm and fire time - see `arm`/the timer body for
   * what each reading rules out. `undefined` for a slug with no row (already `/rm`'d). */
  getState: (slug: string) => SessionState | undefined;
  /** Called only when a message really did fail to become a turn. */
  onNoTurnStarted: (slug: string, topicId: number) => void;
  timeoutMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface TurnStartWatchdog {
  /**
   * Arm for the message just written to `slug`'s PTY. **Only arms when the session is `idle`**, and
   * that guard is load-bearing rather than defensive: Claude Code queues a message sent mid-turn and
   * fires `UserPromptSubmit` for it only when the current turn ends, which can be minutes later.
   * Arming there would report a wedge on every perfectly healthy follow-up message - the "check that
   * cannot fail for the right reason" trap in its other direction, crying wolf instead of staying
   * silent.
   */
  arm(slug: string, topicId: number): void;
  /** A `UserPromptSubmit` arrived for this slug - the message became a turn, so disarm. */
  turnStarted(slug: string): void;
  /** Drop any pending watch without firing (`/kill`, `/rm`, a session exit). */
  forget(slug: string): void;
  /** Test seam: how many slugs are currently being watched. */
  pendingCount(): number;
}

export function createTurnStartWatchdog(opts: TurnStartWatchdogOptions): TurnStartWatchdog {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_START_TIMEOUT_MS;
  const setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn = opts.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  // At most one watch per slug. A second message arriving while one is pending replaces it rather
  // than stacking: the operator would get one notice per message otherwise, all describing the same
  // stuck terminal, and the newest write is the one whose window should be running.
  const pending = new Map<string, unknown>();

  function clear(slug: string): void {
    const handle = pending.get(slug);
    if (handle === undefined) return;
    clearTimeoutFn(handle);
    pending.delete(slug);
  }

  return {
    arm(slug, topicId) {
      if (opts.getState(slug) !== "idle") return;
      clear(slug);
      pending.set(
        slug,
        setTimeoutFn(() => {
          pending.delete(slug);
          // Re-read rather than trusting the timer having fired. Three things this rules out, and
          // each of them is a case where speaking up would be wrong:
          //   - `working`: a turn did start (a missed/late `turnStarted` call, or the hook client
          //     losing a race). The session is fine.
          //   - `awaiting_input`: the turn started and is parked on a permission or question card,
          //     which is the relay working exactly as designed.
          //   - `undefined`/`dead`: the session was removed or died inside the window; a notice
          //     about a message to a session that no longer exists is noise.
          // Only a session that is *still idle* with no `UserPromptSubmit` has genuinely eaten the
          // message.
          if (opts.getState(slug) !== "idle") return;
          opts.onNoTurnStarted(slug, topicId);
        }, timeoutMs),
      );
    },
    turnStarted(slug) {
      clear(slug);
    },
    forget(slug) {
      clear(slug);
    },
    pendingCount() {
      return pending.size;
    },
  };
}

/**
 * The operator-facing notice, HTML (callers must pass `parseMode: "HTML"`).
 *
 * Carries the PTY tail because in every instance so far the tail *is* the diagnosis - it holds the
 * dialog verbatim, so the operator reads "New MCP server found in this project" rather than being
 * told only that something went wrong. Rendered through `renderWithBoundedTail` rather than a local
 * `<pre>`, so it inherits P1-10's length bound: a notice about a silent session that is itself too
 * long for Telegram to accept produces exactly the silence it exists to break.
 *
 * `/stop` is named as the recovery because it writes a bare ESC to the PTY
 * (`session-lifecycle-commands.ts`), and every dialog seen so far offers ESC as its own way out
 * ("Esc to cancel", "Esc to reject all"). That is a real escape hatch reachable from the phone, not
 * a suggestion to go and find the machine.
 */
export function renderNoTurnStartedNotice(slug: string, tail: string, timeoutMs: number): string {
  const header =
    `⚠️ Your message reached "${escapeForFeed(slug)}" but never started a turn - nothing was submitted in ${Math.round(timeoutMs / 1000)}s.\n\n` +
    "Its terminal is most likely sitting on a dialog waiting to be answered. This is what it is showing:\n\n";
  const footer = `</pre>\n<code>/stop ${escapeForFeed(slug)}</code> sends ESC, which is how these dialogs are dismissed. Nothing was lost - resend once it is clear.`;
  return renderWithBoundedTail(header, tail.trim().length > 0 ? tail : "(no output captured yet)", footer);
}
