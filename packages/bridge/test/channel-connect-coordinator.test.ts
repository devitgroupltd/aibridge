import { describe, expect, test } from "bun:test";
import { ChannelConnectCoordinator } from "../src/channel-connect-coordinator.ts";

describe("ChannelConnectCoordinator", () => {
  test("waitFor resolves true once onConnected fires after the wait started (the normal case)", async () => {
    const coordinator = new ChannelConnectCoordinator();
    const waitPromise = coordinator.waitFor("slug-a", 2000);
    coordinator.onConnected("slug-a");
    expect(await waitPromise).toBe(true);
  });

  test("waitFor resolves true immediately when onConnected already fired first (the lost-signal race)", async () => {
    const coordinator = new ChannelConnectCoordinator();
    coordinator.onConnected("slug-a");
    const start = Date.now();
    expect(await coordinator.waitFor("slug-a", 2000)).toBe(true);
    // No 2000ms timeout should have been waited out - the early signal must be consumed immediately.
    expect(Date.now() - start).toBeLessThan(200);
  });

  test("waitFor resolves false after timeoutMs when onConnected never fires", async () => {
    const coordinator = new ChannelConnectCoordinator();
    expect(await coordinator.waitFor("slug-a", 30)).toBe(false);
  });

  test("an early connect only satisfies one waitFor call, not a second one for the same slug", async () => {
    const coordinator = new ChannelConnectCoordinator();
    coordinator.onConnected("slug-a");
    expect(await coordinator.waitFor("slug-a", 30)).toBe(true);
    // The early signal was consumed by the first call - a second call with nothing new must time out.
    expect(await coordinator.waitFor("slug-a", 30)).toBe(false);
  });

  test("onConnected for one slug does not resolve a waiter for a different slug", async () => {
    const coordinator = new ChannelConnectCoordinator();
    const waitPromise = coordinator.waitFor("slug-a", 30);
    coordinator.onConnected("slug-b");
    expect(await waitPromise).toBe(false);
  });

  test("an early connect past earlyConnectTtlMs is treated as stale and does not short-circuit waitFor", async () => {
    let now = 0;
    const coordinator = new ChannelConnectCoordinator({ earlyConnectTtlMs: 20, now: () => now });
    coordinator.onConnected("slug-a");
    now = 100; // well past the 20ms TTL
    const start = Date.now();
    // No fresh onConnected ever arrives, so this must fall through to a real (short) timeout, not
    // resolve instantly off the stale early-connect entry.
    expect(await coordinator.waitFor("slug-a", 30)).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  test("an early connect within earlyConnectTtlMs still resolves true", async () => {
    let now = 0;
    const coordinator = new ChannelConnectCoordinator({ earlyConnectTtlMs: 20, now: () => now });
    coordinator.onConnected("slug-a");
    now = 10; // within the 20ms TTL
    expect(await coordinator.waitFor("slug-a", 30)).toBe(true);
  });

  test("repeated onConnected for a slug nothing is waiting on doesn't throw and just updates the timestamp", async () => {
    const coordinator = new ChannelConnectCoordinator();
    coordinator.onConnected("slug-a");
    coordinator.onConnected("slug-a");
    coordinator.onConnected("slug-a");
    expect(await coordinator.waitFor("slug-a", 30)).toBe(true);
  });
});
