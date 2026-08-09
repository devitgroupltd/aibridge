import { describe, expect, test } from "bun:test";
import { LateBound } from "../src/late-bound.ts";

describe("LateBound", () => {
  test("get() throws if nothing was ever set - a forward reference read too early", () => {
    const box = new LateBound<number>();
    expect(() => box.get()).toThrow(/read too early/);
  });

  test("set() then get() returns the assigned value", () => {
    const box = new LateBound<{ n: number }>();
    const value = { n: 42 };
    box.set(value);
    expect(box.get()).toBe(value);
  });

  test("set() called a second time throws - a forward reference must be assigned exactly once", () => {
    const box = new LateBound<number>();
    box.set(1);
    expect(() => box.set(2)).toThrow(/assigned exactly once/);
  });
});
