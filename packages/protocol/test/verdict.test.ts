import { describe, expect, test } from "bun:test";
import { assertValidBehavior } from "../src/types.ts";

// §9 scenario 4: verdict shape is { request_id, behavior } with behavior strictly allow or deny.
describe("assertValidBehavior", () => {
  test("accepts allow and deny", () => {
    expect(() => assertValidBehavior("allow")).not.toThrow();
    expect(() => assertValidBehavior("deny")).not.toThrow();
  });

  test("throws on any other value", () => {
    expect(() => assertValidBehavior("maybe")).toThrow();
    expect(() => assertValidBehavior("")).toThrow();
    expect(() => assertValidBehavior("ALLOW")).toThrow();
  });
});
