import { describe, expect, test } from "bun:test";
import { checkConcurrencyCap, currentUnits, MODEL_WEIGHT, WEIGHTED_CAP } from "../src/concurrency-cap.ts";
import type { SessionRow } from "../src/session-store.ts";

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "s",
    topicId: 1,
    sessionId: null,
    worktreePath: "c:\\worktree",
    branch: "claude/s-1",
    repoPath: "c:\\repo",
    model: "sonnet",
    ptyPid: 1,
    state: "idle",
    turnCardMsg: null,
    paused: false,
    renamed: false,
    feedDetail: "compact",
    feedVerbose: false,
    createdUtc: "2026-08-04T00:00:00.000Z",
    lastEventUtc: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("currentUnits", () => {
  test("sums model weights across non-dead rows", () => {
    const rows = [row({ model: "sonnet" }), row({ model: "opus" }), row({ model: "haiku" })];
    expect(currentUnits(rows)).toBeCloseTo(1 + 2 + 0.5, 6);
  });

  test("a dead row does not count against the budget", () => {
    const rows = [row({ model: "opus", state: "dead" })];
    expect(currentUnits(rows)).toBe(0);
  });

  test("an unrecognised model weight defaults to 1", () => {
    expect(currentUnits([row({ model: "some-future-model" })])).toBe(1);
  });
});

describe("checkConcurrencyCap", () => {
  test("four sonnet sessions fit exactly at the cap", () => {
    const rows = [row(), row(), row()];
    expect(checkConcurrencyCap(rows, "sonnet")).toEqual({ ok: true });
  });

  test("a fifth sonnet session is refused, reporting current and prospective totals", () => {
    const rows = [row(), row(), row(), row()];
    expect(checkConcurrencyCap(rows, "sonnet")).toEqual({ ok: false, current: 4, wouldBe: 5 });
  });

  test("one opus plus two sonnet fits (2 + 1 + 1 = 4)", () => {
    const rows = [row({ model: "opus" }), row({ model: "sonnet" })];
    expect(checkConcurrencyCap(rows, "sonnet")).toEqual({ ok: true });
  });

  test("adding opus to an already-full fleet is refused", () => {
    const rows = [row(), row(), row(), row()];
    expect(checkConcurrencyCap(rows, "opus")).toEqual({ ok: false, current: 4, wouldBe: 6 });
  });

  test("MODEL_WEIGHT and WEIGHTED_CAP match §10.5's table", () => {
    expect(MODEL_WEIGHT).toEqual({ sonnet: 1, opus: 2, haiku: 0.5, fable: 0.5 });
    expect(WEIGHTED_CAP).toBe(4);
  });
});
