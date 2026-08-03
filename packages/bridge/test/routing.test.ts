import { describe, expect, test } from "bun:test";
import { Routing } from "../src/routing.ts";

describe("Routing mode tracking (§4.2.2)", () => {
  test("defaults to manual before any /mode write - Phase 1's spawn default", () => {
    const routing = new Routing();
    expect(routing.getMode("test-session")).toBe("manual");
  });

  test("setMode is remembered for subsequent getMode calls", () => {
    const routing = new Routing();
    routing.setMode("test-session", "auto");
    expect(routing.getMode("test-session")).toBe("auto");
  });

  test("tracks each slug independently", () => {
    const routing = new Routing();
    routing.setMode("a", "plan");
    expect(routing.getMode("a")).toBe("plan");
    expect(routing.getMode("b")).toBe("manual");
  });
});
