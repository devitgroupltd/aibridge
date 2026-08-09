/**
 * §7.2's "found while writing the README, not fixed" gap: a Task Scheduler launch (autostart)
 * captures no stdout/stderr, unlike `scripts/dev-bridge.sh`'s `start()`, which only gets a log file
 * because the *shell launcher* redirects the dev Bridge's own stdout there - the Bridge process itself
 * never owned a log sink. `console.log` alone is invisible the moment a launch method doesn't happen
 * to redirect stdout somewhere, which is exactly Task Scheduler's default (`/TR`'s target process runs
 * directly, no shell, nowhere for a `> file 2>&1` to attach to).
 *
 * Fix: the Bridge owns its own file sink now, independent of how it was launched. `initFileLogging`
 * is called once at startup with `STATE_DIR` (`config.ts`) - every `log()` call writes to both stdout
 * (dev tooling's existing `bridge-dev.log` redirect keeps working unchanged) and `%LOCALAPPDATA%\
 * aibridge\bridge.log`, so a silent post-reboot failure finally has a real log file to read instead of
 * only `/autostart status`'s bare Win32 exit code and Windows' own Task Scheduler operational log.
 *
 * Before `initFileLogging` is called (or if it's never called, e.g. most existing unit tests that
 * import index.ts's helpers directly), `log()` degrades to console-only - never a behavior change for
 * anything that doesn't opt in.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export type LogLevel = "INFO" | "WARN" | "ERROR";

/** A generous cap, not a tight one - this is a diagnostic log for an unattended daemon, not a
 * high-volume trace; 10MB holds days of normal `log()` volume before rotation ever fires. */
const MAX_LOG_BYTES = 10 * 1024 * 1024;

let logFilePath: string | null = null;
/** Running total of `logFilePath`'s own byte size, maintained incrementally by `log()`'s own
 * appends rather than re-derived from a real `statSync` on every call - see `rotateIfNeeded`'s own
 * doc comment for why a per-line syscall was worth removing and what keeps this safe. */
let knownLogBytes = 0;
/** False whenever `knownLogBytes` cannot yet be trusted - right after `initFileLogging` (a fresh
 * boot/restart may already have a large `bridge.log` left over from the previous run, entirely
 * unknown to this fresh process) and right after `resetFileLogging`. `rotateIfNeeded` re-seeds
 * `knownLogBytes` from one real stat the next time it's needed and flips this back to true - after
 * that, every log line updates the running total instead of asking the OS again. */
let logBytesKnown = false;

/** Call once at startup. Idempotent - a second call just repoints the sink (used by tests). Creates
 * `stateDir` if it isn't there: on a fresh machine (or before `config.ts` has created anything)
 * every `appendFileSync` below would otherwise throw ENOENT and be swallowed by the best-effort
 * catch, defeating this module's entire purpose precisely on the first boot - the run most likely to
 * be the one that fails. */
export function initFileLogging(stateDir: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    // Still set the path - if the directory turns up later (config.ts creates it too), logging starts
    // working on its own rather than staying permanently disabled by one early failure.
  }
  logFilePath = path.join(stateDir, "bridge.log");
  logBytesKnown = false; // this process has no idea yet how big (if at all) the file already is
}

/** Test-only escape hatch back to console-only, so one test's file sink can't leak into another's. */
export function resetFileLogging(): void {
  logFilePath = null;
  logBytesKnown = false;
}

/**
 * One rotated backup (`bridge.log.1`), not a numbered series - this is "don't lose the last few
 * days," not a full log-retention policy. Best-effort: a rotation failure (e.g. the `.1` file is
 * open elsewhere) falls through to a normal append rather than blocking the log line entirely.
 *
 * §9, found live 2026-08-09: this used to call `statSync` unconditionally on *every single* `log()`
 * call - two synchronous syscalls (this plus `appendFileSync`) on what is, across a busy fleet, the
 * hottest path in the whole process (every hook event, PTY chunk, feed edit, governor decision all
 * log). `knownLogBytes` tracks the file's size incrementally from `log()`'s own appends instead, so
 * the real syscall only happens once per "epoch" - right after `initFileLogging`/a fresh boot (this
 * process genuinely doesn't know the file's size yet, e.g. a restart inheriting a near-cap file from
 * the previous run) and once right after each rotation (the size resets to whatever the fresh append
 * below adds) - not once per line in between. Nothing outside this module ever writes to
 * `bridge.log`, so the tracked total can't silently drift out from under it between those points.
 */
function rotateIfNeeded(filePath: string): void {
  if (!logBytesKnown) {
    try {
      knownLogBytes = statSync(filePath).size;
    } catch {
      knownLogBytes = 0; // doesn't exist yet - nothing to rotate
    }
    logBytesKnown = true;
  }
  if (knownLogBytes <= MAX_LOG_BYTES) return;
  const rotated = `${filePath}.1`;
  try {
    rmSync(rotated, { force: true });
    renameSync(filePath, rotated);
    knownLogBytes = 0;
  } catch {
    // best-effort - an in-progress append will just keep growing the current file this once, and
    // `knownLogBytes` deliberately stays as-is (still over cap) so the *next* call retries the
    // rotation rather than assuming this one succeeded.
  }
}

/** §9's convention: ERROR/WARN/INFO, never a token or full tool input in the line. File-sink writes
 * are entirely best-effort - a logging failure (disk full, permissions, `STATE_DIR` unwritable) must
 * never be the reason the Bridge itself goes down. */
export function log(level: LogLevel, message: string): void {
  const line = `[${new Date().toISOString()}] ${level} ${message}`;
  console.log(line);
  if (!logFilePath) return;
  try {
    rotateIfNeeded(logFilePath);
    appendFileSync(logFilePath, line + "\n");
    // Byte length, not `.length` (UTF-16 code units) - `MAX_LOG_BYTES` is a byte cap and a message
    // containing multi-byte characters would otherwise under-count against it.
    knownLogBytes += Buffer.byteLength(line, "utf8") + 1;
  } catch {
    // best-effort - see doc comment above
  }
}
