import { describe, expect, test } from "bun:test";
import { isValidTransition, SessionStore, type SessionRow } from "../src/session-store.ts";

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "fix-bug",
    topicId: 2,
    sessionId: null,
    worktreePath: "c:\\data\\worktrees\\fix-bug",
    branch: "claude/fix-bug-1",
    repoPath: "c:\\data\\projects\\seowrite",
    model: "sonnet",
    ptyPid: 1234,
    state: "starting",
    turnCardMsg: null,
    thinkingPlaceholderMsg: null,
    paused: false,
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

describe("isValidTransition (§4.3's state table)", () => {
  test("every transition the table lists is allowed", () => {
    expect(isValidTransition("starting", "idle")).toBe(true);
    expect(isValidTransition("idle", "working")).toBe(true);
    expect(isValidTransition("working", "awaiting_input")).toBe(true);
    expect(isValidTransition("awaiting_input", "working")).toBe(true);
    expect(isValidTransition("working", "idle")).toBe(true);
    expect(isValidTransition("starting", "dead")).toBe(true);
    expect(isValidTransition("idle", "dead")).toBe(true);
    expect(isValidTransition("working", "dead")).toBe(true);
    expect(isValidTransition("awaiting_input", "dead")).toBe(true);
  });

  test("dead is terminal - no automatic transition out of it", () => {
    expect(isValidTransition("dead", "starting")).toBe(false);
    expect(isValidTransition("dead", "idle")).toBe(false);
  });

  test("skipped/out-of-order transitions are rejected", () => {
    expect(isValidTransition("starting", "working")).toBe(false);
    expect(isValidTransition("idle", "awaiting_input")).toBe(false);
  });

  test("quota_stopped (§10.5 point 3, added 2026-08-04) is reachable from idle, working and awaiting_input, and recoverable back to working/idle", () => {
    expect(isValidTransition("idle", "quota_stopped")).toBe(true);
    expect(isValidTransition("working", "quota_stopped")).toBe(true);
    expect(isValidTransition("awaiting_input", "quota_stopped")).toBe(true);
    expect(isValidTransition("quota_stopped", "working")).toBe(true);
    expect(isValidTransition("quota_stopped", "idle")).toBe(true);
    expect(isValidTransition("quota_stopped", "dead")).toBe(true);
  });

  test("quota_stopped is not reachable from starting, and does not resurrect a dead session", () => {
    expect(isValidTransition("starting", "quota_stopped")).toBe(false);
    expect(isValidTransition("dead", "quota_stopped")).toBe(false);
  });

  // Added 2026-08-13 after a live run left a row stranded at `awaiting_input` for an hour: the
  // turn-ending `Stop` that should have released it was rejected here, silently (`maybeSetState`
  // only logs the writes that land). A `Stop` is the stronger fact - the turn is over, so whatever
  // the session was waiting on is moot, whichever resolution path did or didn't announce itself.
  test("awaiting_input -> idle is allowed, so a turn-ending Stop is never silently dropped", () => {
    expect(isValidTransition("awaiting_input", "idle")).toBe(true);
  });
});

describe("SessionStore", () => {
  test("insert/get round-trips every field, including the paused boolean", () => {
    const store = new SessionStore(":memory:");
    store.insert(row());
    expect(store.get("fix-bug")).toEqual(row());
    expect(store.get("missing")).toBeUndefined();
  });

  test("getByTopicId finds the same row by its topic id", () => {
    const store = new SessionStore(":memory:");
    store.insert(row());
    expect(store.getByTopicId(2)?.slug).toBe("fix-bug");
    expect(store.getByTopicId(999)).toBeUndefined();
  });

  test("all() returns every row, oldest first", () => {
    const store = new SessionStore(":memory:");
    store.insert(row({ slug: "a", topicId: 2, createdUtc: "2026-08-03T00:00:01.000Z" }));
    store.insert(row({ slug: "b", topicId: 3, createdUtc: "2026-08-03T00:00:00.000Z" }));
    expect(store.all().map((r) => r.slug)).toEqual(["b", "a"]);
  });

  test("slugs() returns the set of every current slug", () => {
    const store = new SessionStore(":memory:");
    store.insert(row({ slug: "a", topicId: 2 }));
    store.insert(row({ slug: "b", topicId: 3 }));
    expect(store.slugs()).toEqual(new Set(["a", "b"]));
  });

  test("setState applies a valid transition and stamps last_event_utc", () => {
    const store = new SessionStore(":memory:");
    store.insert(row());
    store.setState("fix-bug", "idle", "2026-08-03T01:00:00.000Z");
    const updated = store.get("fix-bug");
    expect(updated?.state).toBe("idle");
    expect(updated?.lastEventUtc).toBe("2026-08-03T01:00:00.000Z");
  });

  test("setState throws on a transition not in §4.3's table (§9 scenario 40)", () => {
    const store = new SessionStore(":memory:");
    store.insert(row({ state: "dead" }));
    expect(() => store.setState("fix-bug", "idle", "2026-08-03T01:00:00.000Z")).toThrow(/invalid session state transition/);
  });

  test("setState throws on an unknown slug", () => {
    const store = new SessionStore(":memory:");
    expect(() => store.setState("missing", "idle", "2026-08-03T01:00:00.000Z")).toThrow(/unknown slug/);
  });

  test("setModel, setSessionId, setTurnCardMsg and setPaused each update only their own field", () => {
    const store = new SessionStore(":memory:");
    store.insert(row());
    store.setModel("fix-bug", "opus");
    store.setSessionId("fix-bug", "sess-123");
    store.setTurnCardMsg("fix-bug", 42);
    store.setPaused("fix-bug", true);
    expect(store.get("fix-bug")).toMatchObject({ model: "opus", sessionId: "sess-123", turnCardMsg: 42, paused: true });
  });

  // 0.99.0: the self-check session's own row never called this on relaunch (unlike every fleet
  // session's `resumeSession`), so its ptyPid stayed stuck at its one-time insert value forever -
  // and `findOrphanProcesses` matches live processes against rows by exact pid, so a stale ptyPid
  // meant the self-check session's own freshly-launched process flagged itself as an "orphan" on
  // every restart (live-observed 2026-08-08, right after an operator-issued `/restart`).
  test("setPtyPid updates only that field, leaving the rest of the row untouched", () => {
    const store = new SessionStore(":memory:");
    store.insert(row({ ptyPid: 0 }));
    store.setPtyPid("fix-bug", 6304);
    expect(store.get("fix-bug")).toEqual(row({ ptyPid: 6304 }));
  });

  test("remove deletes the row entirely", () => {
    const store = new SessionStore(":memory:");
    store.insert(row());
    store.remove("fix-bug");
    expect(store.get("fix-bug")).toBeUndefined();
  });

  test("topic_id and session_id are unique - a second insert with a colliding topic_id throws", () => {
    const store = new SessionStore(":memory:");
    store.insert(row({ slug: "a", topicId: 2 }));
    expect(() => store.insert(row({ slug: "b", topicId: 2 }))).toThrow();
  });

  test("getBySessionId joins an OTLP session.id back to its row", () => {
    const store = new SessionStore(":memory:");
    store.insert(row());
    store.setSessionId("fix-bug", "sess-123");
    expect(store.getBySessionId("sess-123")?.slug).toBe("fix-bug");
    expect(store.getBySessionId("no-such-session")).toBeUndefined();
  });

  test("§5.9: setFeedDetail/setFeedVerbose each update only their own field, defaulting compact/off", () => {
    const store = new SessionStore(":memory:");
    store.insert(row());
    expect(store.get("fix-bug")).toMatchObject({ feedDetail: "compact", feedVerbose: false });
    store.setFeedDetail("fix-bug", "full");
    expect(store.get("fix-bug")).toMatchObject({ feedDetail: "full", feedVerbose: false });
    store.setFeedVerbose("fix-bug", true);
    expect(store.get("fix-bug")).toMatchObject({ feedDetail: "full", feedVerbose: true });
    store.setFeedDetail("fix-bug", "compact");
    expect(store.get("fix-bug")).toMatchObject({ feedDetail: "compact", feedVerbose: true });
  });

  // bypass-and-autoanswer-plan.md v0.24.0: these two columns are what lets `/auto permission`/
  // `/auto answer` survive a Bridge restart instead of silently resetting to off - `routing.ts`'s
  // `setBypass`/`setAutoAnswer` write through to exactly these two setters.
  test("v0.24.0: setBypassPermission/setAutoAnswer each update only their own field, defaulting off", () => {
    const store = new SessionStore(":memory:");
    store.insert(row());
    expect(store.get("fix-bug")).toMatchObject({ bypassPermission: false, autoAnswer: false });
    store.setBypassPermission("fix-bug", true);
    expect(store.get("fix-bug")).toMatchObject({ bypassPermission: true, autoAnswer: false });
    store.setAutoAnswer("fix-bug", true);
    expect(store.get("fix-bug")).toMatchObject({ bypassPermission: true, autoAnswer: true });
    store.setBypassPermission("fix-bug", false);
    expect(store.get("fix-bug")).toMatchObject({ bypassPermission: false, autoAnswer: true });
  });

  // Same audit, found in the same pass: `mode` isn't cosmetic like `feedVerbose` - resumeSession
  // uses it to build a real `--permission-mode` relaunch flag.
  test("v0.24.0: setMode updates only that field, defaulting to manual", () => {
    const store = new SessionStore(":memory:");
    store.insert(row());
    expect(store.get("fix-bug")).toMatchObject({ mode: "manual" });
    store.setMode("fix-bug", "acceptEdits");
    expect(store.get("fix-bug")).toMatchObject({ mode: "acceptEdits", feedVerbose: false });
  });
});
