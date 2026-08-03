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
    paused: false,
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
});
