import { describe, expect, test } from "bun:test";
import { RESTART_SETTLE_MS, restartSettleDelayMs } from "../src/restart-settle.ts";

describe("restartSettleDelayMs", () => {
  test("returns the full settle window right at boot (elapsed 0)", () => {
    expect(restartSettleDelayMs(1_000, 1_000, 10_000)).toBe(10_000);
  });

  test("returns the remaining window partway through", () => {
    expect(restartSettleDelayMs(1_000, 4_000, 10_000)).toBe(7_000);
  });

  test("returns 0 once the window has fully elapsed", () => {
    expect(restartSettleDelayMs(1_000, 11_000, 10_000)).toBe(0);
  });

  test("never returns negative - long past the window stays clamped at 0", () => {
    expect(restartSettleDelayMs(1_000, 1_000_000, 10_000)).toBe(0);
  });

  test("defaults to RESTART_SETTLE_MS when no settle window is given", () => {
    expect(restartSettleDelayMs(1_000, 1_000)).toBe(RESTART_SETTLE_MS);
  });
});
