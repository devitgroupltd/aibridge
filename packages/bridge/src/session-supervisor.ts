import path from "node:path";
import type * as pty from "node-pty";
import { fireAndForget } from "./fire-and-forget.ts";
import { findOrphanProcesses } from "./orphan-scan.ts";
import { listClaudeProcesses } from "./process-scan.ts";
import { reconcile } from "./reconciliation.ts";
import { attachPtyWriteGuard, type PtyLike } from "./pty-write-guard.ts";
import { isTopicDeleted, type ChatActionSource } from "./topic-probe.ts";
import { launchSession as realLaunchSession, stripAnsi } from "./session-launcher.ts";
import type { LaunchedSession, SessionLaunchOptions } from "./session-launcher.ts";
import type { Routing } from "./routing.ts";
import type { SessionRow, SessionStore } from "./session-store.ts";
import type { InlineKeyboardMarkup } from "./telegram.ts";

/** §4.5's backoff ladder for `handleUnexpectedExit`'s auto-resume: 1s, then 15s, then 60s, then
 * give up (`MAX_CONSECUTIVE_RESUME_ATTEMPTS`) - guards against a stale `session_id` causing
 * `claude --resume` to fail instantly and relaunch in an unbounded, ever-flooding loop (§4.5). */
export const RESUME_BACKOFF_MS = [1000, 15_000, 60_000] as const;
export const MAX_CONSECUTIVE_RESUME_ATTEMPTS = 3;

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

/** §5.4's P1 lane: fleet-command echoes and session lifecycle notices this module posts on its
 * own initiative (crash/resume notices, orphan-process reports, reconciliation results) - never
 * delayed behind P2 feed traffic, itself never allowed to delay a P0 permission prompt/question.
 * Injected rather than reimplemented: the composition root constructs the real P1-lane wrapper
 * once and every module that needs it (this one included) shares that one instance. */
export type ConfirmSessionCommand = (
  topicId: number | undefined,
  text: string,
  parseMode?: "HTML",
  keyboard?: InlineKeyboardMarkup,
) => void;

export interface SessionSupervisorOptions {
  sessionStore: SessionStore;
  routing: Routing;
  /** Only `sendChatAction` (via `isTopicDeleted`) is needed here - `confirmSessionCommand` is
   * where every actual message send goes through instead. */
  controlBot: ChatActionSource;
  confirmSessionCommand: ConfirmSessionCommand;
  supergroupChatId: string;
  /** Excluded from every reconciliation/orphan pass - the hardcoded self-check session is
   * launched fresh, unconditionally, by the composition root itself (a known simplification,
   * §12 Phase 1: it predates this table and isn't itself in Phase 5's reconciliation scope). */
  selfCheckSlug: string;
  otlpPort?: number;
  log?: LogFn;
  /** Injectable clock, so `resumeSession`'s `sessionStore.setState`/`nowIso()` calls and (more
   * importantly) `handleUnexpectedExit`'s backoff delay are fakeable in tests without real waits.
   * Defaults to the real clock. */
  now?: () => string;
  /** Injectable delay primitive backing `handleUnexpectedExit`'s backoff wait - defaults to a
   * real `setTimeout`. Tests inject a fake that resolves immediately (or records the requested
   * delay) instead of actually waiting out `RESUME_BACKOFF_MS`. */
  delay?: (ms: number) => Promise<void>;
  /** Shared with `handleUsageCommand`/`fleet-confirm-flow.ts`: a `/usage` poll parked on a slug
   * waiting for the PTY to echo the answer. Read-only from this module's side - `wireSession`'s
   * `onData` handler feeds every chunk to whichever poll (if any) is currently waiting on that
   * slug, exactly as the pre-split code did inline. */
  usageWaiters?: Map<string, { buffer: string; check: () => void }>;
  /** Injectable in place of the real `session-launcher.ts` `launchSession` - `resumeSession`'s
   * `resumeFailed` branch and the whole crash-resume loop are otherwise only reachable by actually
   * spawning a `claude` PTY process. Defaults to the real `launchSession`. */
  launchSession?: (opts: SessionLaunchOptions) => LaunchedSession;
}

export interface SessionSupervisor {
  isPidAlive(pid: number): boolean;
  reapRowsWithDeletedTopics(rows: readonly SessionRow[]): Promise<SessionRow[]>;
  reportOrphanProcesses(): Promise<void>;
  runStartupReconciliation(): Promise<void>;
  wireSession(slug: string, ptyProcess: pty.IPty, topicId: number): void;
  handleUnexpectedExit(slug: string, ptyProcess: pty.IPty, topicId: number, exitCode: number): Promise<void>;
  resumeSession(row: SessionRow): Promise<void>;
  /** Read accessor for consumers that need to reach a tracked PTY without owning the map
   * themselves - the dev-control debug HTTP server (composition root) in particular. */
  getPtyProcess(slug: string): pty.IPty | undefined;
  /** Kills the tracked PTY (if any) and untracks it - the shared "actual teardown" primitive
   * `killSessionRow`/the `/kill --all` bulk path (`session-lifecycle-commands.ts`) both need,
   * since both mutate the same map this module owns. */
  killAndUntrack(slug: string): void;
  /** Untracks a slug without killing its PTY - `removeSessionRow`'s `/rm` path already killed
   * conditionally (only when `row.state !== "dead"`, to avoid a redundant kill signal on an
   * already-dead row's leftover entry) before this is called; kept separate from
   * `killAndUntrack` rather than composed from it so that conditional-kill nuance stays visible
   * at the call site instead of being silently absorbed into an always-kills helper. */
  untrack(slug: string): void;
  /** `feed-wiring.ts`'s `handleHookEvent` clears a slug's resume-attempt counter once a real hook
   * event proves the session is alive again - this module owns `resumeAttempts`, so that clear
   * goes through this mutator rather than `feed-wiring.ts` reaching into a raw `Map` it doesn't
   * own (see the plan's Risks section). */
  clearResumeAttempts(slug: string): void;
  /** Last real (non-ANSI-only) PTY activity timestamp for a slug, ms since epoch - read by
   * `pty-io.ts`'s `autoRecoverWedgedSession` to detect a truly wedged (not just quiet) session. */
  lastActivityAt(slug: string): number | undefined;
}

/**
 * §12 Phase 5's session supervisor: PTY liveness tracking, startup reconciliation (§4.5), and the
 * crash-resume loop. Owns `ptyProcessBySlug`/`resumeAttempts`/`lastPtyActivityBySlug` - nothing
 * outside this module mutates them directly; `getPtyProcess`/`killAndUntrack`/`clearResumeAttempts`
 * are the only sanctioned access points for the handful of other modules that need one.
 */
export function createSessionSupervisor(opts: SessionSupervisorOptions): SessionSupervisor {
  const { sessionStore, routing, controlBot, confirmSessionCommand, supergroupChatId, selfCheckSlug, otlpPort } = opts;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date().toISOString());
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const usageWaiters = opts.usageWaiters ?? new Map<string, { buffer: string; check: () => void }>();
  const launchSession = opts.launchSession ?? realLaunchSession;

  const ptyProcessBySlug = new Map<string, pty.IPty>();
  /** Guards `handleUnexpectedExit`'s relaunch loop against a stale `session_id` causing an
   * immediate-refail, unbounded-relaunch flood (§4.5) - cleared once a real hook event proves the
   * session is actually alive again (`feed-wiring.ts`'s `handleHookEvent`, via `clearResumeAttempts`). */
  const resumeAttempts = new Map<string, number>();
  const lastPtyActivityBySlug = new Map<string, number>();

  /**
   * §4.5's reconciliation, wired for real: on this stack (measured 2026-08-03) a live session's
   * process never survives the Bridge dying, so `readopt` (row 1 - "process alive") is defensive
   * only, kept for the untested-in-practice recycled-pid case §4.5 calls out - it still relaunches
   * fresh rather than pretending an orphaned handle is usable. Every other non-`dead` row always
   * lands on `resume`. Scoped to every slug except the hardcoded self-check one, which the
   * composition root already launches fresh unconditionally rather than resuming.
   */
  function isPidAlive(pid: number): boolean {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** §4.5's "row exists, topic deleted in Telegram" row: probed live (there's no `getForumTopic`
   * to just ask - see `topic-probe.ts`) before spending a resume attempt on a topic nothing can be
   * posted to. Marks the row `dead` and notifies the control topic instead of the (gone) session
   * topic - a `resumeSession` for a deleted topic would itself fail to post its own confirmation,
   * silently, which is worse than skipping it outright. */
  async function reapRowsWithDeletedTopics(rows: readonly SessionRow[]): Promise<SessionRow[]> {
    const survivors: SessionRow[] = [];
    for (const row of rows) {
      const deleted = await isTopicDeleted(controlBot, supergroupChatId, row.topicId);
      if (deleted) {
        sessionStore.setState(row.slug, "dead", now());
        log("WARN", `session "${row.slug}"'s Telegram topic was deleted while the Bridge was down (§4.5) - marked dead, worktree preserved at ${row.worktreePath}`);
        confirmSessionCommand(undefined, `Session "${row.slug}" was marked dead: its Telegram topic no longer exists. Worktree preserved at ${row.worktreePath}.`);
      } else {
        survivors.push(row);
      }
    }
    return survivors;
  }

  /** §4.5's "process alive, no row" orphan row: a `claude` process this Bridge instance never
   * launched (or lost track of) that's still holding onto a worktree. Detected, logged and
   * surfaced to the control topic for manual review only - an unrecognized live process is never
   * auto-killed (deciding to kill something is the operator's call, not a startup heuristic's). */
  async function reportOrphanProcesses(): Promise<void> {
    const processes = await listClaudeProcesses();
    if (processes.length === 0) return;
    const orphans = findOrphanProcesses(processes, sessionStore.all());
    if (orphans.length === 0) return;
    const pidList = orphans.map((o) => o.pid).join(", ");
    log("WARN", `found ${orphans.length} orphaned claude process(es) with no matching session row (§4.5): pid(s) ${pidList}`);
    confirmSessionCommand(
      undefined,
      `Found ${orphans.length} orphaned claude process(es) not tracked by any session row: pid(s) ${pidList}. Not killed automatically - review and end manually if unwanted.`,
    );
  }

  async function runStartupReconciliation(): Promise<void> {
    await reportOrphanProcesses();
    const rows = sessionStore.all().filter((r) => r.slug !== selfCheckSlug && r.state !== "dead");
    if (rows.length === 0) return;
    const live = await reapRowsWithDeletedTopics(rows);
    if (live.length === 0) return;
    const actions = reconcile(live, isPidAlive);
    for (const action of actions) {
      if (action.kind === "readopt") {
        log("WARN", `session "${action.slug}"'s process is still alive after a Bridge restart, but the PTY handle is gone (§4.5) - resuming on a fresh PTY anyway`);
      }
    }
    for (const row of live) {
      log("INFO", `reconciling session "${row.slug}" after a Bridge restart`);
      await resumeSession(row);
    }
  }

  /** Wires up a freshly-spawned (or resumed) session's PTY: the routing table's write/output-tail
   * plumbing, the `ptyProcessBySlug` liveness map, and this module's crash detector. Shared by
   * the self-check launch, `/new`, and every `resumeSession` relaunch so the three don't drift. */
  function wireSession(slug: string, ptyProcess: pty.IPty, topicId: number): void {
    // See pty-write-guard.ts's own doc comment for why both the write try/catch and the `'error'`
    // listener are required - one alone left one stale keystroke (or, live 2026-08-06, `/new`'s very
    // first write into a session whose `waitForChannelConnected` wait had already given up) able to
    // crash the whole daemon and every other session with it.
    routing.setPtyWrite(slug, attachPtyWriteGuard(ptyProcess as unknown as PtyLike, slug, { log }));
    ptyProcess.onData((data) => {
      // An onData event alone is too loose a signal - confirmed live 2026-08-04 that a wedged
      // session still periodically emits ANSI-only chunks (cursor blink, resize repaint) with no
      // visible text at all, which defeated the first version of this check entirely. Only content
      // that survives `stripAnsi` counts as real activity.
      if (stripAnsi(data).length > 0) lastPtyActivityBySlug.set(slug, Date.now());
      routing.appendOutput(slug, data);
      const usageState = usageWaiters.get(slug);
      if (usageState) {
        usageState.buffer += data;
        usageState.check();
      }
    });
    ptyProcessBySlug.set(slug, ptyProcess);
    ptyProcess.onExit(({ exitCode }) => {
      fireAndForget(handleUnexpectedExit(slug, ptyProcess, topicId, exitCode), log, `session-supervisor handleUnexpectedExit(${slug})`);
    });
  }

  /**
   * The supervisor's health/restart-on-crash duty (§12 Phase 5). Fires on *any* PTY exit,
   * deliberate or not - the `ptyProcessBySlug.get(slug) !== ptyProcess` check is what tells the two
   * apart: `/kill`/`/rm` both delete the map entry before calling `.kill()`, so by the time this
   * (asynchronous) exit handler runs for that call, the entry is already gone or already points at
   * a newer PTY, and this is a silent no-op. Anything else is a real crash, and gets the same
   * `claude --resume` treatment §4.5 already gives a Bridge restart.
   */
  async function handleUnexpectedExit(slug: string, ptyProcess: pty.IPty, topicId: number, exitCode: number): Promise<void> {
    if (ptyProcessBySlug.get(slug) !== ptyProcess) return;
    ptyProcessBySlug.delete(slug);
    routing.clearPtyWrite(slug);
    const row = sessionStore.get(slug);
    if (!row || row.state === "dead") return;
    // An immediate re-exit is the dangerous case, not a one-off crash: a stale `session_id` makes
    // `claude --resume` fail instantly ("No conversation found with session ID: ..." - observed for
    // three sessions at once), and since `launchSession` itself succeeds, nothing self-limits. The
    // old code relaunched about once a second forever, each cycle pushing two never-dropped P1
    // sends into the governor's unbounded queue while ~20/min drain: an unbounded queue, unbounded
    // memory, and a topic flooded indefinitely. The "SessionEnd marks it dead" self-heal doesn't
    // apply here, because `claude` dies before any hook fires.
    const attempts = (resumeAttempts.get(slug) ?? 0) + 1;
    resumeAttempts.set(slug, attempts);
    if (attempts > MAX_CONSECUTIVE_RESUME_ATTEMPTS) {
      sessionStore.setState(slug, "dead", now());
      resumeAttempts.delete(slug);
      log("ERROR", `session "${slug}" exited immediately ${attempts} times in a row - marking it dead instead of resuming again`);
      confirmSessionCommand(
        topicId,
        `⚠️ Session "${slug}" exited immediately ${attempts} times in a row (last code ${exitCode}) - giving up on automatic resume. Worktree preserved at ${row.worktreePath}; /rm to clear it.`,
      );
      return;
    }
    const delayMs = RESUME_BACKOFF_MS[Math.min(attempts - 1, RESUME_BACKOFF_MS.length - 1)]!;
    log("WARN", `session "${slug}" exited unexpectedly (code ${exitCode}) - resume attempt ${attempts} in ${delayMs}ms`);
    confirmSessionCommand(topicId, `⚠️ Session "${slug}" exited unexpectedly. Attempting to resume it automatically (attempt ${attempts})...`);
    await delay(delayMs);
    await resumeSession(row);
  }

  /** Marks `slug` dead if (and only if) its row still exists and isn't already dead - every
   * "give up, mark it dead" branch in `resumeSession` goes through this rather than a raw
   * `sessionStore.setState(slug, "dead", ...)`, because that throws `unknown slug` (§9's own
   * exhaustive-transition-table discipline, session-store.ts) if the row was removed by a `/rm`
   * that raced this same async function - and an uncaught throw here propagates out through the
   * bare `void handleUnexpectedExit(...)` at this module's `onExit` handler into the global
   * `unhandledRejection -> process.exit(1)` (index.ts), taking down every other session in the
   * fleet over one operator command that has nothing to do with them (found live 2026-08-09). */
  function markDeadIfPresent(slug: string): void {
    const current = sessionStore.get(slug);
    if (current && current.state !== "dead") sessionStore.setState(slug, "dead", now());
  }

  /**
   * Shared by both restart-recovery paths - a Bridge restart (`runStartupReconciliation`) and a
   * live crash (`handleUnexpectedExit`) - since both need exactly the same thing: relaunch via
   * `claude --resume <session_id>` on a fresh PTY, rewire it, and tell the topic what happened.
   * §4.5's "row exists, `state = awaiting_input`" case is handled first since the pending prompt
   * is gone either way and needs its own notice, distinct from the resume notice.
   *
   * Re-reads the row from the store as its very first step rather than trusting `row` (the
   * caller's own snapshot) for anything beyond `topicId`/`worktreePath` (fields that don't change
   * once a session exists). `handleUnexpectedExit`'s snapshot in particular can be up to
   * `RESUME_BACKOFF_MS`'s longest entry (60s) stale by the time this runs - long enough for an
   * operator's `/rm` (removes the row) or `/kill` (marks it `dead`) to land during the wait. Found
   * live 2026-08-09: without this re-read, a `/rm` during the backoff wait crashed the whole
   * Bridge (see `markDeadIfPresent`'s own doc comment), and a `/kill` during the wait still let the
   * stale snapshot's resume fire, resurrecting a session the operator had just deliberately ended.
   */
  async function resumeSession(row: SessionRow): Promise<void> {
    const { slug, topicId } = row;
    const current = sessionStore.get(slug);
    if (!current) {
      log("INFO", `resumeSession("${slug}") skipped - its row no longer exists (removed, most likely by /rm, during the resume wait)`);
      return;
    }
    if (current.state === "dead") {
      log("INFO", `resumeSession("${slug}") skipped - it was already marked dead (most likely by /kill) during the resume wait`);
      return;
    }
    if (current.state === "awaiting_input") {
      sessionStore.setState(slug, "working", now());
      confirmSessionCommand(topicId, "The pending question was lost - please re-ask.");
    }
    if (!current.sessionId) {
      markDeadIfPresent(slug);
      confirmSessionCommand(topicId, `Session "${slug}" could not be resumed (no session id was recorded yet). Worktree preserved at ${row.worktreePath}.`);
      return;
    }
    try {
      const session = launchSession({
        slug,
        topicId,
        repoPath: current.repoPath,
        worktreesRoot: path.dirname(current.worktreePath),
        model: current.model,
        resumeSessionId: current.sessionId,
        otlpPort,
        log,
      });
      wireSession(slug, session.ptyProcess, topicId);
      sessionStore.setPtyPid(slug, session.ptyProcess.pid ?? 0);
      // Without this, `routing.getByTopicId(topicId)` stays undefined for this session forever
      // after this restart (only the self-check slot and freshly-`/new`'d sessions ever call
      // `routing.add` otherwise) - every message in its topic then silently drops at the
      // `!isControl && !route` guard, with no error and no log line. Confirmed live 2026-08-04:
      // a resumed session answered /ls (control topic, doesn't need routing) but never replied to
      // anything sent in its own topic - not the command being wrong, the route being missing.
      routing.add({ slug, topicId, worktreePath: current.worktreePath });
      // `claude --resume` failing (`RESUME_FAILURE_PATTERN`) doesn't throw or exit the process - it
      // silently falls through to a brand-new conversation in the same PTY - so this must be checked
      // rather than assumed: found live 2026-08-07, a session whose crash-before-first-transcript-
      // write left `row.sessionId` pointing at a conversation Claude Code could never find again sat
      // "resumed" in the topic forever with no further reply, since the operator's original prompt
      // was never resent into the fresh conversation underneath.
      const { resumeFailed } = await session.ready;
      if (resumeFailed) {
        log("WARN", `session "${slug}"'s claude --resume ${current.sessionId} failed (no matching conversation) - it started a fresh conversation instead`);
        // That fresh conversation has no relation to what was actually asked for, and `dead` is
        // `session-store.ts`'s own terminal state (no path back from it) - the row is very likely
        // already `dead` by now anyway, from the `SessionEnd` hook that fires for the abandoned
        // resume racing this very check (confirmed live 2026-08-07). Killing the pty here, rather
        // than leaving Claude Code's own fresh-start running, is what makes §4.3's "This session
        // has ended" reply true instead of a lie: an untracked live PTY behind a `dead` row would
        // otherwise burn a Claude Code seat and a worktree forever with no way for the operator to
        // reach or reclaim it. Same delete-then-kill ordering `killAndUntrack` uses, so the async
        // `onExit` this fires sees the map entry already gone and treats it as a deliberate kill,
        // not a crash to auto-resume.
        ptyProcessBySlug.delete(slug);
        session.ptyProcess.kill();
        routing.clearPtyWrite(slug);
        markDeadIfPresent(slug);
        confirmSessionCommand(
          topicId,
          `⚠️ Session "${slug}" couldn't resume its prior conversation (Claude reported no matching session) - this session has ended. Worktree preserved at ${row.worktreePath}; /new to start a fresh one.`,
        );
      } else {
        confirmSessionCommand(topicId, `Session "${slug}" resumed.`);
      }
    } catch (err) {
      markDeadIfPresent(slug);
      confirmSessionCommand(topicId, `Failed to resume "${slug}": ${(err as Error).message}. Worktree preserved at ${row.worktreePath}.`);
    }
  }

  function getPtyProcess(slug: string): pty.IPty | undefined {
    return ptyProcessBySlug.get(slug);
  }

  function killAndUntrack(slug: string): void {
    // Delete-then-kill, not kill-then-delete (0.10x.0 fix): `handleUnexpectedExit`'s own doc comment
    // states the invariant it depends on as "`/kill`/`/rm` both delete the map entry before calling
    // `.kill()`" - the map entry being gone by the time the async `onExit` handler runs is what tells
    // a deliberate kill apart from a real crash there. The old order only worked by accident, because
    // node-pty's `onExit` fires asynchronously; a synchronous emitter (or an awaited step ever landing
    // between these two lines) would misclassify a deliberate `/kill`/`/rm` as a crash and auto-resume
    // a session the operator just killed.
    const proc = ptyProcessBySlug.get(slug);
    untrack(slug);
    proc?.kill();
  }

  function untrack(slug: string): void {
    ptyProcessBySlug.delete(slug);
    // §9, found live 2026-08-09: neither of these was ever cleared on teardown before - a `/kill`
    // or `/rm` left both pinned for a slug that no longer has a live session, growing without bound
    // across the many `/new`+`/rm` cycles a daemon meant to run for weeks will see. A stale
    // `resumeAttempts` entry in particular isn't only a leak: `slug.ts` derives a slug from the
    // prompt's own first words, so a later `/new` reusing the exact same slug is entirely possible
    // - without this, that unrelated fresh session would inherit a resume-attempt count that was
    // never its own, and could give up on auto-resuming its very first real crash instead of
    // getting the full `RESUME_BACKOFF_MS` ladder.
    resumeAttempts.delete(slug);
    lastPtyActivityBySlug.delete(slug);
  }

  function clearResumeAttempts(slug: string): void {
    resumeAttempts.delete(slug);
  }

  function lastActivityAt(slug: string): number | undefined {
    return lastPtyActivityBySlug.get(slug);
  }

  return {
    isPidAlive,
    reapRowsWithDeletedTopics,
    reportOrphanProcesses,
    runStartupReconciliation,
    wireSession,
    handleUnexpectedExit,
    resumeSession,
    getPtyProcess,
    killAndUntrack,
    untrack,
    clearResumeAttempts,
    lastActivityAt,
  };
}
