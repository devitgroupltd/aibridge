import { describe, expect, test } from "bun:test";
import { containsSensitivePath, isCompoundCommandFullyAllowed, splitTopLevelCommands, WIDENED_AUTO_APPROVE_PREFIXES } from "../src/compound-permission.ts";
import type { PermissionSettings } from "../src/settings.ts";

const settings: PermissionSettings = {
  permissions: {
    deny: ["Bash(rm -rf /*)"],
    ask: ["Bash(git commit *)", "Bash(git push *)"],
    allow: ["Bash(git status *)", "Bash(cat *)", "Bash(rg *)", "Bash(grep -c *)", "Bash(npm ci)"],
  },
};

describe("splitTopLevelCommands", () => {
  test("splits on unquoted && , ; and |", () => {
    expect(splitTopLevelCommands("a && b; c | d")).toEqual(["a", "b", "c", "d"]);
  });

  test("never splits inside single or double quotes", () => {
    expect(splitTopLevelCommands(`sed -i 's#a && b; c#x#g' file`)).toEqual([`sed -i 's#a && b; c#x#g' file`]);
    expect(splitTopLevelCommands(`echo "a; b"`)).toEqual([`echo "a; b"`]);
  });

  test("bails out (null) on a subshell, backtick, or bare & - never guesses through them", () => {
    expect(splitTopLevelCommands("echo $(whoami)")).toBeNull();
    expect(splitTopLevelCommands("echo `whoami`")).toBeNull();
    expect(splitTopLevelCommands("sleep 5 &")).toBeNull();
  });

  test("bails out on an unterminated quote rather than guessing", () => {
    expect(splitTopLevelCommands(`echo "unterminated`)).toBeNull();
  });

  test("trims and drops empty segments", () => {
    expect(splitTopLevelCommands("a &&   && b")).toEqual(["a", "b"]);
  });
});

describe("containsSensitivePath", () => {
  test.each([[".env"], [".env.production"], ["id_rsa"], ["secret.pem"], ["~/.ssh/id_ed25519"]])("flags %p", (needle) => {
    expect(containsSensitivePath(`cat ${needle}`)).toBe(true);
  });

  test("an ordinary worktree file is not flagged", () => {
    expect(containsSensitivePath("sed -i 's#a#b#g' plans/plan.md")).toBe(false);
  });
});

describe("isCompoundCommandFullyAllowed", () => {
  test("a chain of already-allowed pieces (the motivating case) is fully allowed once sed -i is widened in", () => {
    const command = `cd "C:\\data\\worktrees\\x" && sed -i 's#/deploy#/merge#g' plan.md && grep -c "/deploy" plan.md; grep -c "/merge" plan.md`;
    expect(isCompoundCommandFullyAllowed(command, settings, WIDENED_AUTO_APPROVE_PREFIXES)).toBe(true);
  });

  test("without the widened sed -i prefix, the same chain is not allowed", () => {
    const command = `sed -i 's#a#b#g' plan.md && grep -c "a" plan.md`;
    expect(isCompoundCommandFullyAllowed(command, settings)).toBe(false);
  });

  test("a chain of plain already-allowed reads needs no widening at all", () => {
    expect(isCompoundCommandFullyAllowed("git status && cat README.md; rg TODO", settings)).toBe(true);
  });

  test("any sub-command matching an ask rule blocks the whole chain, even mid-chain", () => {
    expect(isCompoundCommandFullyAllowed("npm ci && git commit -m x", settings)).toBe(false);
  });

  test("any sub-command matching a deny rule blocks the whole chain", () => {
    expect(isCompoundCommandFullyAllowed("cat README.md && rm -rf /tmp", settings)).toBe(false);
  });

  test("a sub-command not covered by any list blocks the whole chain", () => {
    expect(isCompoundCommandFullyAllowed("git status && curl https://example.com", settings)).toBe(false);
  });

  test("a sensitive path anywhere in the raw string blocks the whole chain regardless of which piece carries it", () => {
    const command = `cat README.md && sed -i 's#a#b#g' .env`;
    expect(isCompoundCommandFullyAllowed(command, settings, WIDENED_AUTO_APPROVE_PREFIXES)).toBe(false);
  });

  test("a command the splitter refuses to decompose is never allowed", () => {
    expect(isCompoundCommandFullyAllowed("cat README.md && echo $(whoami)", settings)).toBe(false);
  });

  test("an empty command is never allowed", () => {
    expect(isCompoundCommandFullyAllowed("", settings)).toBe(false);
    expect(isCompoundCommandFullyAllowed("   ", settings)).toBe(false);
  });

  test("cd is always a free pass regardless of its target path", () => {
    expect(isCompoundCommandFullyAllowed(`cd "C:\\data\\worktrees\\x" && git status`, settings)).toBe(true);
  });

  test("an exact (non-wildcard) allow rule like Bash(npm ci) still matches as a sub-command", () => {
    expect(isCompoundCommandFullyAllowed("npm ci && cat README.md", settings)).toBe(true);
  });

  // Regression: a first version's rule matcher only recognised a wildcard when it sat at the very
  // end of the pattern (` *`), so real settings.ts deny entries with the `*` mid-string -
  // `Bash(rm -rf /*)`, `Bash(curl * | sh)` - were silently parsed as literal strings requiring an
  // actual `*` character, i.e. dead rules that could never fire. Harmless today only because `rm`/
  // `curl` were never allow-listed either, so the final allow-only check still said "no" - but the
  // deny check itself was quietly doing nothing. These prove it now actually matches.
  test("a mid-string wildcard deny rule (Bash(rm -rf /*)) blocks its sub-command even if that sub-command is (hypothetically) also allow-listed", () => {
    const withRmAllowed: PermissionSettings = {
      permissions: { ...settings.permissions, allow: [...settings.permissions.allow, "Bash(rm -rf /*)"] },
    };
    expect(isCompoundCommandFullyAllowed("cat README.md && rm -rf /tmp/scratch", withRmAllowed)).toBe(false);
  });

  test("Bash(rm -rf /*) does not require a literal asterisk character to match", () => {
    const withRmAllowed: PermissionSettings = {
      permissions: { ...settings.permissions, allow: [...settings.permissions.allow, "Bash(rm -rf /*)"] },
    };
    // Would previously have been (wrongly) allowed: "rm -rf /tmp" never equals the literal string
    // "rm -rf /*", so the old exact-match branch let it fall straight through to the allow check.
    expect(isCompoundCommandFullyAllowed("rm -rf /tmp", withRmAllowed)).toBe(false);
  });
});
