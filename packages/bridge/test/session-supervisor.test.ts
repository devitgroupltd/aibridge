import { describe, expect, test } from "bun:test";
import { createSessionSupervisor, MAX_CONSECUTIVE_RESUME_ATTEMPTS, RESUME_BACKOFF_MS } from "../src/session-supervisor.ts";
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
    ptyPid: 1234,
    state: "working",
    turnCardMsg: null,
    paused: false,
    renamed: false,
    feedDetail: "compact",
    feedVerbose: false,
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
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);

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
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
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
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
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
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
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
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
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
        supervisor.wireSession("fix-bug", nextPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
        return {
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: nextPty as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        };
      },
    });

    const firstPty = fakePty();
    supervisor.wireSession("fix-bug", firstPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
    firstPty.emitExit(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(delays).toEqual([RESUME_BACKOFF_MS[0]]);

    // Simulate /kill (or /rm) tearing the slug down entirely - a later /new reusing this exact slug
    // (slug.ts derives slugs from a prompt's own first words, so a repeat is entirely possible) must
    // not inherit the crash-attempt count a wholly unrelated earlier session built up.
    supervisor.untrack("fix-bug");

    delays.length = 0;
    const freshPty = fakePty();
    supervisor.wireSession("fix-bug", freshPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
    freshPty.emitExit(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(delays).toEqual([RESUME_BACKOFF_MS[0]]);
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
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
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
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
    pty.emitExit(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(delays).toEqual([RESUME_BACKOFF_MS[0]]);
    expect(launchCount).toBe(1);
    expect(sessionStore.get("fix-bug")?.state).not.toBe("dead");
    expect(confirm.calls.some((c) => c.text.includes("resumed"))).toBe(true);
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
        supervisor.wireSession("fix-bug", nextPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
        return {
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: nextPty as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        };
      },
    });

    const firstPty = fakePty();
    supervisor.wireSession("fix-bug", firstPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
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
    supervisor.wireSession("fix-bug", pty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
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
        supervisor.wireSession("fix-bug", nextPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
        return {
          worktreePath: "c:\\data\\worktrees\\fix-bug",
          branch: "claude/fix-bug-1",
          ptyProcess: nextPty as unknown as LaunchedSession["ptyProcess"],
          ready: Promise.resolve({ resumeFailed: false }),
        };
      },
    });

    const firstPty = fakePty();
    supervisor.wireSession("fix-bug", firstPty as unknown as Parameters<typeof supervisor.wireSession>[1], 2);
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
    expect(delays).toEqual([RESUME_BACKOFF_MS[0]]);
  });
});
