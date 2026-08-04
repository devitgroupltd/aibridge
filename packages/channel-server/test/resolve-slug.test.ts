import { describe, expect, test } from "bun:test";
import { resolveSlug } from "../src/resolve-slug.ts";

describe("resolveSlug (§10.1: two ways this process learns its identity)", () => {
  test("AIBRIDGE_SLUG is used as-is when set (the Bridge's own .mcp.json registration path)", () => {
    expect(resolveSlug({ AIBRIDGE_SLUG: "fix-bug" })).toBe("fix-bug");
  });

  test("AIBRIDGE_SLUG wins over CLAUDE_PROJECT_DIR when both are set", () => {
    expect(resolveSlug({ AIBRIDGE_SLUG: "fix-bug", CLAUDE_PROJECT_DIR: "C:\\data\\worktrees\\other-slug" })).toBe("fix-bug");
  });

  test("falls back to CLAUDE_PROJECT_DIR's basename when AIBRIDGE_SLUG is unset (the plugin path)", () => {
    expect(resolveSlug({ CLAUDE_PROJECT_DIR: "C:\\data\\worktrees\\fix-bug" })).toBe("fix-bug");
  });

  test("falls back correctly for a POSIX-style project dir too", () => {
    expect(resolveSlug({ CLAUDE_PROJECT_DIR: "/data/worktrees/fix-bug" })).toBe("fix-bug");
  });

  test("returns undefined when neither is set", () => {
    expect(resolveSlug({})).toBeUndefined();
  });
});
