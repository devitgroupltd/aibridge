import { describe, expect, test } from "bun:test";
import { startPolling, validateTokens } from "../src/telegram.ts";
import type { GetMeSource, TelegramUpdate, UpdatesSource } from "../src/telegram.ts";

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("validateTokens", () => {
  test("passes when both tokens resolve", async () => {
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    await expect(validateTokens(ok, ok)).resolves.toBeUndefined();
  });

  test("names the control token when it fails", async () => {
    const bad: GetMeSource = { getMe: async () => { throw new Error("401 Unauthorized"); } };
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    await expect(validateTokens(bad, ok)).rejects.toThrow(/CONTROL_BOT_TOKEN/);
  });

  test("names the feed token when it fails", async () => {
    const bad: GetMeSource = { getMe: async () => { throw new Error("401 Unauthorized"); } };
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    await expect(validateTokens(ok, bad)).rejects.toThrow(/FEED_BOT_TOKEN/);
  });
});

describe("startPolling", () => {
  test("advances the offset past the highest update_id seen", async () => {
    // A real long-poll only ever resolves empty after blocking for `timeout` seconds; a fake
    // that resolves empty instantly turns the loop into a microtask busy-spin that starves the
    // event loop's timer phase (this hung the test suite before the delay below was added).
    const batches: TelegramUpdate[][] = [[{ update_id: 10 }, { update_id: 11 }], []];
    const seenOffsets: number[] = [];
    const source: UpdatesSource = {
      getUpdates: async (offset) => {
        seenOffsets.push(offset);
        const batch = batches.shift();
        if (batch === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return [];
        }
        return batch;
      },
    };

    const received: number[] = [];
    const stop = startPolling(source, { onUpdate: (u) => received.push(u.update_id), retryDelayMs: 5 });

    await waitFor(() => received.length >= 2);
    await waitFor(() => (seenOffsets.at(-1) ?? 0) >= 12);
    stop();

    expect(received).toEqual([10, 11]);
    expect(seenOffsets[0]).toBe(0);
  });

  test("a failed getUpdates call retries rather than crashing the loop", async () => {
    // Same microtask-starvation care as above: once past the induced failures, subsequent calls
    // must pace themselves like a real long-poll rather than resolving instantly forever.
    let calls = 0;
    const source: UpdatesSource = {
      getUpdates: async () => {
        calls++;
        if (calls < 3) throw new Error("network blip");
        if (calls === 3) return [{ update_id: 99 }];
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [];
      },
    };
    const errors: unknown[] = [];
    const received: number[] = [];
    const stop = startPolling(source, {
      onUpdate: (u) => received.push(u.update_id),
      onError: (e) => errors.push(e),
      retryDelayMs: 5,
    });

    await waitFor(() => received.length >= 1);
    stop();

    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(received).toEqual([99]);
  });
});
