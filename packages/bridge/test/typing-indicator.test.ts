import { describe, expect, test } from "bun:test";
import { createTypingIndicator } from "../src/typing-indicator.ts";

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("createTypingIndicator", () => {
  test("sends immediately on start, then again on the interval", async () => {
    const calls: string[] = [];
    const indicator = createTypingIndicator({
      send: async (topicId) => {
        calls.push(topicId);
      },
      intervalMs: 20,
    });

    indicator.start("3");
    expect(calls).toEqual(["3"]);

    await waitFor(() => calls.length >= 3);
    indicator.stop("3");
    expect(calls.every((t) => t === "3")).toBe(true);
  });

  test("stop halts further sends", async () => {
    const calls: string[] = [];
    const indicator = createTypingIndicator({
      send: async (topicId) => {
        calls.push(topicId);
      },
      intervalMs: 15,
    });

    indicator.start("3");
    indicator.stop("3");
    const countAtStop = calls.length;

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.length).toBe(countAtStop);
  });

  test("starting again for the same topic restarts cleanly rather than doubling up", async () => {
    const calls: string[] = [];
    const indicator = createTypingIndicator({
      send: async (topicId) => {
        calls.push(topicId);
      },
      intervalMs: 200,
    });

    indicator.start("3");
    indicator.start("3"); // a second turn beginning before the first's interval ever fired
    await new Promise((resolve) => setTimeout(resolve, 50));
    indicator.stop("3");

    // Two immediate sends (one per start()), no interval firing yet at this short a wait.
    expect(calls).toEqual(["3", "3"]);
  });

  test("gives up after maxTicks rather than nagging forever if no reply ever arrives", async () => {
    const calls: string[] = [];
    const indicator = createTypingIndicator({
      send: async (topicId) => {
        calls.push(topicId);
      },
      intervalMs: 10,
      maxTicks: 3,
    });

    indicator.start("3");
    await waitFor(() => calls.length >= 3);
    const countAtCap = calls.length;
    expect(countAtCap).toBe(3);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls.length).toBe(countAtCap);
  });

  test("a failing send is logged, not thrown, and does not stop the interval", async () => {
    const warnings: string[] = [];
    let attempts = 0;
    const indicator = createTypingIndicator({
      send: async () => {
        attempts++;
        throw new Error("network blip");
      },
      intervalMs: 10,
      log: (level, message) => {
        if (level === "WARN") warnings.push(message);
      },
    });

    indicator.start("3");
    await waitFor(() => attempts >= 2);
    indicator.stop("3");

    await waitFor(() => warnings.length >= 1);
    expect(warnings[0]).toMatch(/topic "3"/);
  });
});
