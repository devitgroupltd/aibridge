import { describe, expect, test } from "bun:test";
import { recoverWedgedPty } from "../src/wedged-recovery.ts";

describe("recoverWedgedPty", () => {
  test("returns false and kills nothing when the slug has no entry", () => {
    const map = new Map<string, { kill: () => void }>();
    let killed = false;
    // Nothing in the map for "gone-slug" - kill must never be reachable in this case, so there's
    // no spy to attach; a throw from a bad lookup would fail the test on its own.
    expect(recoverWedgedPty(map, "gone-slug")).toBe(false);
    expect(killed).toBe(false);
  });

  test("kills the pty and returns true when the slug has a live entry", () => {
    let killCount = 0;
    const map = new Map<string, { kill: () => void }>([["wedged-slug", { kill: () => { killCount += 1; } }]]);
    expect(recoverWedgedPty(map, "wedged-slug")).toBe(true);
    expect(killCount).toBe(1);
  });

  test("does NOT remove the slug's entry from the map - this is the whole point (§ regression guard)", () => {
    const ptyProcess = { kill: () => {} };
    const map = new Map<string, { kill: () => void }>([["wedged-slug", ptyProcess]]);
    recoverWedgedPty(map, "wedged-slug");
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
    recoverWedgedPty(map, "wedged-slug");
    expect(otherKillCount).toBe(0);
    expect(map.has("other-slug")).toBe(true);
  });
});
