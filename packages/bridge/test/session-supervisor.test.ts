import { describe, expect, test } from "bun:test";
import { createSessionSupervisor, MAX_CONSECUTIVE_RESUME_ATTEMPTS, RESUME_BACKOFF_MS, RESUME_NUDGE_FOLLOWUP_DELAY_MS } from "../src/session-supervisor.ts";
import { LateBound } from "../src/late-bound.ts";
import { Routing } from "../src/routing.ts";
import { SessionStore, type SessionRow } from "../src/session-store.ts";
import type { LaunchedSession } from "../src/session-launcher.ts";

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "fix-bug",
    topicId: 2,
    sessionId: "sess-1",
    worktreePath: "c:\\data\\worktrees\\fix-bug",
    branch: "claude/fix-bug-1",
    repoPath: "c:\\data\\projects\\seowrite",
    model: "sonnet",
    // 0, not some arbitrary nonzero fixture number - `resumeSession`'s stale-orphan-kill check
    // (below) probes this pid for real via the default `isPidAlive`, and `isPidAlive(0)` is the
    // one input guaranteed to short-circuit to `false` without an actual syscall (its own `if
    // (!pid) return false` guard) - anything else risks signalling a real, unrelated OS process
    // that happens to reuse whatever number a fixture picked. Tests exercising the kill-check
    // itself override this explicitly alongside an injected `isPidAlive`/`killProcess`.
    ptyPid: 0,
    state: "working",
    turnCardMsg: null,
    thinkingPlaceholderMsg: null,
    paused: false,
    renamed: false,
    feedDetail: "compact",
    feedVerbose: false,
    bypassPermission: false,
    autoAnswer: false,
    mode: "manual",
    createdUtc: "2026-08-03T00:00:00.000Z",
    lastEventUtc: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

/** A minimal fake IPty - only the members `wireSession`/`handleUnexpectedExit` actually touch. */
function fakePty() {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  let killed = false;
  return {
    pid: 4242,
    onData: (fn: (data: string) => void) => {
      dataListeners.push(fn);
      return { dispose() {} };
    },
    onExit: (fn: (e: { exitCode: number; signal?: number }) => void) => {
      exitListeners.push(fn);
      return { dispose() {} };
    },
    kill: () => {
      killed = true;
    },
    write: () => {},
    resize: () => {},
    clear: () => {},
    // `attachPtyWriteGuard` (wireSession) needs both of these - `.on("error", ...)` is the
    // "second listener" node-pty's own IPty doesn't expose publicly (see pty-write-guard.ts's own
    // doc comment); a plain no-op is enough since these tests never exercise a write-guard failure.
    on: () => {},
    // Test-only helpers, not part of the real IPty surface.
    emitData: (data: string) => dataListeners.forEach((fn) => fn(data)),
    emitExit: (exitCode: number) => exitListeners.forEach((fn) => fn({ exitCode })),
    wasKilled: () => killed,
  };
}

function fakeControlBot() {
  return { sendChatAction: async () => {} };
}

/** Records every `confirmSessionCommand` call instead of sending anything - just what these tests
 * need to assert on. */
function fakeConfirm() {
  const calls: Array<{ topicId: number | undefined; text: string }> = [];
  return {
    fn: (topicId: number | undefined, text: string) => {
      calls.push({ topicId, text });
    },
    calls,
  };
}

/** A pre-set `LateBound` recording every `sendResumeNudge` call - resume-nudge-on-lost-permission-
 * plan.md §1/§2. Set up front (unlike the real composition root's post-`createPtyIo` `.set()`)
 * since these tests never exercise the construction-order gap `LateBound` itself guards against. */
function fakeResumeNudge() {
  const calls: Array<{ slug: string; topicId: number; content: string }> = [];
  const late = new LateBound<(slug: string, topicId: number, content: string) => void>();
  late.set((slug, topicId, content) => {
    calls.push({ slug, topicId, content });
  });
  return { late, calls };
}

describe("createSessionSupervisor", () => {
  test("wireSession tracks the pty and getPtyProcess/lastActivityAt reflect it", () => {
    const sessionStore = new SessionStore(":memory:");
    const routing = new Routing();
    const confirm = fakeConfirm();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
    });

    const pty = fakePty();
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));

    expect(supervisor.getPtyProcess("fix-bug")).toBe(pty as unknown as Parameters<typeof supervisor.wireSession>[1]);
    expect(supervisor.lastActivityAt("fix-bug")).toBeUndefined();

    pty.emitData("some real output");
    expect(supervisor.lastActivityAt("fix-bug")).toBeGreaterThan(0);
  });

  test("killAndUntrack kills the tracked pty and untracks it", () => {
    const sessionStore = new SessionStore(":memory:");
    const routing = new Routing();
    const confirm = fakeConfirm();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
    });

    const pty = fakePty();
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    supervisor.killAndUntrack("fix-bug");

    expect(pty.wasKilled()).toBe(true);
    expect(supervisor.getPtyProcess("fix-bug")).toBeUndefined();
  });

  test("killAndUntrack untracks before killing, so a pty whose kill() re-enters synchronously sees the entry already gone (deliberate-kill discrimination)", () => {
    const sessionStore = new SessionStore(":memory:");
    const routing = new Routing();
    const confirm = fakeConfirm();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
    });

    const pty = fakePty();
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    let sawTrackedDuringKill: unknown;
    const originalKill = pty.kill;
    pty.kill = () => {
      // Simulate a pty implementation whose kill() fires its own exit handler synchronously
      // (unlike node-pty's real, asynchronous onExit) - `handleUnexpectedExit`'s own discrimination
      // depends on `ptyProcessBySlug` already reflecting the untrack by this point.
      sawTrackedDuringKill = supervisor.getPtyProcess("fix-bug");
      originalKill();
    };

    supervisor.killAndUntrack("fix-bug");

    expect(sawTrackedDuringKill).toBeUndefined();
    expect(pty.wasKilled()).toBe(true);
  });

  test("untrack removes the entry without killing the pty", () => {
    const sessionStore = new SessionStore(":memory:");
    const routing = new Routing();
    const confirm = fakeConfirm();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
    });

    const pty = fakePty();
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    supervisor.untrack("fix-bug");

    expect(pty.wasKilled()).toBe(false);
    expect(supervisor.getPtyProcess("fix-bug")).toBeUndefined();
  });

  test("untrack also clears lastActivityAt, so a slug reused later doesn't inherit stale activity from a previous session (§9, found live 2026-08-09)", () => {
    const sessionStore = new SessionStore(":memory:");
    const routing = new Routing();
    const confirm = fakeConfirm();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
    });

    const pty = fakePty();
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    pty.emitData("some real output");
    expect(supervisor.lastActivityAt("fix-bug")).toBeGreaterThan(0);

    supervisor.untrack("fix-bug");

    expect(supervisor.lastActivityAt("fix-bug")).toBeUndefined();
  });

  test("untrack (and killAndUntrack, via the same helper) also clears resumeAttempts, so a slug reused by a later /new starts its own crash-backoff ladder from RESUME_BACKOFF_MS[0] rather than inheriting a stale count (§9, found live 2026-08-09)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row());
    const routing = new Routing();
    const confirm = fakeConfirm();
    const delays: number[] = [];
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      delay: async (ms) => {
        delays.push(ms);
      },
      launchSession: () => {
        const nextPty = fakePty();
        supervisor.wireSession("fix-bug", nextPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
        return {
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: nextPty as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        };
      },
    });

    const firstPty = fakePty();
    supervisor.wireSession("fix-bug", firstPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    firstPty.emitExit(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // The backoff delay, then (since the resume succeeded) finishResumeSuccess's own unconditional
    // follow-up-nudge delay - see that function's doc comment for why it no longer only fires for
    // an awaiting_input row.
    expect(delays).toEqual([RESUME_BACKOFF_MS[0], RESUME_NUDGE_FOLLOWUP_DELAY_MS]);

    // Simulate /kill (or /rm) tearing the slug down entirely - a later /new reusing this exact slug
    // (slug.ts derives slugs from a prompt's own first words, so a repeat is entirely possible) must
    // not inherit the crash-attempt count a wholly unrelated earlier session built up.
    supervisor.untrack("fix-bug");

    delays.length = 0;
    const freshPty = fakePty();
    supervisor.wireSession("fix-bug", freshPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    freshPty.emitExit(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(delays).toEqual([RESUME_BACKOFF_MS[0], RESUME_NUDGE_FOLLOWUP_DELAY_MS]);
  });

  test("handleUnexpectedExit is a no-op when ptyProcessBySlug no longer points at this pty (a deliberate /kill raced the exit event)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row());
    const routing = new Routing();
    const confirm = fakeConfirm();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      delay: async () => {},
    });

    const pty = fakePty();
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    // Simulate a deliberate /kill: untrack before the exit event fires.
    supervisor.untrack("fix-bug");
    pty.emitExit(0);
    await Promise.resolve();

    // No resume attempted, no confirmation posted - a deliberate kill is silent here (the /kill
    // command itself posts its own confirmation, not this path).
    expect(confirm.calls.length).toBe(0);
  });

  test("handleUnexpectedExit resumes automatically on a genuine crash, using the injected delay/launchSession", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row());
    const routing = new Routing();
    const confirm = fakeConfirm();
    const delays: number[] = [];
    let launchCount = 0;
    const resumedPty = fakePty();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      delay: async (ms) => {
        delays.push(ms);
      },
      launchSession: () => {
        launchCount += 1;
        return {
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        };
      },
    });

    const pty = fakePty();
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    pty.emitExit(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(delays).toEqual([RESUME_BACKOFF_MS[0], RESUME_NUDGE_FOLLOWUP_DELAY_MS]);
    expect(launchCount).toBe(1);
    expect(sessionStore.get("fix-bug")?.state).not.toBe("dead");
    expect(confirm.calls.some((c) => c.text.includes("resumed"))).toBe(true);
  });

  test("handleUnexpectedExit clears the topic's pending thinking placeholder before attempting to resume", async () => {
    // 2026-08-09, live-observed as a "resumed session, next message gets no visible indicator at
    // all" report: whatever turn was in flight when the crash happened isn't coming back, but
    // without this call `thinking-placeholder.ts`'s `start` would keep no-op'ing against the stale
    // entry for every message sent after the resume, right up until some later reply happened to
    // consume it - the exact same "disappears several messages late" shape as the pipe-server bug.
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row());
    const routing = new Routing();
    const confirm = fakeConfirm();
    const cleared: number[] = [];
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      delay: async () => {},
      launchSession: () => ({
        worktreePath: "c:\\data\\worktrees\\fix-bug",
        branch: "claude/fix-bug-1",
        ptyProcess: fakePty() as unknown as LaunchedSession["ptyProcess"],
        ready: Promise.resolve({ resumeFailed: false }),
      }),
      clearThinkingPlaceholder: (topicId) => {
        cleared.push(topicId);
      },
    });

    const pty = fakePty();
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    pty.emitExit(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(cleared).toEqual([2]);
  });

  test("handleUnexpectedExit is a no-op for `clearThinkingPlaceholder` when the exit was a deliberate /kill (no option supplied, or row already gone)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row());
    const routing = new Routing();
    const confirm = fakeConfirm();
    const cleared: number[] = [];
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      clearThinkingPlaceholder: (topicId) => {
        cleared.push(topicId);
      },
    });

    const pty = fakePty();
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    supervisor.killAndUntrack("fix-bug"); // a deliberate kill - untracks before the exit event fires
    pty.emitExit(0);
    await Promise.resolve();

    expect(cleared).toEqual([]); // handleUnexpectedExit's own ptyProcessBySlug guard returns first
  });

  test("handleUnexpectedExit marks the row dead after MAX_CONSECUTIVE_RESUME_ATTEMPTS immediate re-exits, without resuming again", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row());
    const routing = new Routing();
    const confirm = fakeConfirm();
    let launchCount = 0;
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      delay: async () => {},
      launchSession: () => {
        launchCount += 1;
        const nextPty = fakePty();
        // Every relaunch immediately exits again - the crash-loop case this backoff exists for.
        queueMicrotask(() => nextPty.emitExit(1));
        supervisor.wireSession("fix-bug", nextPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
        return {
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: nextPty as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        };
      },
    });

    const firstPty = fakePty();
    supervisor.wireSession("fix-bug", firstPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    firstPty.emitExit(1);

    // Flush enough microtask turns for MAX_CONSECUTIVE_RESUME_ATTEMPTS relaunches to cascade.
    for (let i = 0; i < MAX_CONSECUTIVE_RESUME_ATTEMPTS + 3; i++) {
      await Promise.resolve();
    }

    expect(launchCount).toBe(MAX_CONSECUTIVE_RESUME_ATTEMPTS);
    expect(sessionStore.get("fix-bug")?.state).toBe("dead");
    expect(confirm.calls.some((c) => c.text.includes("giving up on automatic resume"))).toBe(true);
  });

  test("resumeSession's resumeFailed branch kills the fresh pty, marks the row dead, and does not silently swallow the failure", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "idle" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const resumedPty = fakePty();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      launchSession: () => ({
        worktreePath: "c:\\data\\worktrees\\fix-bug",
        branch: "claude/fix-bug-1",
        ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
        ready: Promise.resolve({ resumeFailed: true }),
      }),
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);

    expect(resumedPty.wasKilled()).toBe(true);
    expect(sessionStore.get("fix-bug")?.state).toBe("dead");
    expect(confirm.calls.some((c) => c.text.includes("couldn't resume its prior conversation"))).toBe(true);
  });

  // bypass-and-autoanswer-plan.md v0.24.0: found by the same restart audit as `/auto permission`'s
  // own gap - `permissionMode` is a real relaunch flag, not a display value, so `resumeSession` must
  // hydrate `routing.ts`'s `modeBySlug` from the persisted row *before* calling `launchSession`,
  // not after. A fresh `Routing()` here has no `/mode` history at all (this is what a real Bridge
  // restart looks like), so this only passes if `resumeSession` reads the row's `mode` column
  // itself rather than trusting `routing.getMode` to already know it.
  test("resumeSession relaunches with the persisted mode, not DEFAULT_MODE, even though routing.ts's own map starts empty (the restart case)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "idle", mode: "acceptEdits" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    let capturedPermissionMode: string | undefined;
    const resumedPty = fakePty();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      launchSession: (opts) => {
        capturedPermissionMode = opts.permissionMode;
        return {
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        };
      },
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);

    expect(capturedPermissionMode).toBe("acceptEdits");
    expect(routing.getMode("fix-bug")).toBe("acceptEdits");
  });

  // resume-nudge-on-lost-permission-plan.md §2/Testing: resumeSession sends a nudge into a
  // successfully-resumed session, but only when its pending permission prompt was actually lost -
  // this is the first real coverage of that branch (previously only reconciliation.ts's now-deleted
  // `lost_prompt` action stood in for it, and nothing ever consumed that).
  test("resumeSession nudges a resumed session whose pending permission prompt was lost", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "awaiting_input" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const nudge = fakeResumeNudge();
    const resumedPty = fakePty();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      sendResumeNudge: nudge.late,
      launchSession: () => ({
        worktreePath: "c:\\data\\worktrees\\fix-bug",
        branch: "claude/fix-bug-1",
        ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
        ready: Promise.resolve({ resumeFailed: false }),
      }),
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);

    expect(nudge.calls).toEqual([{ slug: "fix-bug", topicId: 2, content: expect.stringContaining("Check what you were in the middle of") }]);
    expect(confirm.calls.some((c) => c.text.includes("pending question was lost"))).toBe(true);
    expect(confirm.calls.some((c) => c.text === 'Session "fix-bug" resumed.')).toBe(true);
  });

  // resume-nudge-on-lost-permission-plan.md §7: three live trials (2026-08-10) confirmed the
  // single nudge above does not reliably land as the very first turn after a resume - the session
  // settles back to `idle` with nothing retried. This follow-up nudge is the one thing that
  // reliably worked in every trial (an ordinary second message), sent automatically after
  // RESUME_NUDGE_FOLLOWUP_DELAY_MS instead of requiring the operator to notice and type it.
  test("resumeSession sends a second follow-up nudge if the session is still idle after the first one - the one thing that reliably worked live", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "awaiting_input" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const nudge = fakeResumeNudge();
    const resumedPty = fakePty();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      sendResumeNudge: nudge.late,
      // Simulates the confirmed-live failure mode: the nudged turn completes and the Stop hook
      // (session-state-transitions.ts) settles the row back to idle, with nothing else changed.
      delay: async () => {
        sessionStore.setState("fix-bug", "idle", "2026-08-10T00:00:00.000Z");
      },
      launchSession: () => ({
        worktreePath: "c:\\data\\worktrees\\fix-bug",
        branch: "claude/fix-bug-1",
        ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
        ready: Promise.resolve({ resumeFailed: false }),
      }),
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);
    // Flushes the fire-and-forgotten follow-up's `await delay(...)` continuation (same idiom used
    // elsewhere in this file for handleUnexpectedExit's own fire-and-forget resume).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(nudge.calls.length).toBe(2);
    expect(nudge.calls[1]).toEqual({ slug: "fix-bug", topicId: 2, content: expect.stringContaining("Nothing happened after my last message") });
  });

  test("resumeSession does NOT send a follow-up nudge if the first one worked - a fresh permission ask is already up (awaiting_input)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "awaiting_input" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const nudge = fakeResumeNudge();
    const resumedPty = fakePty();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      sendResumeNudge: nudge.late,
      delay: async () => {
        sessionStore.setState("fix-bug", "awaiting_input", "2026-08-10T00:00:00.000Z");
      },
      launchSession: () => ({
        worktreePath: "c:\\data\\worktrees\\fix-bug",
        branch: "claude/fix-bug-1",
        ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
        ready: Promise.resolve({ resumeFailed: false }),
      }),
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(nudge.calls.length).toBe(1);
  });

  test("resumeSession does NOT send a follow-up nudge if a turn is still genuinely in flight (state stayed working)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "awaiting_input" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const nudge = fakeResumeNudge();
    const resumedPty = fakePty();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      sendResumeNudge: nudge.late,
      // No-op delay - the row stays "working" (this module's own awaiting_input -> working flip),
      // i.e. still mid-turn at the deadline.
      delay: async () => {},
      launchSession: () => ({
        worktreePath: "c:\\data\\worktrees\\fix-bug",
        branch: "claude/fix-bug-1",
        ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
        ready: Promise.resolve({ resumeFailed: false }),
      }),
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(nudge.calls.length).toBe(1);
  });

  test("resumeSession does NOT send a follow-up nudge if the row was removed or killed during the follow-up wait", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "awaiting_input" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const nudge = fakeResumeNudge();
    const resumedPty = fakePty();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      sendResumeNudge: nudge.late,
      delay: async () => {
        sessionStore.remove("fix-bug");
      },
      launchSession: () => ({
        worktreePath: "c:\\data\\worktrees\\fix-bug",
        branch: "claude/fix-bug-1",
        ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
        ready: Promise.resolve({ resumeFailed: false }),
      }),
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(nudge.calls.length).toBe(1);
  });

  // Reversed 2026-08-11 (was "does not nudge a normal (non-awaiting_input) resume"): live-confirmed
  // via /resume --all that a `working`-state resume does NOT continue on its own either - two
  // sessions that had been `working` (not `awaiting_input`) at crash time sat silently idle after
  // "Session ... resumed." with no nudge, since the old gate only fired for `awaiting_input`. See
  // `finishResumeSuccess`'s own doc comment for why that plan-era assumption doesn't hold on this
  // stack: `claude --resume` always comes back to a cold, idle process regardless of what state the
  // row was in before it died.
  test("resumeSession nudges a working-state resume too - claude --resume comes back cold either way, not mid-reply", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "working" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const nudge = fakeResumeNudge();
    const resumedPty = fakePty();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      sendResumeNudge: nudge.late,
      launchSession: () => ({
        worktreePath: "c:\\data\\worktrees\\fix-bug",
        branch: "claude/fix-bug-1",
        ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
        ready: Promise.resolve({ resumeFailed: false }),
      }),
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);

    expect(nudge.calls).toEqual([{ slug: "fix-bug", topicId: 2, content: expect.stringContaining("Check what you were in the middle of") }]);
    expect(confirm.calls.some((c) => c.text.includes("pending question was lost"))).toBe(false);
    expect(confirm.calls.some((c) => c.text === 'Session "fix-bug" resumed.')).toBe(true);
  });

  test("resumeSession does not nudge when claude --resume itself failed - there's no live conversation to retry into", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "awaiting_input" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const nudge = fakeResumeNudge();
    const resumedPty = fakePty();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      sendResumeNudge: nudge.late,
      launchSession: () => ({
        worktreePath: "c:\\data\\worktrees\\fix-bug",
        branch: "claude/fix-bug-1",
        ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
        ready: Promise.resolve({ resumeFailed: true }),
      }),
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);

    expect(nudge.calls).toEqual([]);
  });

  test("resumeSession does not nudge when there's no sessionId to resume from - no launch is even attempted", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "awaiting_input", sessionId: null }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const nudge = fakeResumeNudge();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      sendResumeNudge: nudge.late,
      launchSession: () => {
        throw new Error("should not be called");
      },
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);

    expect(nudge.calls).toEqual([]);
  });

  test("resumeSession does not nudge when launchSession itself throws", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "awaiting_input" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const nudge = fakeResumeNudge();
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      sendResumeNudge: nudge.late,
      launchSession: () => {
        throw new Error("launch exploded");
      },
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);

    expect(nudge.calls).toEqual([]);
    expect(sessionStore.get("fix-bug")?.state).toBe("dead");
  });

  test("resumeSession with no recorded sessionId marks the row dead and reports it, rather than attempting a launch", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ sessionId: null }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    let launchCount = 0;
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      launchSession: () => {
        launchCount += 1;
        throw new Error("should not be called");
      },
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);

    expect(launchCount).toBe(0);
    expect(sessionStore.get("fix-bug")?.state).toBe("dead");
    expect(confirm.calls.some((c) => c.text.includes("could not be resumed"))).toBe(true);
  });

  test("resumeSession is a no-op (no throw, no relaunch) when the row was removed during the resume wait (/rm raced a pending resume)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row());
    const routing = new Routing();
    const confirm = fakeConfirm();
    let launchCount = 0;
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      launchSession: () => {
        launchCount += 1;
        throw new Error("should not be called - the row is already gone");
      },
    });

    const snapshot = sessionStore.get("fix-bug")!;
    // Simulate /rm having removed the row while this snapshot (handleUnexpectedExit's own,
    // captured before its backoff `delay`) was still in flight.
    sessionStore.remove("fix-bug");

    await supervisor.resumeSession(snapshot);

    expect(launchCount).toBe(0);
    // Silent: /rm already posted its own confirmation, this must not post a second, confusing one.
    expect(confirm.calls.length).toBe(0);
  });

  test("resumeSession is a no-op when the row was already marked dead during the resume wait (/kill raced a pending resume)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row());
    const routing = new Routing();
    const confirm = fakeConfirm();
    let launchCount = 0;
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      launchSession: () => {
        launchCount += 1;
        throw new Error("should not be called - the session was already killed");
      },
    });

    const snapshot = sessionStore.get("fix-bug")!;
    // Simulate /kill having marked the row dead while this snapshot was still in flight.
    sessionStore.setState("fix-bug", "dead", "2026-08-09T00:00:00.000Z");

    await supervisor.resumeSession(snapshot);

    expect(launchCount).toBe(0);
    expect(confirm.calls.length).toBe(0);
    expect(sessionStore.get("fix-bug")?.state).toBe("dead");
  });

  // Bug fix (live-confirmed 2026-08-11): the two tests above cover the *race* this dead-guard is
  // actually for (a stale snapshot captured before an async wait, raced by a real /kill). Manual
  // `/resume <slug>` is a different caller shape entirely - `row.state === "dead"` is already true,
  // by construction, every single time it calls this (that's the whole point of /resume) - so
  // without `manuallyRequested: true` opting out of the exact same guard, every manual resume of a
  // dead session silently no-op'd: no relaunch, no confirm message, state stuck at `dead` forever.
  test("resumeSession relaunches a dead row when manuallyRequested is true - the actual /resume path", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "dead" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const resumedPty = fakePty();
    let launchCount = 0;
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      launchSession: () => {
        launchCount += 1;
        return {
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        };
      },
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!, { manuallyRequested: true });

    expect(launchCount).toBe(1);
    expect(confirm.calls.some((c) => c.text.includes('Session "fix-bug" resumed.'))).toBe(true);
  });

  // Live-confirmed 2026-08-12: `ptyProcessBySlug` is this process's own in-memory view, empty
  // after any Bridge restart - it has no record of a still-running previous process for this slug,
  // so a resume that doesn't check the OS directly spawns a second `claude` on top of the first.
  // Three such orphans piled up in one afternoon of repeated resume attempts, each dying silently
  // later with no trace in the log. `resumeSession` now probes the row's own last-known `ptyPid`
  // and kills it first when it's still alive.
  test("resumeSession kills a still-alive previous process for this slug before spawning its replacement", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "dead", ptyPid: 9999 }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const resumedPty = fakePty();
    const killed: number[] = [];
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      isPidAlive: (pid) => pid === 9999,
      killProcess: (pid) => {
        killed.push(pid);
      },
      launchSession: () => ({
        worktreePath: "c:\\data\\worktrees\\fix-bug",
        branch: "claude/fix-bug-1",
        ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
        ready: Promise.resolve({ resumeFailed: false }),
      }),
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!, { manuallyRequested: true });

    expect(killed).toEqual([9999]);
  });

  test("resumeSession does not attempt a kill when the row's previous pid is no longer alive (the ordinary case)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "dead", ptyPid: 9999 }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const resumedPty = fakePty();
    const killed: number[] = [];
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      isPidAlive: () => false,
      killProcess: (pid) => {
        killed.push(pid);
      },
      launchSession: () => ({
        worktreePath: "c:\\data\\worktrees\\fix-bug",
        branch: "claude/fix-bug-1",
        ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
        ready: Promise.resolve({ resumeFailed: false }),
      }),
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!, { manuallyRequested: true });

    expect(killed).toEqual([]);
  });

  test("resumeSession still relaunches even if killing the stale previous process throws (e.g. it exited in the gap between the probe and the kill)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "dead", ptyPid: 9999 }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    const resumedPty = fakePty();
    let launchCount = 0;
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      isPidAlive: () => true,
      killProcess: () => {
        throw new Error("ESRCH: no such process");
      },
      launchSession: () => {
        launchCount += 1;
        return {
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: resumedPty as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        };
      },
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!, { manuallyRequested: true });

    expect(launchCount).toBe(1);
    expect(confirm.calls.some((c) => c.text.includes('Session "fix-bug" resumed.'))).toBe(true);
  });

  test("resumeSession without manuallyRequested still no-ops on an already-dead row (default stays the race guard)", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row({ state: "dead" }));
    const routing = new Routing();
    const confirm = fakeConfirm();
    let launchCount = 0;
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      launchSession: () => {
        launchCount += 1;
        throw new Error("should not be called - manuallyRequested was not passed");
      },
    });

    await supervisor.resumeSession(sessionStore.get("fix-bug")!);

    expect(launchCount).toBe(0);
    expect(confirm.calls.length).toBe(0);
  });

  test("handleUnexpectedExit's pending resume does not relaunch a session removed by /rm during the backoff wait", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row());
    const routing = new Routing();
    const confirm = fakeConfirm();
    let launchCount = 0;
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      // Simulate /rm firing during the backoff wait itself, before resumeSession ever runs.
      delay: async () => {
        sessionStore.remove("fix-bug");
      },
      launchSession: () => {
        launchCount += 1;
        throw new Error("should not be called");
      },
    });

    const pty = fakePty();
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    pty.emitExit(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(launchCount).toBe(0);
    expect(sessionStore.get("fix-bug")).toBeUndefined();
  });

  test("clearResumeAttempts resets the counter, so a later crash starts the backoff ladder over from RESUME_BACKOFF_MS[0]", async () => {
    const sessionStore = new SessionStore(":memory:");
    sessionStore.insert(row());
    const routing = new Routing();
    const confirm = fakeConfirm();
    const delays: number[] = [];
    const supervisor = createSessionSupervisor({
      sessionStore,
      routing,
      controlBot: fakeControlBot(),
      confirmSessionCommand: confirm.fn,
      supergroupChatId: "-100",
      selfCheckSlug: "selfcheck",
      delay: async (ms) => {
        delays.push(ms);
      },
      launchSession: () => {
        const nextPty = fakePty();
        supervisor.wireSession("fix-bug", nextPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
        return {
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: nextPty as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        };
      },
    });

    const firstPty = fakePty();
    supervisor.wireSession("fix-bug", firstPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2, Promise.resolve({ resumeFailed: false }));
    firstPty.emitExit(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // A real hook event proves the resumed session is alive - clears the counter.
    supervisor.clearResumeAttempts("fix-bug");

    delays.length = 0;
    const secondPty = supervisor.getPtyProcess("fix-bug")!;
    (secondPty as unknown as ReturnType<typeof fakePty>).emitExit(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Started over at attempt 1's delay, not attempt 2's - proof the counter was actually reset.
    expect(delays).toEqual([RESUME_BACKOFF_MS[0], RESUME_NUDGE_FOLLOWUP_DELAY_MS]);
  });

  // P0-5 (codebase-hardening-plan.md, missing-test item 5b): `runStartupReconciliation`'s own
  // `relabelStalePlaceholder` call - the cross-restart counterpart to `clearThinkingPlaceholder`,
  // which only ever fires for a same-process crash. Live-confirmed 2026-08-12
  // ("unify-work-with-voice-and"): a second Bridge restart before a resume nudge's own turn replies
  // otherwise leaves "🤔 Thinking..." stuck in Telegram forever.
  describe("runStartupReconciliation relabels a leftover thinking placeholder (P0-5)", () => {
    test("a row with a non-null thinkingPlaceholderMsg gets it relabeled and cleared before resuming", async () => {
      const sessionStore = new SessionStore(":memory:");
      sessionStore.insert(row({ thinkingPlaceholderMsg: 3008 }));
      const routing = new Routing();
      const confirm = fakeConfirm();
      const relabeled: Array<{ topicId: number; messageId: number }> = [];
      const supervisor = createSessionSupervisor({
        sessionStore,
        routing,
        controlBot: fakeControlBot(),
        confirmSessionCommand: confirm.fn,
        supergroupChatId: "-100",
        selfCheckSlug: "selfcheck",
        relabelStalePlaceholder: (topicId, messageId) => {
          relabeled.push({ topicId, messageId });
        },
        launchSession: () => ({
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: fakePty() as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        }),
      });

      await supervisor.runStartupReconciliation();

      expect(relabeled).toEqual([{ topicId: 2, messageId: 3008 }]);
      // Cleared, not left behind - a *later* restart's reconciliation must not relabel the same
      // leftover a second time against whatever new placeholder the resume nudge just created.
      expect(sessionStore.get("fix-bug")?.thinkingPlaceholderMsg).toBeNull();
    });

    test("a row with no outstanding placeholder never calls relabelStalePlaceholder", async () => {
      const sessionStore = new SessionStore(":memory:");
      sessionStore.insert(row({ thinkingPlaceholderMsg: null }));
      const routing = new Routing();
      const confirm = fakeConfirm();
      let relabelCalls = 0;
      const supervisor = createSessionSupervisor({
        sessionStore,
        routing,
        controlBot: fakeControlBot(),
        confirmSessionCommand: confirm.fn,
        supergroupChatId: "-100",
        selfCheckSlug: "selfcheck",
        relabelStalePlaceholder: () => {
          relabelCalls += 1;
        },
        launchSession: () => ({
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: fakePty() as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        }),
      });

      await supervisor.runStartupReconciliation();

      expect(relabelCalls).toBe(0);
    });

    test("omitting relabelStalePlaceholder entirely still reconciles cleanly (optional, like clearThinkingPlaceholder)", async () => {
      const sessionStore = new SessionStore(":memory:");
      sessionStore.insert(row({ thinkingPlaceholderMsg: 3008 }));
      const routing = new Routing();
      const confirm = fakeConfirm();
      const supervisor = createSessionSupervisor({
        sessionStore,
        routing,
        controlBot: fakeControlBot(),
        confirmSessionCommand: confirm.fn,
        supergroupChatId: "-100",
        selfCheckSlug: "selfcheck",
        launchSession: () => ({
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: fakePty() as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        }),
      });

      await supervisor.runStartupReconciliation();

      expect(confirm.calls.some((c) => c.text.includes('Session "fix-bug" resumed.'))).toBe(true);
    });
  });
});
