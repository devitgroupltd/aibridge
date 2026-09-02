import { describe, expect, test } from "bun:test";
import { createBackoff } from "../src/backoff.ts";

describe("createBackoff", () => {
  // The exact sequence both telegram.ts loops relied on before the extraction - if this changes,
  // the boot-time wait and the getUpdates loop have silently stopped mirroring each other.
  test("doubles from the floor and settles at the ceiling", () => {
    const b = createBackoff(1000, 8000);
    const seen: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      seen.push(b.delayMs);
      b.advance();
    }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  test("defaults are the 1s/30s pair both call sites already used", () => {
    const b = createBackoff();
    expect(b.delayMs).toBe(1000);
    for (let i = 0; i < 20; i += 1) b.advance();
    expect(b.delayMs).toBe(30_000);
  });

  // A later blip must start short again rather than inheriting the last outage's ceiling - this is
  // what `startPolling` does on every successful getUpdates.
  test("reset returns to the floor, not to wherever it had climbed", () => {
    const b = createBackoff(1000, 30_000);
    for (let i = 0; i < 5; i += 1) b.advance();
    expect(b.delayMs).toBe(30_000);
    b.reset();
    expect(b.delayMs).toBe(1000);
    b.advance();
    expect(b.delayMs).toBe(2000);
  });

  // Reading the delay is what a caller passes to BOTH its log line and its sleep; if the getter
  // advanced as a side effect those two would silently disagree with each other.
  test("reading delayMs does not advance it", () => {
    const b = createBackoff(1000, 30_000);
    expect(b.delayMs).toBe(1000);
    expect(b.delayMs).toBe(1000);
    expect(b.delayMs).toBe(1000);
  });

  // A faithful extraction: no clamping of either bound. Repairing a caller's arguments here would
  // be a behaviour change smuggled in under a refactor.
  test("a ceiling below the floor collapses on the first advance, as it always did", () => {
    const b = createBackoff(1000, 100);
    expect(b.delayMs).toBe(1000);
    b.advance();
    expect(b.delayMs).toBe(100);
  });
});
