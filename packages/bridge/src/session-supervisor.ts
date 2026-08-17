import path from "node:path";
import type * as pty from "node-pty";
import { describeExecFailure, formatExecFailureForLog, formatExitClause } from "./exec-failure.ts";
import { fireAndForget } from "./fire-and-forget.ts";
import type { LateBound } from "./late-bound.ts";
import { findOrphanProcesses } from "./orphan-scan.ts";
import type { ProcessInfo } from "./orphan-scan.ts";
import { listClaudeProcesses } from "./process-scan.ts";
import { reconcile } from "./reconciliation.ts";
import type { ReposRegistry } from "./repos-registry.ts";
import { attachPtyWriteGuard, type PtyLike } from "./pty-write-guard.ts";
import { isTopicDeleted, type ChatActionSource } from "./topic-probe.ts";
import { launchSession as realLaunchSession, stripAnsi } from "./session-launcher.ts";
import type { LaunchedSession, SessionLaunchOptions } from "./session-launcher.ts";
import type { Routing } from "./routing.ts";
import type { SessionRow, SessionStore } from "./session-store.ts";
import type { InlineKeyboardMarkup } from "./telegram.ts";
import type { LogFn } from "./logger.ts";

/** §4.5's backoff ladder for `handleUnexpectedExit`'s auto-resume: 1s, then 15s, then 60s, then
 * give up (`MAX_CONSECUTIVE_RESUME_ATTEMPTS`) - guards against a stale `session_id` causing
 * `claude --resume` to fail instantly and relaunch in an unbounded, ever-flooding loop (§4.5). */
export const RESUME_BACKOFF_MS = [1000, 15_000, 60_000] as const;
export const MAX_CONSECUTIVE_RESUME_ATTEMPTS = 3;

/** resume-nudge-on-lost-permission-plan.md §6/§7: how long to wait after the first resume nudge
 * before checking whether it actually landed. Three live trials (2026-08-10, two different
 * wordings plus `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=0`) all showed the same shape - a resumed
 * session's own turn in response to the nudge completes in a handful of seconds (a few dozen to
 * ~100 thinking tokens, `Stop` hook firing shortly after) whether or not it actually retried
 * anything - so 20s is generous headroom past that, not a guess at how long a real retry attempt
 * takes to finish (that's unbounded and this check does not wait for it). */
export const RESUME_NUDGE_FOLLOWUP_DELAY_MS = 20_000;

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
  /** Live getter (`/repos add`/`/repos reload` reassign the registry at runtime), used for exactly
   * one thing: recovering a resumed session's `projectMcp` opt-in. A session row records
   * `repoPath` and never the registry name it came from, so this looks the entry up by path -
   * see `ReposRegistry.getByPath`. Absent, or a path no longer registered, resolves to the closed
   * default, which is the right way for this particular lookup to fail. */
  getReposRegistry?: () => ReposRegistry | undefined;
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
  /** Injectable in place of the real OS pid-liveness probe (`process.kill(pid, 0)`, a read-only
   * signal) - shared by boot reconciliation's `reconcile()` call and `resumeSession`'s stale-orphan
   * check below. Defaults to the real probe; tests inject a fake so a fixture row's arbitrary
   * `ptyPid` never actually signals whatever real OS process happens to own that number. */
  isPidAlive?: (pid: number) => boolean;
  /** Injectable in place of the real `process-scan.ts` WMI sweep. Defaults to the real
   * `listClaudeProcesses`.
   *
   * Exists for the same reason `isPidAlive` does - the real one touches the host - but the concrete
   * cost was a recurring CI failure rather than a stray signal. `runStartupReconciliation` awaits
   * `reportOrphanProcesses()` unconditionally, before any early return, so *every* test that drives
   * a startup reconciliation was spawning a real `powershell -Command "Get-CimInstance
   * Win32_Process"` and waiting on WMI. That costs ~1s on a developer box and comfortably exceeds
   * bun's 5000ms default test timeout on a loaded hosted Windows runner, which is exactly how it
   * presented: green locally and on the PR, then a timeout on `main` (2026-08-13 took all three
   * tests in the block, 2026-08-14 took one of them). A failure whose cause is "the runner was
   * busy" teaches nothing and trains people to re-run CI, which is worse than no test. */
  listProcesses?: () => Promise<ProcessInfo[]>;
  /** Injectable in place of the real `process.kill` - only `resumeSession`'s stale-orphan-before-
   * relaunch check (below) needs this. Defaults to the real kill; tests inject a fake to assert a
   * kill was requested without ever sending a real signal to a fixture's pid. */
  killProcess?: (pid: number) => void;
  /** Best-effort consume-and-delete for a topic's pending "🤔 Thinking..." placeholder (§5,
   * thinking-placeholder.ts), pre-built by the composition root the same way `confirmSessionCommand`
   * is - this module only knows a `ChatActionSource`, not the send/delete/governor plumbing needed
   * to act on one directly. §9, found live 2026-08-09 (the exact gap behind the original "resumed
   * session, couple-second silent gap before the next reply" report): a crash mid-turn leaves
   * whatever placeholder was covering that turn stuck in the map with nothing left to consume it -
   * `thinking-placeholder.ts`'s `start` no-ops while it's still "pending", so the *next* real inbound
   * message after a resume gets no visible indicator of its own at all, silent right up until a
   * reply finally lands and sweeps up the stale entry. Called once `handleUnexpectedExit` confirms a
   * real crash (not a deliberate `/kill`/`/rm`, which already goes through `stopIndicatorsForTopic`
   * instead - that one also edits the bubble to "Session ended.", wrong here since the session is
   * about to resume, not end). Optional so existing tests that never exercise this don't need to
   * supply one. */
  clearThinkingPlaceholder?: (topicId: number) => void;
  /** P0-5 (codebase-hardening-plan.md): the cross-restart counterpart to `clearThinkingPlaceholder`
   * above. That one only ever fires from `handleUnexpectedExit`, *inside the same process* the
   * placeholder was created in - it has no way to reach one left behind by a process that's since
   * exited entirely, which is exactly what happens when a second Bridge restart lands before a
   * resume nudge's own turn gets a chance to reply (found live 2026-08-12, `unify-work-with-voice-and`).
   * `runStartupReconciliation` calls this once per session whose persisted `thinkingPlaceholderMsg`
   * (thinking-placeholder.ts's `persist` hook) is non-null at boot - the in-memory promise that would
   * have resolved it is unrecoverable, but the message itself doesn't have to keep reading
   * "🤔 Thinking..." forever. Optional for the same reason `clearThinkingPlaceholder` is: existing
   * tests that never exercise this restart path don't need to supply one. */
  relabelStalePlaceholder?: (topicId: number, messageId: number) => void;
  /** Sends a nudge into a resumed session whose pending permission prompt was lost - see
   * resume-nudge-on-lost-permission-plan.md §1/§2. Same shape as `PtyIo['sendChannelText']`
   * deliberately (Interface Segregation: `resumeSession` needs exactly this one function, not the
   * whole `PtyIo` surface). `LateBound`, not a plain closure over `pty-io.ts`'s `ptyIo`: the
   * composition root constructs `session-supervisor.ts` *before* `pty-io.ts` (the latter needs this
   * module's `lastActivityAt`/`getPtyProcess` accessors), so a bare closure captured at this call
   * site would reference an unassigned `const`. `resumeSession` only calls `.get()` on this well
   * after the composition root's `.set()` (a real resume can't happen before startup finishes), so
   * the "read too early" guard is a safety net for a future refactor mistake, not a real runtime
   * path. Optional so existing tests that never exercise the `awaiting_input` resume branch don't
   * need to supply one. */
  sendResumeNudge?: LateBound<(slug: string, topicId: number, content: string) => void>;
}

export interface SessionSupervisor {
  isPidAlive(pid: number): boolean;
  reapRowsWithDeletedTopics(rows: readonly SessionRow[]): Promise<SessionRow[]>;
  reportOrphanProcesses(): Promise<void>;
  runStartupReconciliation(): Promise<void>;
  wireSession(slug: string, ptyProcess: pty.IPty, topicId: number, ready: Promise<{ resumeFailed: boolean }>): void;
  handleUnexpectedExit(slug: string, ptyProcess: pty.IPty, topicId: number, exitCode: number): Promise<void>;
  resumeSession(row: SessionRow, opts?: { manuallyRequested?: boolean; bootReconciliation?: boolean }): Promise<void>;
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
  const { sessionStore, routing, controlBot, confirmSessionCommand, supergroupChatId, selfCheckSlug, otlpPort, getReposRegistry } = opts;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date().toISOString());
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const usageWaiters = opts.usageWaiters ?? new Map<string, { buffer: string; check: () => void }>();
  const launchSession = opts.launchSession ?? realLaunchSession;
  const killProcess = opts.killProcess ?? ((pid: number) => process.kill(pid));
  const listProcesses = opts.listProcesses ?? listClaudeProcesses;
  const sendResumeNudge = opts.sendResumeNudge;

  const ptyProcessBySlug = new Map<string, pty.IPty>();
  /** Guards `handleUnexpectedExit`'s relaunch loop against a stale `session_id` causing an
   * immediate-refail, unbounded-relaunch flood (§4.5) - cleared once a real hook event proves the
   * session is actually alive again (`feed-wiring.ts`'s `handleHookEvent`, via `clearResumeAttempts`). */
  const resumeAttempts = new Map<string, number>();
  const lastPtyActivityBySlug = new Map<string, number>();

  /**
   * §4.5's boot-reconciliation race, found live 2026-08-11 ("remove-rm-alias", killed by its own
   * self-repo `/ship` restart mid-turn, never auto-resumed, no trace in the log of why): a session
   * whose `claude` process dies because the Bridge itself is dying (per this file's own
   * `isPidAlive` doc comment - a live session's process never survives that) queues its own
   * `SessionEnd` hook event, which can only reach the pipe once the successor process starts
   * listening. `runStartupReconciliation` used to take its "which rows are non-dead" snapshot with
   * a fresh `sessionStore.all()` read at the time it actually runs - by then the pipe server has
   * been accepting connections for a while (composition root: `startPipeServer` runs *after* this
   * factory), so a queued `SessionEnd` that flushed in the meantime had already marked the row
   * `dead`, indistinguishable from a deliberate `/rm`/`/kill`, and reconciliation silently skipped
   * it instead of resuming it.
   *
   * The fix is timing, not logic: this factory runs *before* `startPipeServer` (composition root's
   * own ordering), so a snapshot taken right here, synchronously, is provably immune - nothing has
   * had a chance yet to write to this row for reasons related to this restart. `runStartupReconciliation`
   * (a few dozen lines below) treats slug membership in this set, not a row's live `state` column,
   * as the source of truth for "does this need reconciling", and `resumeSession`'s own
   * `bootReconciliation` opt-out lets it act on that even if the row now shows `dead`.
   */
  const bootLiveSlugs = new Set(
    sessionStore
      .all()
      .filter((r) => r.slug !== selfCheckSlug && r.state !== "dead")
      .map((r) => r.slug),
  );

  /**
   * §4.5's reconciliation, wired for real: on this stack (measured 2026-08-03) a live session's
   * process never survives the Bridge dying, so `readopt` (row 1 - "process alive") is defensive
   * only, kept for the untested-in-practice recycled-pid case §4.5 calls out - it still relaunches
   * fresh rather than pretending an orphaned handle is usable. Every other non-`dead` row always
   * lands on `resume`. Scoped to every slug except the hardcoded self-check one, which the
   * composition root already launches fresh unconditionally rather than resuming.
   */
  const isPidAlive =
    opts.isPidAlive ??
    ((pid: number): boolean => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

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
    const processes = await listProcesses();
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
    // Slug membership in `bootLiveSlugs` (captured before `startPipeServer` could ever accept a
    // hook connection), not this row's live `state` column, decides who gets reconciled - see that
    // set's own doc comment for the boot-restart race this closes. Logged unconditionally,
    // including the zero case, so "nothing needed reconciling" and "this pass never ran" are no
    // longer indistinguishable from bridge.log alone (the exact ambiguity that slowed down
    // diagnosing the 2026-08-11 incident).
    const rows = sessionStore.all().filter((r) => bootLiveSlugs.has(r.slug));
    log("INFO", `startup reconciliation: ${rows.length} row(s) snapshotted live at boot (§4.5)`);
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
      if (row.state === "dead") {
        // The exact race `bootLiveSlugs` exists for: this row was live an instant ago (that's why
        // it's in `live` at all) but its own crashed process's queued `SessionEnd` has since landed
        // and flipped it to `dead`. `resumeSession`'s `bootReconciliation` opt-out is safe here
        // specifically because no operator command can possibly be in flight yet - the getUpdates
        // loop this process's own Telegram polling depends on doesn't start until after this whole
        // function returns (index.ts), so there is no legitimate concurrent `/kill` this could be
        // racing, unlike `resumeSession`'s other callers.
        log("WARN", `session "${row.slug}" is marked dead but was live when this boot started (§4.5) - resuming anyway rather than orphaning it`);
      }
      // P0-5 (codebase-hardening-plan.md): `row` here is from the same pre-`startPipeServer`
      // snapshot `bootLiveSlugs` itself relies on (see that set's own doc comment) - provably
      // untouched by anything this boot has done, so a non-null `thinkingPlaceholderMsg` can only be
      // a genuine leftover from the *previous* process, never a race with this one. Relabeled and
      // cleared *before* `resumeSession` below, which is about to create a brand-new placeholder of
      // its own via the resume nudge - closing out the stale one first keeps the two from being
      // confused with each other in the topic's scrollback.
      if (row.thinkingPlaceholderMsg != null) {
        opts.relabelStalePlaceholder?.(row.topicId, row.thinkingPlaceholderMsg);
        sessionStore.setThinkingPlaceholderMsg(row.slug, null);
      }
      log("INFO", `reconciling session "${row.slug}" after a Bridge restart`);
      await resumeSession(row, { bootReconciliation: true });
    }
  }

  /**
   * Queues text destined for a just-(re)launched session's PTY until `ready` resolves, instead of
   * handing it straight to the real (guarded) write function - see `wireSession`'s own doc comment
   * for the race this closes. Preserves call order (a FIFO queue, flushed in order once `ready`
   * settles) rather than dropping anything outright, so a message that arrives one tick into a
   * resume's startup window is delivered late instead of lost.
   *
   * If the session never actually starts (`resumeFailed` - `claude --resume` found no matching
   * conversation, and `resumeSession` is about to kill this PTY), the queue is dropped instead of
   * flushed into a process that's already being torn down; logged loudly (not merely the WARN
   * `sendChannelText` already logs for "no live session at all") since this is the one case where an
   * operator message was accepted, queued, and then silently thrown away rather than delivered.
   */
  function gateWriteUntilReady(
    rawWrite: (text: string) => void,
    ready: Promise<{ resumeFailed: boolean }>,
    slug: string,
    logFn: LogFn,
  ): (text: string) => void {
    let flush: ((text: string) => void) | null = null;
    let gaveUp = false;
    const queue: string[] = [];

    ready.then(({ resumeFailed }) => {
      if (resumeFailed) {
        gaveUp = true;
        if (queue.length > 0) {
          logFn("WARN", `session "${slug}" failed to resume - dropping ${queue.length} inbound write(s) queued during its startup`);
        }
        return;
      }
      flush = rawWrite;
      for (const text of queue) flush(text);
      queue.length = 0;
    });

    return (text: string) => {
      if (flush) {
        flush(text);
        return;
      }
      if (gaveUp) return;
      queue.push(text);
    };
  }

  /** Wires up a freshly-spawned (or resumed) session's PTY: the routing table's write/output-tail
   * plumbing, the `ptyProcessBySlug` liveness map, and this module's crash detector. Shared by
   * the self-check launch, `/new`, and every `resumeSession` relaunch so the three don't drift.
   *
   * `ready` gates the exposed write path, not just the routing wiring - found live 2026-08-09:
   * `resumeSession` used to call this (making the slug immediately writable/routable) and only
   * `await session.ready` afterward, so an inbound message dispatched via `command-dispatch.ts`'s
   * `sendChannelText` during a crash-resume's multi-second startup window could land mid-splash and
   * be silently corrupted or lost - the operator's question vanished with no reply and no error, and
   * the turn's own activity log showed nothing at all because Claude never received anything coherent
   * to act on. `/new`'s own initial-prompt write already has to wait on this exact `ready` signal for
   * the same reason (see `LaunchedSession.ready`'s doc comment); an *operator* message racing that
   * same window is the identical hazard one layer up, and every `wireSession` caller has a `ready`
   * promise in hand already, so gating it here closes the race for all of them at once rather than
   * relying on each caller to remember to check it itself. */
  function wireSession(slug: string, ptyProcess: pty.IPty, topicId: number, ready: Promise<{ resumeFailed: boolean }>): void {
    // See pty-write-guard.ts's own doc comment for why both the write try/catch and the `'error'`
    // listener are required - one alone left one stale keystroke (or, live 2026-08-06, `/new`'s very
    // first write into a session whose `waitForChannelConnected` wait had already given up) able to
    // crash the whole daemon and every other session with it.
    const guardedWrite = attachPtyWriteGuard(ptyProcess as unknown as PtyLike, slug, { log });
    routing.setPtyWrite(slug, gateWriteUntilReady(guardedWrite, ready, slug, log));
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
    // Whatever turn was in flight when the crash happened isn't coming back - see this option's own
    // doc comment for why leaving it pending here is what caused the original live-observed bug.
    opts.clearThinkingPlaceholder?.(topicId);
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
        `⚠️ Session "${slug}" exited immediately ${attempts} times in a row (last code ${exitCode}) - giving up on automatic resume. Worktree preserved at ${row.worktreePath}; /remove to clear it.`,
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
  /**
   * `claude --resume` failing (`RESUME_FAILURE_PATTERN`) doesn't throw or exit the process - it
   * silently falls through to a brand-new conversation in the same PTY - so `resumeSession` checks
   * `session.ready`'s own `resumeFailed` flag rather than assuming success: found live 2026-08-07, a
   * session whose crash-before-first-transcript-write left `row.sessionId` pointing at a
   * conversation Claude Code could never find again sat "resumed" in the topic forever with no
   * further reply, since the operator's original prompt was never resent into the fresh
   * conversation underneath. That fresh conversation has no relation to what was actually asked
   * for, and `dead` is `session-store.ts`'s own terminal state (no path back from it) - the row is
   * very likely already `dead` by now anyway, from the `SessionEnd` hook that fires for the
   * abandoned resume racing this very check (confirmed live 2026-08-07). Killing the pty here,
   * rather than leaving Claude Code's own fresh-start running, is what makes §4.3's "This session
   * has ended" reply true instead of a lie: an untracked live PTY behind a `dead` row would
   * otherwise burn a Claude Code seat and a worktree forever with no way for the operator to reach
   * or reclaim it. Same delete-then-kill ordering `killAndUntrack` uses, so the async `onExit` this
   * fires sees the map entry already gone and treats it as a deliberate kill, not a crash to
   * auto-resume.
   */
  function finishResumeFailure(row: SessionRow, session: LaunchedSession, sessionId: string): void {
    const { slug, topicId } = row;
    log("WARN", `session "${slug}"'s claude --resume ${sessionId} failed (no matching conversation) - it started a fresh conversation instead`);
    ptyProcessBySlug.delete(slug);
    session.ptyProcess.kill();
    routing.clearPtyWrite(slug);
    markDeadIfPresent(slug);
    confirmSessionCommand(
      topicId,
      `⚠️ Session "${slug}" couldn't resume its prior conversation (Claude reported no matching session) - this session has ended. Worktree preserved at ${row.worktreePath}; /new to start a fresh one.`,
    );
  }

  /**
   * resume-nudge-on-lost-permission-plan.md §2: a resumed Claude comes back idle rather than
   * retrying whatever it was doing when the crash/restart hit (confirmed live 2026-08-10 - a
   * pending `git commit` never happened after resume). Originally gated on `hadLostPrompt`
   * (`current.state === "awaiting_input"`) on the theory that a `working`-state resume "already has
   * Claude mid-reply" and continues on its own - **contradicted live 2026-08-11**: `/resume --all`
   * on two sessions that had been `working` (not `awaiting_input`) mid-crash produced the identical
   * silent-forever symptom the `awaiting_input` case was fixed for, with nothing else happening after
   * "Session ... resumed." That plan's own assumption doesn't hold on this stack: `claude --resume`
   * reloads a transcript into a *fresh* process, it does not resurrect an in-flight turn, so there is
   * no meaningful difference between "was waiting on a permission prompt" and "was mid-tool-call"
   * from the successor process's point of view - both come back cold, sitting idle, with nothing to
   * make them continue unless told to. Nudging unconditionally (not gated on the pre-crash state at
   * all) closes that gap for every resume path, not just the one state reconciliation happened to be
   * able to prove was broken first; the one-shot follow-up nudge below already tolerates a session
   * that continues correctly on its own (skips if it's no longer idle by then), so nudging a resume
   * that didn't actually need it costs at most one harmless extra check.
   *
   * Wording note (confirmed live 2026-08-10): a plain "please retry it" was NOT enough on its own -
   * a live trial sat idle for minutes with no retry, and only started checking git state and
   * re-attempting once explicitly asked "what were you in the middle of, check and retry." Folding
   * that same check-first instruction into the nudge itself (rather than relying on the operator to
   * send it by hand) is what makes this actually self-service.
   */
  function finishResumeSuccess(slug: string, topicId: number): void {
    confirmSessionCommand(topicId, `Session "${slug}" resumed.`);
    sendResumeNudge?.get()(
      slug,
      topicId,
      "A Bridge restart interrupted this session before its last action finished - a tool call, a reply, or something awaiting your approval - it never completed. Check what you were in the middle of (e.g. git status/log, or whatever else is relevant) and continue or retry it.",
    );
    // §7: the nudge above is confirmed live (three trials, 2026-08-10) to NOT reliably land as the
    // very first turn after a resume - the session's own turn completes in a handful of seconds and
    // settles back to `idle` with nothing retried, no matter how the first nudge is worded. What did
    // reliably work, in every trial: an *ordinary second* message reaching the session. This is that
    // second message, sent automatically instead of requiring the operator to notice the silence
    // and type it by hand - the one thing this plan's live investigation actually found working,
    // not a new guess.
    fireAndForget(sendFollowUpNudgeIfStillIdle(slug, topicId), log, `session-supervisor resume follow-up nudge(${slug})`);
  }

  async function resumeSession(
    row: SessionRow,
    opts: { manuallyRequested?: boolean; bootReconciliation?: boolean } = {},
  ): Promise<void> {
    const { slug, topicId } = row;
    const current = sessionStore.get(slug);
    if (!current) {
      log("INFO", `resumeSession("${slug}") skipped - its row no longer exists (removed, most likely by /rm, during the resume wait)`);
      return;
    }
    // This guard exists to catch a genuine race: `handleUnexpectedExit`'s backoff wait and
    // `runStartupReconciliation` both capture a row that was NOT dead, then do real async work
    // (a delay, a topic-deletion probe) before reaching here - if a manual /kill lands during that
    // window, `current` (re-read fresh, unlike the stale `row` param) reflects it and this backs off
    // instead of resurrecting something the operator just killed on purpose.
    //
    // `handleResumeCommand`'s manual `/resume <slug>` (§ its own doc comment) is different in kind,
    // not degree: it only ever calls this once `row.state === "dead"` has already been confirmed -
    // that's the *precondition* for calling it at all, not a race to detect. Without this
    // `manuallyRequested` opt-out, `current.state === "dead"` was true 100% of the time for that
    // caller, silently no-op'ing every manual `/resume` on a dead session (live-confirmed
    // 2026-08-11: `bridge.log` showed the skip line, no confirm message, `/ls` still `dead`).
    //
    // `runStartupReconciliation`'s `bootReconciliation` opt-out is the same bypass for a different
    // reason: it already vouched for this slug via `bootLiveSlugs`, snapshotted before this boot's
    // pipe server could accept the very `SessionEnd` that raced this row to `dead` (§4.5, found live
    // 2026-08-11 - see that set's own doc comment). Safe specifically because this call only ever
    // happens before this process's own `getUpdates` polling starts, so there is no legitimate
    // concurrent manual `/kill` it could be mistaking for that race, unlike the caller this guard
    // was built for.
    if (!opts.manuallyRequested && !opts.bootReconciliation && current.state === "dead") {
      log("INFO", `resumeSession("${slug}") skipped - it was already marked dead (most likely by /kill) during the resume wait`);
      return;
    }
    const hadLostPrompt = current.state === "awaiting_input";
    if (hadLostPrompt) {
      sessionStore.setState(slug, "working", now());
      confirmSessionCommand(topicId, "The pending question was lost - please re-ask.");
    }
    if (!current.sessionId) {
      markDeadIfPresent(slug);
      confirmSessionCommand(topicId, `Session "${slug}" could not be resumed (no session id was recorded yet). Worktree preserved at ${row.worktreePath}.`);
      return;
    }
    // Restores `/mode`/`/auto permission`/`/auto answer` from the persisted row *before* the
    // relaunch below - `routing.ts`'s maps are empty this early in a fresh Bridge process (a full
    // process restart, not this same `claude --resume`), so without this `routing.getMode(slug)` a
    // few lines down would silently read back `DEFAULT_MODE` ("manual") regardless of what `/mode`
    // had actually been set to before the crash (found live 2026-08-11, same audit that flagged
    // `/auto permission`'s restart gap). See `hydrateFromRow`'s own doc comment for why this isn't
    // `setMode`/`setBypass`/`setAutoAnswer`.
    routing.hydrateFromRow(slug, current);
    // Live-confirmed 2026-08-12: `ptyProcessBySlug` is this *process's own* view of what's
    // running, empty after any full Bridge restart - it has no memory of `current.ptyPid`'s
    // process even though that process itself is very likely still alive (this stack's `claude`
    // survives a Bridge restart just fine, only the Bridge's handle to it is lost). Resuming
    // without checking left that old process running untracked while a brand-new one was spawned
    // on top of the same worktree/`session_id` - three such orphans piled up in one afternoon
    // across repeated resume attempts, and every one of them died silently (no `SessionEnd`, no
    // exit log) once the Bridge finally restarted enough times to notice them. Unlike
    // `reportOrphanProcesses`'s deliberately-hands-off stance on *unrecognized* processes (killing
    // is the operator's call there), this pid is fully identified - it's precisely the process this
    // same relaunch is about to replace - so killing it first isn't a heuristic guess, it's the
    // other half of the resume this call already committed to doing.
    if (isPidAlive(current.ptyPid)) {
      log("WARN", `session "${slug}"'s previous process (pid ${current.ptyPid}) is still running - killing it before spawning its replacement`);
      try {
        killProcess(current.ptyPid);
      } catch (err) {
        log("WARN", `failed to kill session "${slug}"'s stale pid ${current.ptyPid}: ${(err as Error).message}`);
      }
    }
    try {
      const session = launchSession({
        slug,
        topicId,
        repoPath: current.repoPath,
        worktreesRoot: path.dirname(current.worktreePath),
        model: current.model,
        // A resumed PTY re-spawns `claude` from scratch (§4.5) - the `hydrateFromRow` call above is
        // what makes this the pre-crash mode rather than the CLI's own `manual` spawn default;
        // `routing.setMode` (a live `/mode` switch) mirrors right back into the same persisted column,
        // so this stays correct across any number of crash/restart cycles.
        permissionMode: routing.getMode(slug),
        resumeSessionId: current.sessionId,
        otlpPort,
        // Looked up by path, not by name - the row has no registry name. A resume that silently
        // dropped this would boot the session straight back into the consent dialog that
        // `project-mcp-policy.ts` exists to keep out of the way, on a repo the operator had already
        // opted in.
        projectMcp: getReposRegistry?.()?.getByPath(current.repoPath)?.projectMcp,
        log,
      });
      wireSession(slug, session.ptyProcess, topicId, session.ready);
      sessionStore.setPtyPid(slug, session.ptyProcess.pid ?? 0);
      // Without this, `routing.getByTopicId(topicId)` stays undefined for this session forever
      // after this restart (only the self-check slot and freshly-`/new`'d sessions ever call
      // `routing.add` otherwise) - every message in its topic then silently drops at the
      // `!isControl && !route` guard, with no error and no log line. Confirmed live 2026-08-04:
      // a resumed session answered /ls (control topic, doesn't need routing) but never replied to
      // anything sent in its own topic - not the command being wrong, the route being missing.
      routing.add({ slug, topicId, worktreePath: current.worktreePath });
      const { resumeFailed } = await session.ready;
      if (resumeFailed) {
        finishResumeFailure(row, session, current.sessionId);
      } else {
        finishResumeSuccess(slug, topicId);
      }
    } catch (err) {
      // P1-9, same gap as `handleNewCommand`'s launch failure and worse here: this branch marks the
      // row `dead`, which is irreversible, so the one chance to record *why* is now. `ensureWorktree`
      // runs on a resume too, meaning the `git worktree add` failure mode that motivated this can
      // kill an existing session, not just refuse a new one.
      const failure = describeExecFailure(err);
      log("ERROR", `resume failed for "${slug}" (repo ${current.repoPath}, worktree ${current.worktreePath}): ${formatExecFailureForLog(failure)}`);
      markDeadIfPresent(slug);
      confirmSessionCommand(
        topicId,
        `Failed to resume "${slug}": ${failure.message}${formatExitClause(failure)}. Worktree preserved at ${row.worktreePath}.`,
      );
    }
  }

  /**
   * resume-nudge-on-lost-permission-plan.md §7: fires exactly once, `RESUME_NUDGE_FOLLOWUP_DELAY_MS`
   * after the first resume nudge, only if the session settled at `idle` with nothing to show for
   * it - the exact failure mode confirmed live. Skips (no second nudge) for every other outcome:
   * - `awaiting_input` means the first nudge worked - a fresh permission card is already up.
   * - `working` means a turn is still genuinely in flight (its own or a real retry) - nudging into
   *   that would inject an unsolicited nested turn, same reasoning as `resumeSession` only ever
   *   nudging a row that actually lost a pending prompt in the first place (§2).
   * - `dead` or the row being gone entirely means `/kill`/`/rm` raced this wait - same defensive
   *   re-read `resumeSession` itself already relies on, for the same reason.
   * Not a loop: one follow-up only. Every live trial that got a reply needed exactly one second
   * message, never more - looping further has no evidence behind it and risks nagging a session
   * that's genuinely just idle for an unrelated reason.
   */
  async function sendFollowUpNudgeIfStillIdle(slug: string, topicId: number): Promise<void> {
    await delay(RESUME_NUDGE_FOLLOWUP_DELAY_MS);
    const current = sessionStore.get(slug);
    if (!current || current.state !== "idle") return;
    sendResumeNudge?.get()(
      slug,
      topicId,
      "Nothing happened after my last message - you're still idle. Please actually run the check now (e.g. git status/log) and complete whatever action was interrupted by the restart, or reply explaining why you can't.",
    );
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
