/**
 * `codebase-hardening-plan.md` P1-9: what a failed child process actually told us, pulled off the
 * thrown value in one place.
 *
 * Written after a real incident (2026-08-12) where every `/new` on one daemon instance failed with
 * exactly `Failed to launch session "<slug>": Command failed: git worktree add <path> -b <branch>`
 * and nothing else, while the same command run by hand succeeded seconds later. A Bridge restart
 * cleared it and the cause is still unknown, because two things were missing at the point of
 * failure: nothing was written to `bridge.log` at all (the catch posted to Telegram and returned),
 * and the message carried only `err.message`.
 *
 * That second gap is subtler than it looks. Node appends a failed child's stderr to the `Error` it
 * throws from `execFileSync`, so the message ending right after the command means git exited
 * non-zero having printed *nothing* - which is itself a strong signal (a killed process, a blocked
 * binary) rather than the absence of one. Distinguishing "stderr was empty" from "stderr was never
 * looked at" needs `status`/`signal`, neither of which was reported anywhere.
 *
 * §9's silent-wrong bar: every field here is optional on a value typed `unknown`, so the failure
 * mode of getting it wrong is a plausible-looking diagnostic line that quietly omits the one field
 * that mattered - not a crash. Hence `exec-failure.test.ts`.
 */

/** The reportable parts of a thrown value, whatever it turned out to be. */
export interface ExecFailure {
  /** `err.message` for an `Error`, `String(err)` for anything else (including a thrown string). */
  message: string;
  /** The child's exit code, when the throw came from `execFileSync`/`spawnSync` and it exited. */
  status?: number;
  /** The signal that killed the child, when it was killed instead of exiting. */
  signal?: string;
  /** Captured stderr, trimmed. `undefined` when absent; `""` is preserved as a real observation. */
  stderr?: string;
}

/**
 * Never throws and never guesses: a field is populated only when the thrown value genuinely carries
 * it in the shape Node uses, so a plain `new Error("boom")` yields just a message rather than a line
 * claiming a meaningless `exit 0`.
 */
export function describeExecFailure(err: unknown): ExecFailure {
  const message = err instanceof Error ? err.message : String(err);
  const detail: ExecFailure = { message };
  if (typeof err !== "object" || err === null) return detail;

  const candidate = err as { status?: unknown; signal?: unknown; stderr?: unknown };
  // `status` is `null` (not absent) on a signal kill, and a signal name is `null` on a normal exit -
  // check the type rather than truthiness, or a legitimate `exit 0`-shaped value would be dropped.
  if (typeof candidate.status === "number") detail.status = candidate.status;
  if (typeof candidate.signal === "string") detail.signal = candidate.signal;
  if (typeof candidate.stderr === "string" || candidate.stderr instanceof Uint8Array) {
    detail.stderr = candidate.stderr.toString().trim();
  }
  return detail;
}

/**
 * The short "how did it end" clause for an operator-facing message, e.g. ` (exit 128)`. Empty for a
 * throw that never reached a child process, so an ordinary error reads exactly as it did before.
 */
export function formatExitClause(failure: ExecFailure): string {
  if (failure.signal !== undefined) return ` (killed by ${failure.signal})`;
  if (failure.status !== undefined) return ` (exit ${failure.status})`;
  return "";
}

/** `logger.ts` writes one line per entry, prefixed with a timestamp and level. Anything containing a
 * newline therefore becomes several lines, only the first of which carries that prefix - so a
 * `grep ERROR bridge.log` shows the header and silently hides everything after the first newline.
 * Node's `execFileSync` message embeds the child's stderr, newline and all, which is exactly the
 * text this module reports: live-verified 2026-08-12, the first version of this function put
 * `status:`/`stderr:` on an unprefixed continuation line and a grep for the failure showed neither. */
function oneLine(text: string): string {
  // Trim *before* substituting, or the trailing newline `execFileSync` messages always end with
  // becomes a dangling " / " separator with nothing after it.
  return text.trim().replace(/\s*\r?\n\s*/g, " / ");
}

/**
 * The full diagnostic line for `bridge.log` - always a single line, see `oneLine`.
 *
 * Reports an empty stderr explicitly as `stderr: (empty)` rather than omitting it: "the child
 * printed nothing" is the observation that would have short-cut the incident this module exists for,
 * and an omitted field is indistinguishable from a check nobody made. When stderr is non-empty it is
 * only appended if the message doesn't already carry it, since Node appends a failed child's stderr
 * to `err.message` itself and printing it twice makes the line harder to read, not more complete.
 */
export function formatExecFailureForLog(failure: ExecFailure): string {
  const message = oneLine(failure.message);
  const parts = [message];
  if (failure.signal !== undefined) parts.push(`signal: ${failure.signal}`);
  if (failure.status !== undefined) parts.push(`status: ${failure.status}`);
  if (failure.stderr !== undefined) {
    const stderr = oneLine(failure.stderr);
    if (stderr.length === 0) parts.push("stderr: (empty)");
    else if (!message.includes(stderr)) parts.push(`stderr: ${stderr}`);
  }
  return parts.join(" | ");
}
