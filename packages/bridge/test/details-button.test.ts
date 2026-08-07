import { describe, expect, test } from "bun:test";
import { buildDetailsKeyboard, parseDetailsCallback } from "../src/details-button.ts";

describe("buildDetailsKeyboard", () => {
  test("encodes slug and turn as §5.5's d:<slug>:<turn>", () => {
    const keyboard = buildDetailsKeyboard("fix-login-bug", 3);
    expect(keyboard).toEqual([[{ text: "Details", callback_data: "d:fix-login-bug:3" }]]);
  });

  test("stays well inside the 64-byte callback_data cap even at the max slug length", () => {
    const maxSlug = "a".repeat(40); // slug.ts's own MAX_SLUG_LENGTH
    const data = buildDetailsKeyboard(maxSlug, 9_999_999_999)[0]?.[0]?.callback_data ?? "";
    expect(data.length).toBeLessThanOrEqual(64);
  });
});

describe("parseDetailsCallback", () => {
  test("round-trips what buildDetailsKeyboard produces", () => {
    const data = buildDetailsKeyboard("fix-login-bug", 3)[0]?.[0]?.callback_data ?? "";
    expect(parseDetailsCallback(data)).toEqual({ slug: "fix-login-bug", turnSeq: 3 });
  });

  test("rejects a different namespace (e.g. a permission callback)", () => {
    expect(parseDetailsCallback("perm:abcde:a")).toBeNull();
  });

  test("rejects malformed turn numbers", () => {
    expect(parseDetailsCallback("d:fix-login-bug:not-a-number")).toBeNull();
    expect(parseDetailsCallback("d:fix-login-bug:")).toBeNull();
  });

  test("rejects an empty slug", () => {
    expect(parseDetailsCallback("d::3")).toBeNull();
  });
});
