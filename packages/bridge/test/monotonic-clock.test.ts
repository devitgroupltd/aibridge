import { describe, expect, test } from "bun:test";
import { monotonicNowMs } from "../src/monotonic-clock.ts";

describe("monotonicNowMs (§7.4)", () => {
  test("is non-negative and non-decreasing across two calls", () => {
    const a = monotonicNowMs();
    const b = monotonicNowMs();
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  test("measures real elapsed time, not a fixed value", async () => {
    const a = monotonicNowMs();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = monotonicNowMs();
    expect(b - a).toBeGreaterThan(0);
  });
});
