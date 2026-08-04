import { describe, expect, test } from "bun:test";
import { reconcile } from "../src/reconciliation.ts";
import type { SessionRow } from "../src/session-store.ts";

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "fix-bug",
    topicId: 2,
    sessionId: "sess-123",
    worktreePath: "c:\\data\\worktrees\\fix-bug",
    branch: "claude/fix-bug-1",
    repoPath: "c:\\data\\projects\\seowrite",
    model: "sonnet",
    ptyPid: 1234,
    state: "idle",
    turnCardMsg: null,
    paused: false,
    renamed: false,
    createdUtc: "2026-08-03T00:00:00.000Z",
    lastEventUtc: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("reconcile (§9 scenario 24, §4.5's reconciliation table)", () => {
  test("row exists, process gone -> resume with the persisted session_id", () => {
    const actions = reconcile([row()], () => false);
    expect(actions).toEqual([{ kind: "resume", slug: "fix-bug", sessionId: "sess-123" }]);
  });

  test("row exists, process alive -> re-adopt as terminal-detached, not silently treated as healthy (§4.5)", () => {
    const actions = reconcile([row()], () => true);
    expect(actions).toEqual([{ kind: "readopt", slug: "fix-bug" }]);
  });

  test("dead rows are left alone entirely", () => {
    expect(reconcile([row({ state: "dead" })], () => true)).toEqual([]);
    expect(reconcile([row({ state: "dead" })], () => false)).toEqual([]);
  });

  test("an awaiting_input row also emits a lost_prompt notice, on top of its resume/readopt action", () => {
    const actions = reconcile([row({ state: "awaiting_input" })], () => false);
    expect(actions).toEqual([
      { kind: "lost_prompt", slug: "fix-bug" },
      { kind: "resume", slug: "fix-bug", sessionId: "sess-123" },
    ]);
  });

  test("a resume with no persisted session_id yet (killed before SessionStart) carries sessionId: null", () => {
    const actions = reconcile([row({ sessionId: null })], () => false);
    expect(actions).toEqual([{ kind: "resume", slug: "fix-bug", sessionId: null }]);
  });

  test("each row is checked against its own pty_pid, independently", () => {
    const rows = [row({ slug: "a", ptyPid: 1 }), row({ slug: "b", ptyPid: 2 })];
    const actions = reconcile(rows, (pid) => pid === 1);
    expect(actions).toEqual([
      { kind: "readopt", slug: "a" },
      { kind: "resume", slug: "b", sessionId: "sess-123" },
    ]);
  });
});
