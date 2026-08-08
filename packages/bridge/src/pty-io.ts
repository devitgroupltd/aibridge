import { renderChannelTag, type ChannelMetaFields } from "@aibridge/protocol";
import { recoverWedgedPty, type PtyLookup } from "./wedged-recovery.ts";
import type { Routing } from "./routing.ts";
import type { ThinkingPlaceholder } from "./thinking-placeholder.ts";
import type { TypingIndicator } from "./typing-indicator.ts";

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

/** `sendChannelText`'s lost-Enter detector (found 2026-08-04) - real activity (spinner frames etc.)
 * redraws well within a couple of seconds, confirmed live, so this is generous rather than tight. */
export const DEFAULT_SUBMIT_CONFIRM_WINDOW_MS = 2500;
/** How long the write's own echo takes to land, confirmed live to be well under 500ms - the
 * baseline for the lost-Enter check is taken after this, not at the moment of the write itself. */
export const DEFAULT_ECHO_SETTLE_MS = 500;

export interface PtyIoOptions {
  routing: Routing;
  typingIndicator: TypingIndicator;
  thinkingPlaceholder: ThinkingPlaceholder;
  /** `session-supervisor.ts`'s liveness accessors - `confirmSubmitted`'s lost-Enter check reads
   * `lastActivityAt`, and `autoRecoverWedgedSession` needs a PTY lookup for `recoverWedgedPty`
   * (deliberately not a kill-and-untrack: see that function's own doc comment). */
  lastActivityAt: (slug: string) => number | undefined;
  ptyLookup: PtyLookup;
  log?: LogFn;
  submitConfirmWindowMs?: number;
  echoSettleMs?: number;
  /** Injectable in place of the real `setTimeout`, so `confirmSubmitted`'s two nested windows are
   * fakeable in tests without real waits. Defaults to the real `setTimeout`. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

export interface PtyIo {
  sendRaw(slug: string, text: string): void;
  sendEffortCommand(slug: string, effort: string): void;
  confirmSubmitted(slug: string, topicId: number, write: (text: string) => void, attempt?: number): void;
  autoRecoverWedgedSession(slug: string): void;
  sendChannelText(slug: string, topicId: number, content: string, msgId: string, from: string): void;
}

/**
 * PTY write primitives and the lost-Enter detector/auto-recovery pair (found live 2026-08-04/
 * 2026-08-07 - see `confirmSubmitted`'s and `autoRecoverWedgedSession`'s own doc comments). Owns
 * the per-message `seq` counter `sendChannelText` needs for `ChannelMetaFields`.
 */
export function createPtyIo(opts: PtyIoOptions): PtyIo {
  const { routing, typingIndicator, thinkingPlaceholder, lastActivityAt, ptyLookup } = opts;
  const log = opts.log ?? (() => {});
  const submitConfirmWindowMs = opts.submitConfirmWindowMs ?? DEFAULT_SUBMIT_CONFIRM_WINDOW_MS;
  const echoSettleMs = opts.echoSettleMs ?? DEFAULT_ECHO_SETTLE_MS;
  const setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

  let seq = 0;

  // Raw keystroke passthrough: /model, /mode, /compact and /clear are all CLI-native, with no
  // backing markdown file for the /cmd shim (§4.2) to reach - they're written straight to the PTY,
  // bypassing the <channel> tag entirely, exactly as an operator typing them at the desk would.
  // Same two-write submit pattern as the tag path (see sendChannelText): confirmed live that a
  // single write carrying text plus a trailing \r leaves it sitting unsubmitted.
  function sendRaw(slug: string, text: string): void {
    const write = routing.getPtyWrite(slug);
    if (!write) {
      log("WARN", `no live session for slug "${slug}" - command dropped`);
      return;
    }
    write(text);
    write("\r");
  }

  // /effort, unlike /model, opens a "Change effort level? 1. Yes, switch  2. No, go back"
  // confirmation dialog with "Yes" pre-selected - live-verified 2026-08-03. A second Enter selects
  // it, but sending both \r's in the same tick arrives before the dialog has rendered and is
  // dropped, leaving the dialog open and the level unchanged (also confirmed live) - same class of
  // PTY-timing hazard as the known single-write text+\r issue, one layer removed. A short delay
  // before the confirming \r fixes it.
  function sendEffortCommand(slug: string, effort: string): void {
    const write = routing.getPtyWrite(slug);
    if (!write) {
      log("WARN", `no live session for slug "${slug}" - command dropped`);
      return;
    }
    write(`/effort ${effort}`);
    write("\r");
    setTimeoutFn(() => write("\r"), 200);
  }

  /**
   * Retries the trailing `\r` once if the PTY produces no output at all within the window - found
   * live 2026-08-04 (see the 0.27.0 changelog entry): the content+`\r` writes can land with the
   * Enter never actually submitting, silently wedging the session with no further output ever and
   * no error anywhere. `session.ready`/`waitForChannelConnected` close the *startup* race but not
   * this one. A genuinely working turn produces PTY output (spinner frames etc.) well within this
   * window - confirmed live, real activity redraws every few hundred ms - so "nothing at all" for
   * the full window is a reliable "the Enter didn't land" signal, not a false positive on a slow
   * turn. Resends only the `\r`, never the content, so a `\r` that *did* land doesn't get the
   * prompt injected twice. If the retry also produces nothing, gives up loudly instead of leaving
   * the "Thinking..." placeholder lying forever with no explanation.
   */
  function confirmSubmitted(slug: string, topicId: number, write: (text: string) => void, attempt = 1): void {
    // The write's own echo (the typed text reappearing) is itself real, non-empty PTY output - so
    // the baseline has to be taken *after* that echo has landed, not at the moment of the write,
    // or the echo alone always looks like "it worked" regardless of whether Claude ever submitted
    // it. `echoSettleMs` is comfortably longer than the echo has ever taken to land live.
    setTimeoutFn(() => {
      const baseline = lastActivityAt(slug) ?? 0;
      setTimeoutFn(() => {
        const lastActivity = lastActivityAt(slug) ?? 0;
        if (lastActivity > baseline) return; // real activity happened after the echo settled
        if (attempt >= 2) {
          log("ERROR", `session "${slug}" produced no output after ${attempt} attempts to submit an inbound message - likely wedged`);
          autoRecoverWedgedSession(slug);
          return;
        }
        log("WARN", `session "${slug}" produced no output ${submitConfirmWindowMs}ms after an inbound message - retrying the Enter`);
        write("\r");
        confirmSubmitted(slug, topicId, write, attempt + 1);
      }, submitConfirmWindowMs);
    }, echoSettleMs);
  }

  /**
   * Self-heals the wedged-PTY failure mode `confirmSubmitted` detects, found live 2026-08-07
   * ("check-what-is-left-to"): `pty-write-guard.ts` already stops a dead node-pty write-socket from
   * crashing the daemon, but left alone that left the session a permanent zombie - its `claude`
   * process can stay alive and burning CPU while the Bridge's own link into it is dead, with no
   * output ever again and no recovery short of the operator noticing a silent topic and typing
   * `/kill` + `/new` by hand - which also throws the conversation away (a fresh slug/topic/worktree,
   * not a continuation).
   *
   * Deliberately does *not* reuse `/kill`'s `killSessionRow` (that marks the row "dead" and closes
   * the topic - a dead end, not a recovery) or duplicate any resume logic of its own. Instead it
   * terminates just the wedged PTY via `recoverWedgedPty` (wedged-recovery.ts) *without* first
   * untracking it - the one thing `/kill`/`/rm` deliberately do first (see
   * `session-supervisor.ts`'s `handleUnexpectedExit` doc comment) specifically to mark a kill as
   * "deliberate, don't resume". Leaving the tracked entry in place makes this indistinguishable
   * from a real crash to `handleUnexpectedExit`, which already does exactly "restore/fix and
   * continue" right: same slug, same topic, same worktree, `claude --resume <session_id>` on a
   * fresh PTY, with its own backoff/give-up safety net already in place for the rarer case where
   * the underlying process is now so broken even a resume immediately re-exits.
   */
  function autoRecoverWedgedSession(slug: string): void {
    const recovered = recoverWedgedPty(ptyLookup, slug);
    if (!recovered) return; // already gone - a manual /kill/rm, or a real crash, raced this same detection
    log(
      "WARN",
      `session "${slug}"'s PTY write-socket is dead but its process is still alive - killing it so the existing crash-resume path (§12 Phase 5) can relaunch it via claude --resume instead of leaving a zombie`,
    );
    // handleUnexpectedExit (wired in wireSession's onExit) takes over from here - it posts its own
    // "attempting to resume" notice, so no separate confirmSessionCommand here would just double up.
  }

  // A normal inbound turn: wrapped in the <channel> tag Claude Code would have rendered itself,
  // for text Claude should read and act on rather than a literal TUI keystroke.
  function sendChannelText(slug: string, topicId: number, content: string, msgId: string, from: string): void {
    const write = routing.getPtyWrite(slug);
    if (!write) {
      log("WARN", `no live session for slug "${slug}" - inbound message dropped`);
      return;
    }
    seq += 1;
    const meta: ChannelMetaFields = { topic_id: String(topicId), msg_id: msgId, from, seq };
    write(renderChannelTag(content, meta));
    write("\r");
    typingIndicator.start(meta.topic_id);
    thinkingPlaceholder.start(meta.topic_id);
    confirmSubmitted(slug, topicId, write);
  }

  return {
    sendRaw,
    sendEffortCommand,
    confirmSubmitted,
    autoRecoverWedgedSession,
    sendChannelText,
  };
}
