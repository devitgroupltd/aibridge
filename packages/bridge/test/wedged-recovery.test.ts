import { describe, expect, test } from "bun:test";
import { createWedgedRecoveryMarks, recoverWedgedPty, WEDGED_RECOVERY_MARK_TTL_MS } from "../src/wedged-recovery.ts";

describe("recoverWedgedPty", () => {
  test("returns false and kills nothing when the slug has no entry", () => {
    const map = new Map<string, { kill: () => void }>();
    let killed = false;
    // Nothing in the map for "gone-slug" - kill must never be reachable in this case, so there's
    // no spy to attach; a throw from a bad lookup would fail the test on its own.
    expect(recoverWedgedPty(map, "gone-slug", createWedgedRecoveryMarks())).toBe(false);
    expect(killed).toBe(false);
  });

  test("kills the pty and returns true when the slug has a live entry", () => {
    let killCount = 0;
    const map = new Map<string, { kill: () => void }>([["wedged-slug", { kill: () => { killCount += 1; } }]]);
    expect(recoverWedgedPty(map, "wedged-slug", createWedgedRecoveryMarks())).toBe(true);
    expect(killCount).toBe(1);
  });

  test("does NOT remove the slug's entry from the map - this is the whole point (§ regression guard)", () => {
    const ptyProcess = { kill: () => {} };
    const map = new Map<string, { kill: () => void }>([["wedged-slug", ptyProcess]]);
    recoverWedgedPty(map, "wedged-slug", createWedgedRecoveryMarks());
    // Deleting this entry first is exactly what /kill/rm do to tell handleUnexpectedExit "don't
    // resume this one" - if this function ever started doing the same, the auto-recovery would
    // silently regress back into a dead end instead of resuming the session.
    expect(map.has("wedged-slug")).toBe(true);
    expect(map.get("wedged-slug")).toBe(ptyProcess);
  });

  test("only kills the named slug, leaving other live entries in the map untouched", () => {
    let otherKillCount = 0;
    const map = new Map<string, { kill: () => void }>([
      ["wedged-slug", { kill: () => {} }],
      ["other-slug", { kill: () => { otherKillCount += 1; } }],
    ]);
    recoverWedgedPty(map, "wedged-slug", createWedgedRecoveryMarks());
    expect(otherKillCount).toBe(0);
    expect(map.has("other-slug")).toBe(true);
  });

  // P0-8. The ordering *is* the bug: the dying process's own `SessionEnd` hook reached the pipe
  // 33ms after the kill in the live capture, so a mark written after `kill()` returns would lose
  // that race exactly as reliably as no mark at all. Asserting from inside `kill` is the only way
  // to pin the order down - checking after `recoverWedgedPty` returns passes either way.
  test("marks the recovery BEFORE killing, not after", () => {
    const marks = createWedgedRecoveryMarks();
    let markedWhenKillRan: boolean | undefined;
    const map = new Map<string, { kill: () => void }>([
      ["wedged-slug", { kill: () => { markedWhenKillRan = marks.isRecovering("wedged-slug"); } }],
    ]);
    recoverWedgedPty(map, "wedged-slug", marks);
    expect(markedWhenKillRan).toBe(true);
  });

  test("does not mark a slug it found nothing to kill for", () => {
    const marks = createWedgedRecoveryMarks();
    recoverWedgedPty(new Map<string, { kill: () => void }>(), "gone-slug", marks);
    // A manual /kill or a real crash raced this detection. Marking anyway would suppress the
    // mark-dead for a `SessionEnd` that genuinely does end the session.
    expect(marks.isRecovering("gone-slug")).toBe(false);
  });
});

describe("createWedgedRecoveryMarks", () => {
  test("an unmarked slug is never recovering", () => {
    expect(createWedgedRecoveryMarks().isRecovering("never-touched")).toBe(false);
  });

  test("marks are per-slug - one recovery does not shield the rest of the fleet", () => {
    const marks = createWedgedRecoveryMarks();
    marks.mark("wedged-slug");
    expect(marks.isRecovering("wedged-slug")).toBe(true);
    expect(marks.isRecovering("healthy-slug")).toBe(false);
  });

  test("clear drops the mark immediately, so a genuine exit right after a resume still marks the row dead", () => {
    const marks = createWedgedRecoveryMarks();
    marks.mark("wedged-slug");
    marks.clear("wedged-slug");
    expect(marks.isRecovering("wedged-slug")).toBe(false);
  });

  test("a mark expires after the TTL - a recovery that never happened must not shield the session forever", () => {
    let nowMs = 1_000;
    const marks = createWedgedRecoveryMarks({ now: () => nowMs });
    marks.mark("wedged-slug");
    nowMs += WEDGED_RECOVERY_MARK_TTL_MS;
    expect(marks.isRecovering("wedged-slug")).toBe(true); // exactly at the boundary is still inside
    nowMs += 1;
    expect(marks.isRecovering("wedged-slug")).toBe(false);
  });

  test("re-marking restarts the window rather than keeping the first mark's deadline", () => {
    let nowMs = 0;
    const marks = createWedgedRecoveryMarks({ now: () => nowMs, ttlMs: 100 });
    marks.mark("wedged-slug");
    nowMs += 80;
    marks.mark("wedged-slug"); // a second wedge detection for the same slug
    nowMs += 80;
    expect(marks.isRecovering("wedged-slug")).toBe(true);
  });
});
