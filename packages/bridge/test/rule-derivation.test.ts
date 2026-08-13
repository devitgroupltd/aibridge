import { describe, expect, test } from "bun:test";
import { deriveAlwaysRule, extractBashCommand, isCoveredByBareToolRule, ruleAlreadyCovered } from "../src/rule-derivation.ts";
import { generateSettings, type PermissionSettings } from "../src/settings.ts";

function bashPreview(command: string): string {
  return JSON.stringify({ command });
}

// extractBashCommand is the shared JSON-unwrap deriveAlwaysRule and compound-permission.ts's
// pipe-server.ts caller both need - one place that decides how "not really JSON" fails.
describe("extractBashCommand", () => {
  test("unwraps a valid {command} preview", () => {
    expect(extractBashCommand(bashPreview("git status"))).toBe("git status");
  });

  test("returns null for non-JSON input, rather than throwing", () => {
    expect(extractBashCommand("git status")).toBeNull();
  });

  test("returns null when the parsed JSON has no string command field", () => {
    expect(extractBashCommand(JSON.stringify({ command: 42 }))).toBeNull();
    expect(extractBashCommand(JSON.stringify({}))).toBeNull();
  });
});

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

  // Regression: `2>&1`/`>&2`/`&>file` are fd-duplication/redirect syntax, not a bare background
  // `&` - must not be treated as an ungeneralisable metacharacter (mirrors
  // compound-permission.test.ts's own case for the same bug, found live 2026-08-10).
  test.each([
    [bashPreview("bun run typecheck 2>&1 | tail -80")],
  ])("still bails on a real chain, not on the redirect syntax inside it: %p", (inputPreview) => {
    // The pipe in this example is a real chain - correctly null - but exercised via a command
    // shaped like the ones the bare-`&` bug used to false-positive on before the pipe was reached.
    expect(deriveAlwaysRule("Bash", inputPreview)).toBeNull();
  });

  test("2>&1 alone (no other metacharacter) is not treated as a bare background &", () => {
    expect(deriveAlwaysRule("Bash", bashPreview("bun run typecheck 2>&1"))).toBe("Bash(bun run *)");
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

/**
 * `codebase-hardening-plan.md` P0-7. This is the function that decides to auto-approve a real tool
 * call without showing the operator anything, so the cases that matter most here are the ones where
 * it must say **no** - `deny`/`ask` precedence and the sensitive-path guard. A silent-wrong here is
 * a permission prompt that never appears.
 */
describe("isCoveredByBareToolRule", () => {
  /** Mirrors what an `♾️ Always` tap on a `Write` card leaves behind: `deriveAlwaysRule` returns the
   * bare tool name for a non-Bash tool, and `addAlwaysRule` appends it to `allow`. */
  function settingsWithAllowed(tool: string): PermissionSettings {
    const base = generateSettings();
    return { ...base, permissions: { ...base.permissions, allow: [...base.permissions.allow, tool] } };
  }

  test("honours a bare tool rule the operator's own Always tap added", () => {
    expect(isCoveredByBareToolRule("Write", '{"file_path":"c:\\data\\worktrees\\x\\a.txt"}', settingsWithAllowed("Write"))).toBe(true);
  });

  test("round-trips deriveAlwaysRule's own output - what one writes, the other must recognise", () => {
    // The two functions are counterparts; this pins that invariant rather than restating the string.
    const rule = deriveAlwaysRule("NotebookEdit", '{"notebook_path":"nb.ipynb"}');
    expect(rule).toBe("NotebookEdit");
    const base = generateSettings();
    const settings = { ...base, permissions: { ...base.permissions, allow: [...base.permissions.allow, rule!] } };
    expect(isCoveredByBareToolRule("NotebookEdit", '{"notebook_path":"nb.ipynb"}', settings)).toBe(true);
  });

  test("refuses a tool that was never allow-listed", () => {
    expect(isCoveredByBareToolRule("Write", '{"file_path":"a.txt"}', generateSettings())).toBe(false);
  });

  test("refuses Bash outright - compound-permission.ts owns that path", () => {
    // A bare `Bash` allow rule isn't something deriveAlwaysRule can produce, and honouring one here
    // would auto-approve *any* command; the guard is unconditional rather than trusting that.
    const base = generateSettings();
    const settings = { ...base, permissions: { ...base.permissions, allow: [...base.permissions.allow, "Bash"] } };
    expect(isCoveredByBareToolRule("Bash", '{"command":"rm -rf /"}', settings)).toBe(false);
  });

  describe("precedence - deny and ask always win", () => {
    test("refuses when a scoped deny entry mentions the tool (the real Edit case)", () => {
      // The generated baseline carries Edit(.env), Edit(.env.*) and Edit(~/**). Deciding whether
      // *this* call matches one means reimplementing Claude Code's path globs, so it refuses instead
      // - Edit keeps prompting, exactly as it does today, rather than risking a wrong match.
      expect(isCoveredByBareToolRule("Edit", '{"file_path":"c:\\data\\worktrees\\x\\src\\a.ts"}', settingsWithAllowed("Edit"))).toBe(false);
    });

    test("refuses when a scoped deny entry mentions the tool, even for an obviously harmless path", () => {
      expect(isCoveredByBareToolRule("Read", '{"file_path":"README.md"}', settingsWithAllowed("Read"))).toBe(false);
    });

    test("refuses when a bare deny entry names the tool", () => {
      const base = generateSettings();
      const settings = {
        ...base,
        permissions: { ...base.permissions, deny: [...base.permissions.deny, "Write"], allow: [...base.permissions.allow, "Write"] },
      };
      expect(isCoveredByBareToolRule("Write", '{"file_path":"a.txt"}', settings)).toBe(false);
    });

    test("refuses when an ask entry mentions the tool, bare or scoped", () => {
      const base = generateSettings();
      const bare = { ...base, permissions: { ...base.permissions, ask: [...base.permissions.ask, "Write"], allow: [...base.permissions.allow, "Write"] } };
      const scoped = { ...base, permissions: { ...base.permissions, ask: [...base.permissions.ask, "Write(*.prod)"], allow: [...base.permissions.allow, "Write"] } };
      expect(isCoveredByBareToolRule("Write", '{"file_path":"a.txt"}', bare)).toBe(false);
      expect(isCoveredByBareToolRule("Write", '{"file_path":"a.txt"}', scoped)).toBe(false);
    });

    test("a tool whose name merely prefixes a denied one is unaffected", () => {
      // `Read(...)` must not gate `ReadNotebook`: the prefix check is deliberately `Tool(`, not a
      // bare startsWith on the name, or one deny rule would silently freeze unrelated tools.
      const settings = settingsWithAllowed("ReadNotebook");
      expect(isCoveredByBareToolRule("ReadNotebook", '{"path":"nb.ipynb"}', settings)).toBe(true);
    });
  });

  test("refuses a sensitive path even when nothing in deny/ask mentions the tool", () => {
    // Belt-and-braces, mirroring the Bash path: nothing in the baseline mentions `Write`, so only
    // this guard stands between an Always-tapped Write and ~/.ssh.
    const settings = settingsWithAllowed("Write");
    expect(isCoveredByBareToolRule("Write", '{"file_path":"~/.ssh/config"}', settings)).toBe(false);
    expect(isCoveredByBareToolRule("Write", '{"file_path":"c:\\x\\.env"}', settings)).toBe(false);
    expect(isCoveredByBareToolRule("Write", '{"file_path":"c:\\x\\id_rsa"}', settings)).toBe(false);
  });

  test("refuses an empty tool name rather than matching an empty allow entry", () => {
    const base = generateSettings();
    const settings = { ...base, permissions: { ...base.permissions, allow: [...base.permissions.allow, ""] } };
    expect(isCoveredByBareToolRule("", "{}", settings)).toBe(false);
  });

  test("honours an MCP tool's own fully-qualified name", () => {
    // Nothing special about the dunder form - it just has to survive the `Tool(` prefix check.
    expect(isCoveredByBareToolRule("mcp__plugin_x__do", '{"arg":1}', settingsWithAllowed("mcp__plugin_x__do"))).toBe(true);
  });
});
