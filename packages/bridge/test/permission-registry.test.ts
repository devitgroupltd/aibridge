import { describe, expect, test } from "bun:test";
import { PermissionRegistry, sweepExpiredPermissions, toolInputMatches } from "../src/permission-registry.ts";

function entry(overrides: Partial<Parameters<PermissionRegistry["add"]>[0]> = {}) {
  return {
    requestId: "abcde",
    slug: "test-session",
    toolName: "Bash",
    description: "run a command",
    inputPreview: '{ "command": "echo hi" }',
    topicId: 3,
    messageId: 10,
    ...overrides,
  };
}

describe("PermissionRegistry", () => {
  // §9 scenario 5: two concurrent prompts in different sessions; a verdict for one does not
  // resolve the other.
  test("resolving one request does not resolve a concurrent request in another session", () => {
    const registry = new PermissionRegistry();
    registry.add(entry({ requestId: "aaaaa", slug: "session-a" }));
    registry.add(entry({ requestId: "bbbbb", slug: "session-b" }));

    const resolved = registry.resolve("aaaaa");
    expect(resolved?.slug).toBe("session-a");
    expect(registry.get("bbbbb")).toBeDefined();
    expect(registry.get("bbbbb")?.slug).toBe("session-b");
  });

  // §9 scenario 6: unknown request_id is a no-op, not a crash and not a wildcard resolve.
  test("resolving an unknown request_id returns undefined without throwing", () => {
    const registry = new PermissionRegistry();
    registry.add(entry({ requestId: "aaaaa" }));

    expect(() => registry.resolve("zzzzz")).not.toThrow();
    expect(registry.resolve("zzzzz")).toBeUndefined();
    // the real pending entry is untouched by the failed lookup
    expect(registry.get("aaaaa")).toBeDefined();
  });

  // §9 scenario 7: an expired request_id is refused even if the letters match a newer request.
  test("an expired request_id is refused even though the id still matches", () => {
    let now = 0;
    const registry = new PermissionRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ requestId: "aaaaa" }));

    now = 1001; // just past the TTL
    expect(registry.resolve("aaaaa")).toBeUndefined();

    // and the entry is gone, not left pending after the failed expired resolve
    expect(registry.get("aaaaa")).toBeUndefined();
  });

  test("resolving within the TTL succeeds and removes the entry", () => {
    let now = 0;
    const registry = new PermissionRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ requestId: "aaaaa" }));

    now = 999;
    expect(registry.resolve("aaaaa")).toBeDefined();
    expect(registry.get("aaaaa")).toBeUndefined();
  });

  test("expired() lists entries past the TTL without removing them", () => {
    let now = 0;
    const registry = new PermissionRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ requestId: "aaaaa" }));
    registry.add(entry({ requestId: "bbbbb" }));

    now = 500;
    expect(registry.expired()).toEqual([]);

    now = 1500;
    expect(registry.expired().map((e) => e.requestId).sort()).toEqual(["aaaaa", "bbbbb"]);
    expect(registry.get("aaaaa")).toBeDefined(); // expired() does not consume entries
  });

  // `/stop` (§4.2): live-verified 2026-08-09 that interrupting a session mid-tool-call abandons a
  // still-pending permission ask outright, so it needs a way to drop that stale entry.
  describe("removeForSlug", () => {
    test("removes every pending entry for the given slug and returns the removed entries", () => {
      const registry = new PermissionRegistry();
      registry.add(entry({ requestId: "aaaaa", slug: "session-a" }));
      registry.add(entry({ requestId: "bbbbb", slug: "session-a" }));
      registry.add(entry({ requestId: "ccccc", slug: "session-b" }));

      expect(registry.removeForSlug("session-a").map((e) => e.requestId).sort()).toEqual(["aaaaa", "bbbbb"]);
      expect(registry.get("aaaaa")).toBeUndefined();
      expect(registry.get("bbbbb")).toBeUndefined();
      // a different session's pending entry is untouched
      expect(registry.get("ccccc")).toBeDefined();
    });

    test("returns an empty array without throwing when nothing is pending for that slug", () => {
      const registry = new PermissionRegistry();
      registry.add(entry({ requestId: "aaaaa", slug: "session-a" }));

      expect(registry.removeForSlug("ghost")).toEqual([]);
      expect(registry.get("aaaaa")).toBeDefined();
    });
  });

  // Found live 2026-08-04: the expiry sweep edited the Telegram card to "expired" but never sent
  // a deny verdict, leaving the channel server's blocked permission call - and the Claude process
  // behind it - waiting forever. Four concurrent endurance-run sessions each wedged this way.
  test("sweepExpiredPermissions sends a deny verdict and removes the entry, not just the card edit", () => {
    let now = 0;
    const registry = new PermissionRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ requestId: "aaaaa", slug: "session-a" }));
    registry.add(entry({ requestId: "bbbbb", slug: "session-b" }));

    const verdicts: Array<{ slug: string; requestId: string; behavior: string }> = [];
    const finalized: Array<{ messageId: number; text: string }> = [];

    now = 1500;
    sweepExpiredPermissions(
      registry,
      (slug, requestId, behavior) => verdicts.push({ slug, requestId, behavior }),
      async (messageId, text) => {
        finalized.push({ messageId, text });
      },
      () => {},
      () => {
        throw new Error("finalizeMessage should not reject in this test");
      },
    );

    expect(verdicts.sort((a, b) => a.requestId.localeCompare(b.requestId))).toEqual([
      { slug: "session-a", requestId: "aaaaa", behavior: "deny" },
      { slug: "session-b", requestId: "bbbbb", behavior: "deny" },
    ]);
    expect(finalized.map((f) => f.text)).toEqual([
      "⌛ expired: Bash (no answer in time)",
      "⌛ expired: Bash (no answer in time)",
    ]);
    expect(registry.get("aaaaa")).toBeUndefined();
    expect(registry.get("bbbbb")).toBeUndefined();
  });

  test("sweepExpiredPermissions is a no-op when nothing is expired", () => {
    let now = 0;
    const registry = new PermissionRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ requestId: "aaaaa" }));

    let verdictSent = false;
    now = 500;
    sweepExpiredPermissions(
      registry,
      () => {
        verdictSent = true;
      },
      async () => {},
      () => {},
      () => {},
    );

    expect(verdictSent).toBe(false);
    expect(registry.get("aaaaa")).toBeDefined();
  });

  // 2026-08-13, same finding as `sweepExpiredAsks`'s own `onResolved` test: the deny above unblocks
  // the session, but nothing moved the row off `awaiting_input`, because the only place that did was
  // the button-tap path. `/ls` then reported a session as blocked on a prompt that had already been
  // resolved on its behalf.
  test("sweepExpiredPermissions reports each resolved slug so the row can leave awaiting_input", () => {
    let now = 0;
    const registry = new PermissionRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ requestId: "aaaaa", slug: "session-a" }));
    registry.add(entry({ requestId: "bbbbb", slug: "session-b" }));

    const resolved: string[] = [];
    now = 1500;
    sweepExpiredPermissions(
      registry,
      () => {},
      async () => {},
      (slug) => resolved.push(slug),
      () => {},
    );

    expect(resolved.sort()).toEqual(["session-a", "session-b"]);
  });

  test("sweepExpiredPermissions reports no resolved slug when nothing expired", () => {
    let now = 0;
    const registry = new PermissionRegistry({ now: () => now, ttlMs: 1000 });
    registry.add(entry({ requestId: "aaaaa" }));

    const resolved: string[] = [];
    now = 500;
    sweepExpiredPermissions(registry, () => {}, async () => {}, (slug) => resolved.push(slug), () => {});

    expect(resolved).toEqual([]);
  });

  // §13 check 4 / §6.5's "answered at the terminal" heuristic: no protocol event says a pending
  // prompt was resolved elsewhere, so a matching PostToolUse/PermissionDenied is the only signal.
  describe("resolveByToolMatch", () => {
    test("matches by (slug, toolName) plus an input match, and removes the entry", () => {
      const registry = new PermissionRegistry();
      registry.add(entry({ requestId: "aaaaa", slug: "session-a", toolName: "Write", inputPreview: '{ "file_path": "src/a.ts" }' }));

      const resolved = registry.resolveByToolMatch("session-a", "Write", { file_path: "src/a.ts" });
      expect(resolved?.requestId).toBe("aaaaa");
      expect(registry.get("aaaaa")).toBeUndefined();
    });

    test("does not match a different session with the same tool", () => {
      const registry = new PermissionRegistry();
      registry.add(entry({ requestId: "aaaaa", slug: "session-a", toolName: "Write", inputPreview: '{ "file_path": "src/a.ts" }' }));

      expect(registry.resolveByToolMatch("session-b", "Write", { file_path: "src/a.ts" })).toBeUndefined();
      expect(registry.get("aaaaa")).toBeDefined();
    });

    test("does not match the same session with a different tool", () => {
      const registry = new PermissionRegistry();
      registry.add(entry({ requestId: "aaaaa", slug: "session-a", toolName: "Write", inputPreview: '{ "file_path": "src/a.ts" }' }));

      expect(registry.resolveByToolMatch("session-a", "Bash", { file_path: "src/a.ts" })).toBeUndefined();
      expect(registry.get("aaaaa")).toBeDefined();
    });

    // The bug this argument exists for: an unrelated same-tool call used to consume the pending
    // entry, editing the card to "✅ Allowed (answered at terminal)" for an approval the operator
    // never gave - and deleting the entry meant the expiry sweep could no longer send the
    // compensating deny, so the session waited forever.
    test("an unrelated call to the same tool does not consume the pending entry", () => {
      const registry = new PermissionRegistry();
      registry.add(entry({ requestId: "aaaaa", slug: "session-a", toolName: "Bash", inputPreview: '{ "command": "rm -rf build" }' }));

      expect(registry.resolveByToolMatch("session-a", "Bash", { command: "git status" })).toBeUndefined();
      expect(registry.get("aaaaa")).toBeDefined();
    });

    // Without an input there is nothing to match on, so "cannot confirm" must not become "matches".
    test("a hook payload carrying no usable tool_input never matches", () => {
      const registry = new PermissionRegistry();
      registry.add(entry({ requestId: "aaaaa", slug: "session-a", toolName: "Bash" }));

      expect(registry.resolveByToolMatch("session-a", "Bash", undefined)).toBeUndefined();
      expect(registry.resolveByToolMatch("session-a", "Bash", null)).toBeUndefined();
      expect(registry.get("aaaaa")).toBeDefined();
    });

    test("two concurrent identical calls for the same (slug, toolName) resolve oldest first", () => {
      let now = 0;
      const registry = new PermissionRegistry({ now: () => now });
      registry.add(entry({ requestId: "aaaaa", slug: "session-a", toolName: "Write", inputPreview: '{ "file_path": "src/a.ts" }' }));
      now = 100;
      registry.add(entry({ requestId: "bbbbb", slug: "session-a", toolName: "Write", inputPreview: '{ "file_path": "src/a.ts" }' }));

      const first = registry.resolveByToolMatch("session-a", "Write", { file_path: "src/a.ts" });
      expect(first?.requestId).toBe("aaaaa");
      const second = registry.resolveByToolMatch("session-a", "Write", { file_path: "src/a.ts" });
      expect(second?.requestId).toBe("bbbbb");
    });

    test("an unknown (slug, toolName) pair returns undefined without throwing", () => {
      const registry = new PermissionRegistry();
      expect(() => registry.resolveByToolMatch("no-such-session", "Bash", { command: "echo hi" })).not.toThrow();
      expect(registry.resolveByToolMatch("no-such-session", "Bash", { command: "echo hi" })).toBeUndefined();
    });
  });

  describe("toolInputMatches", () => {
    /**
     * The regression that a forward-slash-only test suite hid completely. `inputPreview` is
     * JSON-*encoded*, so a decoded field value is not a substring of it whenever JSON escapes
     * anything - which on this host is most of the time: every Windows path contains backslashes, and
     * `C:\data\x` inside the preview is `C:\\data\\x`. A substring comparison therefore never
     * matched a real `Write`/`Edit`/`Read` on Windows, silently killing the whole terminal-answer path
     * and leaving those sessions blocked until the 30-minute sweep denied them.
     */
    test("matches a Windows path through the preview's JSON escaping", () => {
      const filePath = String.raw`C:\data\worktrees\billing\src\api\a.ts`;
      const preview = JSON.stringify({ file_path: filePath, content: "x" });
      // Guard the guard: the preview really does contain doubled backslashes, so a naive
      // `preview.includes(filePath)` is false - which is exactly what used to happen.
      expect(preview.includes(filePath)).toBe(false);

      expect(toolInputMatches(preview, { file_path: filePath })).toBe(true);
      expect(toolInputMatches(preview, { file_path: String.raw`C:\data\worktrees\billing\src\api\b.ts` })).toBe(false);
    });

    test("matches a command containing quotes", () => {
      const command = 'echo "hi there" > out.txt';
      expect(toolInputMatches(JSON.stringify({ command }), { command })).toBe(true);
      expect(toolInputMatches(JSON.stringify({ command }), { command: 'echo "bye" > out.txt' })).toBe(false);
    });

    test("ignores fields that legitimately differ between the preview and the hook payload", () => {
      // A Write's `content` may be elided in one and present in the other - only the identifying
      // field decides.
      const preview = JSON.stringify({ file_path: "src/a.ts" });
      expect(toolInputMatches(preview, { file_path: "src/a.ts", content: "a very long body" })).toBe(true);
    });

    test("falls back to whole-shape comparison for a tool with no identifying field", () => {
      // Task/TodoWrite/mcp__* tools have no command/file_path - a name-only match there was the
      // original bug, and returning `false` unconditionally would leave them permanently unmatchable.
      const preview = JSON.stringify({ subagent_type: "Explore", description: "find X" });
      expect(toolInputMatches(preview, { subagent_type: "Explore", description: "find X" })).toBe(true);
      expect(toolInputMatches(preview, { subagent_type: "Explore", description: "find Y" })).toBe(false);
    });

    test("a preview that isn't JSON at all still matches by containment rather than failing shut", () => {
      expect(toolInputMatches("Bash: git status", { command: "git status" })).toBe(true);
      expect(toolInputMatches("Bash: git status", { command: "rm -rf build" })).toBe(false);
    });

    test("never matches a non-object input, an empty preview object, or a scalar", () => {
      expect(toolInputMatches("{}", {})).toBe(false);
      expect(toolInputMatches('{"file_path":"a"}', "a string" as never)).toBe(false);
      expect(toolInputMatches("42", { command: "x" })).toBe(false);
    });
  });
});

/**
 * False-*positive* protection, which matters more than the false-negative case: a wrong match edits a
 * card to "✅ Allowed (answered at terminal)" for an approval the operator never gave, *and* sends a
 * verdict letting the call through.
 */
describe("toolInputMatches - cannot match two different calls", () => {
  test("a hook payload that is a strict superset of a field-less preview does not match", () => {
    const preview = JSON.stringify({ bash_id: "a" });
    expect(toolInputMatches(preview, { bash_id: "a" })).toBe(true);
    expect(toolInputMatches(preview, { bash_id: "a", filter: "error" })).toBe(false);
  });

  test("an empty preview object never matches anything", () => {
    expect(toolInputMatches("{}", {})).toBe(false);
    expect(toolInputMatches("{}", { command: "rm -rf /" })).toBe(false);
  });

  test("an array payload or preview never matches", () => {
    expect(toolInputMatches("[1,2,3]", { command: "x" })).toBe(false);
    expect(toolInputMatches('{"command":"x"}', ["x"] as never)).toBe(false);
  });

  // The two sides legitimately carry different subsets, so picking one identifying key by priority
  // would let them choose *different* keys and read as a mismatch for plainly the same call.
  test("compares every identifying field either side carries, not just the first", () => {
    const preview = JSON.stringify({ pattern: "**/*.ts" });
    expect(toolInputMatches(preview, { pattern: "**/*.ts", path: "src" })).toBe(false);
    expect(toolInputMatches(JSON.stringify({ pattern: "**/*.ts", path: "src" }), { pattern: "**/*.ts", path: "src" })).toBe(true);
    expect(toolInputMatches(JSON.stringify({ pattern: "**/*.ts", path: "src" }), { pattern: "**/*.ts", path: "test" })).toBe(false);
  });

  test("the non-JSON fallback also compares against the escaped form", () => {
    // Otherwise the fallback is dead weight exactly where it matters - any Windows path.
    const filePath = String.raw`C:\data\x\a.ts`;
    const escapedPreview = `Write: {"file_path":"${filePath.split("\\").join("\\\\")}"} <-- not valid JSON`;
    expect(toolInputMatches(escapedPreview, { file_path: filePath })).toBe(true);
  });
});
