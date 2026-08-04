import { describe, expect, test } from "bun:test";
import { PermissionRegistry, sweepExpiredPermissions } from "../src/permission-registry.ts";

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
    );

    expect(verdictSent).toBe(false);
    expect(registry.get("aaaaa")).toBeDefined();
  });
});
