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

describe("Routing effort tracking (§4.2.1's /effort keyboard current-value display)", () => {
  test("defaults to medium before any /effort write - matches the live-observed CLI default", () => {
    const routing = new Routing();
    expect(routing.getEffort("test-session")).toBe("medium");
  });

  test("setEffort is remembered for subsequent getEffort calls", () => {
    const routing = new Routing();
    routing.setEffort("test-session", "xhigh");
    expect(routing.getEffort("test-session")).toBe("xhigh");
  });

  test("tracks each slug independently", () => {
    const routing = new Routing();
    routing.setEffort("a", "low");
    expect(routing.getEffort("a")).toBe("low");
    expect(routing.getEffort("b")).toBe("medium");
  });
});

describe("Routing multi-session lookups (Phase 5)", () => {
  test("getByTopicId resolves the same route add() registered", () => {
    const routing = new Routing();
    routing.add({ slug: "fix-bug", topicId: 5, worktreePath: "c:\\wt\\fix-bug" });
    expect(routing.getByTopicId(5)?.slug).toBe("fix-bug");
    expect(routing.getByTopicId(999)).toBeUndefined();
  });

  test("all() lists every added route, supporting concurrent sessions (§12 Phase 5 exit criterion)", () => {
    const routing = new Routing();
    routing.add({ slug: "a", topicId: 2, worktreePath: "c:\\wt\\a" });
    routing.add({ slug: "b", topicId: 3, worktreePath: "c:\\wt\\b" });
    expect(routing.all().map((r) => r.slug).sort()).toEqual(["a", "b"]);
  });

  test("remove forgets the slug, its topic mapping, pty write function, mode, effort and both auto toggles", () => {
    const routing = new Routing();
    routing.add({ slug: "a", topicId: 2, worktreePath: "c:\\wt\\a" });
    routing.setPtyWrite("a", () => {});
    routing.setMode("a", "auto");
    routing.setEffort("a", "high");
    routing.setBypass("a", true);
    routing.setAutoAnswer("a", true);
    routing.remove("a");
    expect(routing.get("a")).toBeUndefined();
    expect(routing.getByTopicId(2)).toBeUndefined();
    expect(routing.getPtyWrite("a")).toBeUndefined();
    expect(routing.getMode("a")).toBe("manual");
    expect(routing.getEffort("a")).toBe("medium");
    // Safety-relevant, not tidiness: `uniqueSlug` de-duplicates only against live slugs, so after
    // `/rm a` the name is free again. A leaked `true` here would have the next session to claim it
    // start fully auto-permitted, with no confirmation announcing that.
    expect(routing.getBypass("a")).toBe(false);
    expect(routing.getAutoAnswer("a")).toBe(false);
  });

  test("both auto toggles default to off, round-trip, and stay independent per slug and per category", () => {
    const routing = new Routing();
    expect(routing.getBypass("a")).toBe(false);
    expect(routing.getAutoAnswer("a")).toBe(false);

    routing.setBypass("a", true);
    expect(routing.getBypass("a")).toBe(true);
    expect(routing.getAutoAnswer("a")).toBe(false);
    expect(routing.getBypass("b")).toBe(false);

    routing.setBypass("a", false);
    expect(routing.getBypass("a")).toBe(false);
  });

  test("a fresh Routing with no persistence starts both toggles off (tests/self-check route shape, unchanged by v0.24.0)", () => {
    const before = new Routing();
    before.setBypass("a", true);
    expect(new Routing().getBypass("a")).toBe(false);
  });

  test("v0.24.0: setBypass/setAutoAnswer write through to an injected persistence sink", () => {
    const calls: { method: string; slug: string; on: boolean }[] = [];
    const routing = new Routing({
      setBypassPermission: (slug, on) => calls.push({ method: "setBypassPermission", slug, on }),
      setAutoAnswer: (slug, on) => calls.push({ method: "setAutoAnswer", slug, on }),
      setMode: () => {},
    });
    routing.setBypass("a", true);
    routing.setAutoAnswer("a", true);
    routing.setBypass("a", false);
    expect(calls).toEqual([
      { method: "setBypassPermission", slug: "a", on: true },
      { method: "setAutoAnswer", slug: "a", on: true },
      { method: "setBypassPermission", slug: "a", on: false },
    ]);
    // The in-memory read path is unaffected by the presence of persistence - still readable
    // immediately, same as before.
    expect(routing.getBypass("a")).toBe(false);
    expect(routing.getAutoAnswer("a")).toBe(true);
  });

  test("v0.24.0: setMode also writes through to the persistence sink", () => {
    const calls: { slug: string; mode: string }[] = [];
    const routing = new Routing({
      setBypassPermission: () => {},
      setAutoAnswer: () => {},
      setMode: (slug, mode) => calls.push({ slug, mode }),
    });
    routing.setMode("a", "auto");
    expect(calls).toEqual([{ slug: "a", mode: "auto" }]);
    expect(routing.getMode("a")).toBe("auto");
  });

  test("v0.24.0: hydrateFromRow restores mode, bypass and auto-answer without writing back through persistence (session-supervisor.ts's resumeSession)", () => {
    const calls: unknown[] = [];
    const routing = new Routing({
      setBypassPermission: (...args) => calls.push(args),
      setAutoAnswer: (...args) => calls.push(args),
      setMode: (...args) => calls.push(args),
    });
    routing.hydrateFromRow("a", { mode: "acceptEdits", bypassPermission: true, autoAnswer: true });
    expect(routing.getMode("a")).toBe("acceptEdits");
    expect(routing.getBypass("a")).toBe(true);
    expect(routing.getAutoAnswer("a")).toBe(true);
    expect(calls).toEqual([]);
  });

  test("v0.24.0: hydrateFromRow falls back to DEFAULT_MODE for a mode value MODES no longer recognises", () => {
    const routing = new Routing();
    routing.hydrateFromRow("a", { mode: "some-removed-mode", bypassPermission: false, autoAnswer: false });
    expect(routing.getMode("a")).toBe("manual");
  });

  test("clearPtyWrite drops the write function but keeps the route (§4.2's /kill: worktree/topic mapping survive)", () => {
    const routing = new Routing();
    routing.add({ slug: "a", topicId: 2, worktreePath: "c:\\wt\\a" });
    routing.setPtyWrite("a", () => {});
    routing.clearPtyWrite("a");
    expect(routing.getPtyWrite("a")).toBeUndefined();
    expect(routing.get("a")).toBeDefined();
  });
});

describe("Routing PTY output ring buffer (§4.2's /attach)", () => {
  test("returns an empty string before anything is appended", () => {
    const routing = new Routing();
    expect(routing.getOutputTail("a")).toBe("");
  });

  test("appends accumulate in order", () => {
    const routing = new Routing();
    routing.appendOutput("a", "hello ");
    routing.appendOutput("a", "world");
    expect(routing.getOutputTail("a")).toBe("hello world");
  });

  test("trims to the last N characters rather than growing without bound", () => {
    const routing = new Routing();
    routing.appendOutput("a", "x".repeat(5000));
    routing.appendOutput("a", "TAIL");
    const tail = routing.getOutputTail("a");
    expect(tail.length).toBeLessThan(5000);
    expect(tail.endsWith("TAIL")).toBe(true);
  });

  test("tracks each slug's buffer independently", () => {
    const routing = new Routing();
    routing.appendOutput("a", "from a");
    routing.appendOutput("b", "from b");
    expect(routing.getOutputTail("a")).toBe("from a");
    expect(routing.getOutputTail("b")).toBe("from b");
  });
});
