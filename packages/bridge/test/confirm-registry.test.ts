import { describe, expect, test } from "bun:test";
import { ConfirmRegistry } from "../src/confirm-registry.ts";
import { FleetConfirmRegistry } from "../src/fleet-confirm.ts";
import { NlConfirmRegistry } from "../src/nl-confirm.ts";
import { StaleConfirmRegistry } from "../src/stale-confirm.ts";
import { VoiceConfirmRegistry } from "../src/voice-confirm.ts";

interface TestEntry {
  id: string;
  createdAt: number;
  payload: string;
}

describe("ConfirmRegistry.take", () => {
  // The distinction that did not exist before: `resolve` returned `undefined` for "expired" and
  // "never existed" alike, so every confirm handler returned silently on an expired tap. Since
  // `answerCallbackQuery` had already cleared the spinner, that is §6.5's forbidden "button that
  // looks tappable and silently does nothing".
  test("reports expired separately from unknown", () => {
    let now = 0;
    const registry = new ConfirmRegistry<TestEntry>(1000, { now: () => now });
    registry.add({ id: "a", payload: "x" });

    now = 5000;
    const taken = registry.take("a");
    expect(taken).toBeDefined();
    expect(taken?.expired).toBe(true);
    expect(taken?.entry.payload).toBe("x");

    // ...and an id that was never there stays indistinguishable from a duplicate tap: undefined.
    expect(registry.take("never-existed")).toBeUndefined();
  });

  test("a live entry comes back not-expired, and only once", () => {
    let now = 0;
    const registry = new ConfirmRegistry<TestEntry>(1000, { now: () => now });
    registry.add({ id: "a", payload: "x" });

    now = 500;
    expect(registry.take("a")).toEqual({ entry: { id: "a", createdAt: 0, payload: "x" }, expired: false });
    // Popped - a double tap must not run the action twice.
    expect(registry.take("a")).toBeUndefined();
  });

  test("resolve stays the old all-or-nothing contract for callers that don't distinguish", () => {
    let now = 0;
    const registry = new ConfirmRegistry<TestEntry>(1000, { now: () => now });
    registry.add({ id: "live", payload: "x" });
    registry.add({ id: "stale", payload: "y" });

    expect(registry.resolve("live")?.payload).toBe("x");
    now = 5000;
    expect(registry.resolve("stale")).toBeUndefined();
  });
});

describe("ConfirmRegistry.wasRecentlyAnswered", () => {
  // The bug a real operator hit: /rm --all's Yes button did nothing after a Bridge restart wiped
  // the pending confirm, with no feedback at all - `take` returning undefined for "never existed"
  // was indistinguishable from a duplicate tap on an already-answered card, so callers stayed
  // silent for both. `wasRecentlyAnswered` lets a caller edit the card for the restart case while
  // still staying silent for the duplicate-tap race, so it must not itself be true before any tap.
  test("false for an id that was never added", () => {
    const registry = new ConfirmRegistry<TestEntry>(1000, { now: () => 0 });
    expect(registry.wasRecentlyAnswered("never-existed")).toBe(false);
  });

  test("true immediately after take, for a live entry or an expired one", () => {
    let now = 0;
    const registry = new ConfirmRegistry<TestEntry>(1000, { now: () => now });
    registry.add({ id: "live", payload: "x" });
    registry.add({ id: "stale", payload: "y" });

    registry.take("live");
    expect(registry.wasRecentlyAnswered("live")).toBe(true);

    now = 5000;
    registry.take("stale");
    expect(registry.wasRecentlyAnswered("stale")).toBe(true);
  });

  test("false again once the retention window has passed - a restart happening well after a genuine answer must still be reported", () => {
    let now = 0;
    const registry = new ConfirmRegistry<TestEntry>(1000, { now: () => now });
    registry.add({ id: "a", payload: "x" });
    registry.take("a");
    expect(registry.wasRecentlyAnswered("a")).toBe(true);

    now = 61_000; // just past the 60s retention window
    expect(registry.wasRecentlyAnswered("a")).toBe(false);
  });

  test("takeExpired sweeping an entry also counts as answering it", () => {
    let now = 0;
    const registry = new ConfirmRegistry<TestEntry>(1000, { now: () => now });
    registry.add({ id: "a", payload: "x" });
    now = 5000;
    registry.takeExpired();
    // Swept, not tapped - still not "answered" (nothing consumed it via a tap), so a subsequent
    // tap on the now-vanished card should read as unknown, not as a duplicate.
    expect(registry.wasRecentlyAnswered("a")).toBe(false);
  });
});

describe("ConfirmRegistry.takeExpired", () => {
  // These four registries had no sweep at all: entries were dropped only by a tap, so an untapped
  // card leaked its whole replay payload for the lifetime of a daemon meant to run for weeks.
  test("removes and returns only the entries past their TTL", () => {
    let now = 0;
    const registry = new ConfirmRegistry<TestEntry>(1000, { now: () => now });
    registry.add({ id: "old", payload: "x" });
    now = 900;
    registry.add({ id: "new", payload: "y" });

    now = 1500; // "old" is 1500ms in (expired), "new" is 600ms in (not).
    const expired = registry.takeExpired();
    expect(expired.map((e) => e.id)).toEqual(["old"]);
    expect(registry.size).toBe(1);
    expect(registry.take("new")?.expired).toBe(false);
  });

  test("a swept entry is gone, so a later tap on its card reads as unknown rather than firing", () => {
    let now = 0;
    const registry = new ConfirmRegistry<TestEntry>(1000, { now: () => now });
    registry.add({ id: "a", payload: "x" });
    now = 5000;
    registry.takeExpired();

    expect(registry.take("a")).toBeUndefined();
    expect(registry.size).toBe(0);
  });
});

// The point of collapsing four identical classes into one: every fix above has to reach all four,
// and nothing but a test enforces that they actually share the implementation.
describe("all four confirm registries share the behaviour", () => {
  test.each([
    ["nl", () => new NlConfirmRegistry({ ttlMs: 1000, now: () => clock.value })],
    ["fleet", () => new FleetConfirmRegistry({ ttlMs: 1000, now: () => clock.value })],
    ["stale", () => new StaleConfirmRegistry({ ttlMs: 1000, now: () => clock.value })],
    ["voice", () => new VoiceConfirmRegistry({ ttlMs: 1000, now: () => clock.value })],
  ])("%s: take reports expiry and takeExpired sweeps", (_name, build) => {
    clock.value = 0;
    // Each registry's payload type differs; only the id/createdAt contract matters here.
    const registry = build() as unknown as ConfirmRegistry<TestEntry>;
    registry.add({ id: "a", payload: "x" } as unknown as Omit<TestEntry, "createdAt">);

    clock.value = 5000;
    expect(registry.take("a")?.expired).toBe(true);

    clock.value = 0;
    registry.add({ id: "b", payload: "y" } as unknown as Omit<TestEntry, "createdAt">);
    clock.value = 5000;
    expect(registry.takeExpired().map((e) => e.id)).toEqual(["b"]);
  });
});

const clock = { value: 0 };
