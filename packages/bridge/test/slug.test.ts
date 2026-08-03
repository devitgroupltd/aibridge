import { describe, expect, test } from "bun:test";
import { slugFromPrompt, uniqueSlug } from "../src/slug.ts";

describe("slugFromPrompt", () => {
  test("takes the first five words, lowercased and dashed", () => {
    expect(slugFromPrompt("Fix the login redirect bug on mobile Safari")).toBe("fix-the-login-redirect-bug");
  });

  test("§9 scenario 27: a path-unsafe prompt produces a safe path segment", () => {
    expect(slugFromPrompt("Fix `../../etc/passwd` traversal!!")).toBe("fix-etc-passwd-traversal");
    expect(slugFromPrompt("../../../")).toBe("session");
  });

  test("falls back to session for an empty or all-symbol prompt", () => {
    expect(slugFromPrompt("")).toBe("session");
    expect(slugFromPrompt("!!!???")).toBe("session");
  });

  test("rejects Windows reserved device names as the sanitized result", () => {
    expect(slugFromPrompt("con")).toBe("session");
    expect(slugFromPrompt("NUL")).toBe("session");
  });
});

describe("uniqueSlug", () => {
  test("returns the base slug unchanged when not taken", () => {
    expect(uniqueSlug("fix-bug", new Set(["other"]))).toBe("fix-bug");
  });

  test("§9 scenario 27: identical prompts get distinct slugs", () => {
    const existing = new Set(["fix-bug"]);
    expect(uniqueSlug("fix-bug", existing)).toBe("fix-bug-2");
  });

  test("skips over already-taken numbered variants", () => {
    const existing = new Set(["fix-bug", "fix-bug-2", "fix-bug-3"]);
    expect(uniqueSlug("fix-bug", existing)).toBe("fix-bug-4");
  });

  test("accepts a plain array as well as a Set", () => {
    expect(uniqueSlug("fix-bug", ["fix-bug"])).toBe("fix-bug-2");
  });
});
