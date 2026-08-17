import { renderChannelTag, type ChannelMetaFields } from "@aibridge/protocol";
import { waitForPtyQuiet } from "./pty-quiet-wait.ts";
import { recoverWedgedPty, type PtyLookup, type WedgedRecoveryMarks } from "./wedged-recovery.ts";
import type { Routing } from "./routing.ts";
import type { ThinkingPlaceholder } from "./thinking-placeholder.ts";
import type { TypingIndicator } from "./typing-indicator.ts";
import type { LogFn } from "./logger.ts";

/** `sendChannelText`'s lost-Enter detector (found 2026-08-04) - real activity (spinner frames etc.)
 * redraws well within a couple of seconds, confirmed live, so this is generous rather than tight. */
export const DEFAULT_SUBMIT_CONFIRM_WINDOW_MS = 2500;
/** How long the PTY must be silent for the write's own echo to count as finished. Used as the
 * `quietMs` of a `waitForPtyQuiet` rather than as a fixed delay - see `sendChannelText` (P2-7). */
export const DEFAULT_ECHO_SETTLE_MS = 500;
/**
 * Ceiling on waiting for that echo to finish, in both `sendChannelText` and `confirmSubmitted`.
 *
 * Deliberately short. The one case where the PTY never goes quiet is a message sent *into a running
 * turn* (an interjection): its output never stops, so the wait can only ever time out, and every
 * millisecond of this ceiling is added latency on a path that works fine today. Five seconds is
 * comfortably longer than the longest echo measured live (a ~3.7KB message) and short enough that an
 * interjection is not left visibly hanging. Timing out is safe rather than fatal: the `\r` is written
 * anyway, and `confirmSubmitted` is still behind it as the backstop.
 */
export const DEFAULT_SUBMIT_QUIET_TIMEOUT_MS = 5_000;
/**
 * How much of a message body goes into one `write()`, and how long to pause between them (P2-7).
 *
 * A single large write loses its middle. Measured live 2026-08-13 with a 3.7KB position-marked
 * message: the session received the first ~200 characters and the last ~350, and reported the gap
 * itself ("after C03 it jumps straight to C71"). Head and tail surviving while the middle vanishes is
 * the signature of a bounded input buffer overrunning - ConPTY's console input is exactly that, and
 * the TUI re-rendering a large paste is more than slow enough to let it overrun. Nothing upstream
 * reports the loss: `write()` succeeds, the echo looks plausible, and the operator's message is
 * simply missing a chunk by the time Claude reads it.
 *
 * Bracketed paste would be the cleaner fix and is not available - Claude Code's TUI never emits
 * `?2004h`, so it is detecting pastes heuristically and would take `\\e[200~` as literal input.
 * Pacing is what is left: small enough writes that the reader keeps up, spaced enough to drain.
 *
 * **Paced on feedback, not on a timer.** A fixed 40ms gap between 400-character chunks was measured
 * first and is not enough: it recovered 54 of 77 markers instead of 10, but still lost ~1.1KB from
 * the middle, because the TUI's per-chunk cost *grows* as the composer fills, so any constant chosen
 * for the start of a message is too small by the end of it. Waiting for each chunk's own echo before
 * sending the next adapts to whatever the reader is actually doing, which no constant can.
 * `chunkQuietMs` is deliberately far below `echoSettleMs`: this is "that chunk landed", not "the
 * whole body has settled", and paying 500ms per chunk would put a 4KB message into double-digit
 * seconds.
 */
export const DEFAULT_WRITE_CHUNK_CHARS = 400;
/** How long a chunk's echo must be silent before the next chunk goes out. */
export const DEFAULT_CHUNK_QUIET_MS = 60;
/**
 * Per-chunk ceiling on that wait, so a PTY that never echoes cannot stall a message indefinitely -
 * the body still goes out in full, just without the pacing that was meant to protect it.
 *
 * This ceiling is reached more often than "never echoes" suggests, because `lastActivityAt` only
 * counts output that survives `stripAnsi`, and a TUI repainting a paste can emit whole chunks of
 * pure escape sequences. Measured live: a 3.8KB message into a *fresh* session submitted 2.2s after
 * the write (echo detected, pacing adaptive), while a 3.6KB message into a session with history took
 * 19.4s - almost exactly 9 chunks x this ceiling, i.e. every chunk timing out. Both arrived with
 * every marker intact.
 *
 * Left at 2s deliberately. The cost is paid only by unusually large messages (a few hundred
 * characters is one chunk and waits not at all), and the one intermediate value that *has* been
 * measured - a flat 40ms - still lost ~1.1KB of a 3.8KB message. Anything lower than this should be
 * re-measured with `scripts/telegram-automation/long-prompt-check.js` on the in-topic path, not
 * reasoned about: trading proven correctness for unproven speed is how this bug got its history.
 */
export const DEFAULT_CHUNK_QUIET_TIMEOUT_MS = 2_000;

/**
 * Splits `text` into pieces of at most `chunkChars` **code points**, in order, losing nothing.
 *
 * Code points, not UTF-16 units, so a boundary can never fall inside a surrogate pair. A torn pair
 * would not throw - it would deliver a replacement character in the middle of the operator's own
 * message and look like a typo, which is §9's silent-wrong bar exactly. Emoji in a Telegram message
 * are not an edge case here, they are the norm.
 */
export function chunkForPty(text: string, chunkChars: number): string[] {
  if (chunkChars <= 0 || text.length <= chunkChars) return text.length === 0 ? [] : [text];
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < codePoints.length; i += chunkChars) {
    chunks.push(codePoints.slice(i, i + chunkChars).join(""));
  }
  return chunks;
}

export interface PtyIoOptions {
  routing: Routing;
  typingIndicator: TypingIndicator;
  thinkingPlaceholder: ThinkingPlaceholder;
  /** `session-supervisor.ts`'s liveness accessors - `confirmSubmitted`'s lost-Enter check reads
   * `lastActivityAt`, and `autoRecoverWedgedSession` needs a PTY lookup for `recoverWedgedPty`
   * (deliberately not a kill-and-untrack: see that function's own doc comment). */
  lastActivityAt: (slug: string) => number | undefined;
  ptyLookup: PtyLookup;
  /** P0-8: shared with `feed-wiring.ts`, which is the module that actually consults it - this one
   * only ever writes. See `WedgedRecoveryMarks`'s own doc comment for the race it closes. */
  wedgedRecoveryMarks: WedgedRecoveryMarks;
  log?: LogFn;
  submitConfirmWindowMs?: number;
  echoSettleMs?: number;
  submitQuietTimeoutMs?: number;
  writeChunkChars?: number;
  chunkQuietMs?: number;
  chunkQuietTimeoutMs?: number;
  /** Injectable in place of the real `setTimeout`, so `confirmSubmitted`'s window is fakeable in
   * tests without real waits. Defaults to the real `setTimeout`. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** `pty-quiet-wait.ts`'s `waitForPtyQuiet`, pre-bound to this module's own `lastActivityAt` and
   * scheduler. Injectable as a whole rather than through `setTimeoutFn` alone because that helper
   * reads a clock as well as scheduling, and a fake scheduler paired with a real `Date.now` polls
   * against a deadline that never arrives. */
  waitForPtyQuietFn?: (slug: string, quietMs: number, timeoutMs: number, afterActivityAt?: number) => Promise<boolean>;
  /** `turn-start-watchdog.ts` - armed after each inbound message's Enter, and the only detector that
   * can see a message eaten by a dialog (`confirmSubmitted` cannot: a modal being answered and
   * redrawn is exactly the PTY output it reads as success). Optional so the many `createPtyIo` call
   * sites in tests that are about something else stay unchanged; omitted means no watchdog. */
  turnStartWatchdog?: { arm(slug: string, topicId: number): void };
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
  const { routing, typingIndicator, thinkingPlaceholder, lastActivityAt, ptyLookup, wedgedRecoveryMarks } = opts;
  const log = opts.log ?? (() => {});
  const submitConfirmWindowMs = opts.submitConfirmWindowMs ?? DEFAULT_SUBMIT_CONFIRM_WINDOW_MS;
  const echoSettleMs = opts.echoSettleMs ?? DEFAULT_ECHO_SETTLE_MS;
  const submitQuietTimeoutMs = opts.submitQuietTimeoutMs ?? DEFAULT_SUBMIT_QUIET_TIMEOUT_MS;
  const writeChunkChars = opts.writeChunkChars ?? DEFAULT_WRITE_CHUNK_CHARS;
  const chunkQuietMs = opts.chunkQuietMs ?? DEFAULT_CHUNK_QUIET_MS;
  const chunkQuietTimeoutMs = opts.chunkQuietTimeoutMs ?? DEFAULT_CHUNK_QUIET_TIMEOUT_MS;
  const setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const waitForQuiet =
    opts.waitForPtyQuietFn ??
    ((slug: string, quietMs: number, timeoutMs: number, afterActivityAt?: number) => waitForPtyQuiet(slug, { lastActivityAt, quietMs, timeoutMs, afterActivityAt, setTimeoutFn }));

  let seq = 0;

  /**
   * Per-slug FIFO for the deferred half of `sendChannelText`. Its body write and its `\r` are no
   * longer in the same tick, so two messages arriving close together could otherwise interleave as
   * body-1, body-2, `\r`, `\r` - submitting both as one prompt and then pressing Enter on an empty
   * composer. Serializing per slug keeps each message's own Enter attached to it.
   *
   * The chain is only ever as long as the queue: each link drops its predecessor once it settles,
   * and the map entry itself is deleted when the tail completes with nothing behind it.
   */
  const submitChainBySlug = new Map<string, Promise<void>>();

  function enqueueWrite(slug: string, task: () => Promise<void>): void {
    const previous = submitChainBySlug.get(slug) ?? Promise.resolve();
    // `.catch` on every link, not just the tail: one message's failure must not strand every later
    // message behind a permanently rejected chain.
    const next = previous.then(task).catch((err: unknown) => {
      log("WARN", `deferred write for session "${slug}" failed: ${(err as Error).message}`);
    });
    submitChainBySlug.set(slug, next);
    void next.then(() => {
      if (submitChainBySlug.get(slug) === next) submitChainBySlug.delete(slug);
    });
  }

  // Raw keystroke passthrough: /model, /mode, /compact and /clear are all CLI-native, with no
  // backing markdown file for the /cmd shim (§4.2) to reach - they're written straight to the PTY,
  // bypassing the <channel> tag entirely, exactly as an operator typing them at the desk would.
  // Two writes, not one: confirmed live that a single write carrying text plus a trailing \r leaves
  // it sitting unsubmitted.
  //
  // Deliberately *not* given `sendChannelText`'s pacing (P2-7). These are short, single-line
  // commands: too small to overrun the input buffer, and with no newline to trigger the TUI's
  // paste collapse, which is what swallows a same-tick `\r` there. Pacing them would be a change
  // made on a guess rather than on a measurement, on the one path where a wrong keystroke is a
  // model switch or a `/clear`.
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
   *
   * **Contract (P2-7): call this immediately after the Enter, once the body's echo has already
   * settled.** The baseline is taken synchronously here, so anything still echoing at that moment is
   * counted as "the turn started". It used to take that baseline on its own fixed `echoSettleMs`
   * timer, which is only correct while the echo is *shorter* than the timer; reproduced live
   * 2026-08-13 with a ~3.7KB message whose echo was still streaming 500ms later, so the baseline
   * landed mid-echo and the rest of the echo read as "real activity, the Enter must have landed".
   * The detector then stayed silent forever on a message that was never submitted - strictly worse
   * than having no detector, since the retry that would have rescued it never fired. `sendChannelText`
   * now owns that wait, because it is the same wait it already has to do before writing the Enter.
   */
  function confirmSubmitted(slug: string, topicId: number, write: (text: string) => void, attempt = 1): void {
    const baseline = lastActivityAt(slug) ?? 0;
    setTimeoutFn(() => {
      const lastActivity = lastActivityAt(slug) ?? 0;
      if (lastActivity > baseline) return; // real activity happened after the Enter
      if (attempt >= 2) {
        log("ERROR", `session "${slug}" produced no output after ${attempt} attempts to submit an inbound message - likely wedged`);
        autoRecoverWedgedSession(slug);
        return;
      }
      log("WARN", `session "${slug}" produced no output ${submitConfirmWindowMs}ms after an inbound message - retrying the Enter`);
      write("\r");
      confirmSubmitted(slug, topicId, write, attempt + 1);
    }, submitConfirmWindowMs);
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
   *
   * "Indistinguishable from a real crash" turned out to be false in one respect the original
   * reasoning missed, and P0-8 is the fix: a killed process still runs its own `SessionEnd` hook,
   * which marked the row `dead` before `handleUnexpectedExit` could resume it. `recoverWedgedPty`
   * now records the recovery in `wedgedRecoveryMarks` before killing, and `feed-wiring.ts` skips
   * the mark-dead for exactly that window.
   */
  function autoRecoverWedgedSession(slug: string): void {
    const recovered = recoverWedgedPty(ptyLookup, slug, wedgedRecoveryMarks);
    if (!recovered) return; // already gone - a manual /kill/rm, or a real crash, raced this same detection
    log(
      "WARN",
      `session "${slug}"'s PTY write-socket is dead but its process is still alive - killing it so the existing crash-resume path (§12 Phase 5) can relaunch it via claude --resume instead of leaving a zombie`,
    );
    // handleUnexpectedExit (wired in wireSession's onExit) takes over from here - it posts its own
    // "attempting to resume" notice, so no separate confirmSessionCommand here would just double up.
  }

  /**
   * A normal inbound turn: wrapped in the <channel> tag Claude Code would have rendered itself, for
   * text Claude should read and act on rather than a literal TUI keystroke.
   *
   * P2-7. The body and its `\r` used to go out in the same tick, and measured over a full
   * `bridge.log` that Enter failed to submit on **105 of 145** inbound messages. The mechanism is
   * visible in the PTY log once you look: a `renderChannelTag` body is multi-line, so Claude Code's
   * TUI collapses it into a `[Pasted text #1]` block - and a `\r` arriving right behind it is
   * absorbed into the paste as `[Pasted text #2 +1 lines]` rather than read as Enter. The retry
   * `\r` 2.5s later, arriving alone, submits normally, which is where the 2.5s latency on nearly
   * every turn came from, and seven messages were never rescued at all. Past roughly 3KB the retry
   * is lost too, because the still-streaming echo blinds `confirmSubmitted`.
   *
   * So the Enter now waits for the body's echo to appear *and then finish* before going out, which
   * both separates it from the paste and leaves the PTY genuinely quiet for `confirmSubmitted`'s
   * baseline. The wait is bounded, and a timeout still writes the `\r`: this makes the common case
   * correct without making the rare case worse, with `confirmSubmitted` still behind both.
   */
  function sendChannelText(slug: string, topicId: number, content: string, msgId: string, from: string): void {
    const write = routing.getPtyWrite(slug);
    if (!write) {
      log("WARN", `no live session for slug "${slug}" - inbound message dropped`);
      return;
    }
    // Both taken synchronously, before the write is queued: `seq` has to reflect the order messages
    // actually arrived in rather than the order the queue drains, and the operator's "typing"/
    // "Thinking..." acknowledgement belongs at the moment their message was accepted.
    seq += 1;
    const meta: ChannelMetaFields = { topic_id: String(topicId), msg_id: msgId, from, seq };
    const body = renderChannelTag(content, meta);
    typingIndicator.start(meta.topic_id);
    thinkingPlaceholder.start(meta.topic_id);
    enqueueWrite(slug, async () => {
      // Read *before* the write, and passed as the floor the echo has to beat. Without it the wait
      // measures the silence that was already there - the echo cannot have arrived yet a microsecond
      // after `write` returns - and resolves instantly, which is a no-op wearing the shape of a fix.
      const beforeWrite = lastActivityAt(slug) ?? 0;
      // Paced rather than one big write, and paced on the reader's own echo rather than on a timer -
      // see `DEFAULT_WRITE_CHUNK_CHARS` for the measurement behind both. A short body is a single
      // chunk and a single write, and skips the per-chunk wait entirely, exactly as before.
      const chunks = chunkForPty(body, writeChunkChars);
      for (let i = 0; i < chunks.length; i++) {
        const beforeChunk = lastActivityAt(slug) ?? 0;
        write(chunks[i]!);
        if (i < chunks.length - 1) await waitForQuiet(slug, chunkQuietMs, chunkQuietTimeoutMs, beforeChunk);
      }
      await waitForQuiet(slug, echoSettleMs, submitQuietTimeoutMs, beforeWrite);
      write("\r");
      // Armed here, not at call time: its window has to start from the Enter it is checking, and
      // that Enter may have been queued behind another message's. The PTY is quiet at this point by
      // construction, which is exactly the precondition its baseline needs.
      confirmSubmitted(slug, topicId, write);
      // Same reasoning for the same reason, one layer out: this measures whether a *turn* started,
      // not whether the PTY twitched, and its window must likewise begin at this Enter. It reads the
      // session state itself to decide whether arming is even meaningful - see `arm`'s doc comment
      // on why a message written into a mid-turn session must not be watched.
      opts.turnStartWatchdog?.arm(slug, topicId);
    });
  }

  return {
    sendRaw,
    sendEffortCommand,
    confirmSubmitted,
    autoRecoverWedgedSession,
    sendChannelText,
  };
}
