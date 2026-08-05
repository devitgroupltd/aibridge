import { describe, expect, test } from "bun:test";
import {
  isHelpCommand,
  parseCommandsQuery,
  parseFleetCommand,
  parseSkillsQuery,
  renderAttach,
  renderBudget,
  renderHelp,
  renderLsTable,
  renderReposList,
  renderSettings,
  stripBotMention,
} from "../src/fleet-commands.ts";
import type { RepoEntry } from "../src/repos-registry.ts";
import type { SessionRow } from "../src/session-store.ts";

describe("isHelpCommand", () => {
  test("recognises /help, /?, /h", () => {
    for (const text of ["/help", "/?", "/h"]) {
      expect(isHelpCommand(text, true)).toBe(true);
    }
  });

  test("bare ? is help only from the control topic", () => {
    expect(isHelpCommand("?", true)).toBe(true);
    expect(isHelpCommand("?", false)).toBe(false);
  });

  test("/commands is no longer a /help alias - repurposed 2026-08-04", () => {
    expect(isHelpCommand("/commands", true)).toBe(false);
  });

  test("returns false for anything else, including a term (help never takes one)", () => {
    expect(isHelpCommand("/help deep", true)).toBe(false);
    expect(isHelpCommand("/ls", true)).toBe(false);
    expect(isHelpCommand("hello", true)).toBe(false);
  });
});

describe("parseCommandsQuery", () => {
  test("recognises a bare /commands with no term", () => {
    expect(parseCommandsQuery("/commands")).toEqual({ term: "" });
  });

  test("captures a trailing search term, trimmed", () => {
    expect(parseCommandsQuery("/commands   deep-check  ")).toEqual({ term: "deep-check" });
  });

  test("returns null for anything else", () => {
    expect(parseCommandsQuery("/skills")).toBeNull();
    expect(parseCommandsQuery("/help")).toBeNull();
    expect(parseCommandsQuery("hello")).toBeNull();
  });
});

describe("parseSkillsQuery", () => {
  test("recognises a bare /skills with no term", () => {
    expect(parseSkillsQuery("/skills")).toEqual({ term: "" });
  });

  test("captures a trailing search term, trimmed", () => {
    expect(parseSkillsQuery("/skills   plan  ")).toEqual({ term: "plan" });
  });

  test("returns null for anything else", () => {
    expect(parseSkillsQuery("/commands")).toBeNull();
    expect(parseSkillsQuery("hello")).toBeNull();
  });
});

describe("stripBotMention", () => {
  test("strips a bare command's bot-username suffix", () => {
    expect(stripBotMention("/help@om_aibridge_control_bot")).toBe("/help");
  });

  test("strips the suffix and preserves the argument text after it", () => {
    expect(stripBotMention("/kill@om_aibridge_control_bot my-slug")).toBe("/kill my-slug");
  });

  test("leaves a plain command with no mention untouched", () => {
    expect(stripBotMention("/kill my-slug")).toBe("/kill my-slug");
  });

  test("leaves non-command text untouched, including a genuine @mention", () => {
    expect(stripBotMention("hey @someone, can you check this?")).toBe("hey @someone, can you check this?");
  });

  test("only strips a mention immediately after the leading command, not one later in the text", () => {
    expect(stripBotMention("/new seowrite ask @alice to review")).toBe("/new seowrite ask @alice to review");
  });
});

describe("parseFleetCommand", () => {
  test("/new <repo> <prompt> with no model flag", () => {
    expect(parseFleetCommand("/new seowrite fix the login bug")).toEqual({
      kind: "new",
      repo: "seowrite",
      prompt: "fix the login bug",
      model: undefined,
    });
  });

  test("/new --opus <repo> <prompt>", () => {
    expect(parseFleetCommand("/new --opus seowrite fix the login bug")).toEqual({
      kind: "new",
      repo: "seowrite",
      prompt: "fix the login bug",
      model: "opus",
    });
  });

  test("/new with no prompt is invalid", () => {
    expect(parseFleetCommand("/new seowrite")).toBeNull();
    expect(parseFleetCommand("/new")).toBeNull();
  });

  test("/ls takes no argument", () => {
    expect(parseFleetCommand("/ls")).toEqual({ kind: "ls" });
  });

  test("/kill, /rm, /attach, /pause with and without a slug", () => {
    expect(parseFleetCommand("/kill fix-bug")).toEqual({ kind: "kill", slug: "fix-bug" });
    expect(parseFleetCommand("/kill")).toEqual({ kind: "kill", slug: undefined });
    expect(parseFleetCommand("/rm fix-bug")).toEqual({ kind: "rm", slug: "fix-bug" });
    expect(parseFleetCommand("/attach fix-bug")).toEqual({ kind: "attach", slug: "fix-bug" });
    expect(parseFleetCommand("/pause fix-bug")).toEqual({ kind: "pause", slug: "fix-bug" });
  });

  test("/usage with and without a slug", () => {
    expect(parseFleetCommand("/usage fix-bug")).toEqual({ kind: "usage", slug: "fix-bug" });
    expect(parseFleetCommand("/usage")).toEqual({ kind: "usage", slug: undefined });
  });

  test("/budget takes no argument", () => {
    expect(parseFleetCommand("/budget")).toEqual({ kind: "budget" });
  });

  test("/rm --dead requests the bulk dead-row filter", () => {
    expect(parseFleetCommand("/rm --dead")).toEqual({ kind: "rm", bulk: { mode: "dead" } });
  });

  test("/rm --prefix <text> requests the bulk prefix filter", () => {
    expect(parseFleetCommand("/rm --prefix say-hello")).toEqual({ kind: "rm", bulk: { mode: "prefix", prefix: "say-hello" } });
  });

  test("/rm --prefix with no argument falls through to the ordinary single-slug form", () => {
    expect(parseFleetCommand("/rm --prefix")).toEqual({ kind: "rm", slug: "--prefix" });
  });

  test("/kill --all requests the fleet-wide confirm flow", () => {
    expect(parseFleetCommand("/kill --all")).toEqual({ kind: "kill", all: true });
  });

  test("/rm --all requests the bulk all-row filter", () => {
    expect(parseFleetCommand("/rm --all")).toEqual({ kind: "rm", bulk: { mode: "all" } });
  });

  test("/restart takes no argument", () => {
    expect(parseFleetCommand("/restart")).toEqual({ kind: "restart" });
  });

  test("/settings takes no argument", () => {
    expect(parseFleetCommand("/settings")).toEqual({ kind: "settings" });
  });

  test("/autostart with no argument defaults to status", () => {
    expect(parseFleetCommand("/autostart")).toEqual({ kind: "autostart", action: "status" });
  });

  test("/autostart install and /autostart uninstall", () => {
    expect(parseFleetCommand("/autostart install")).toEqual({ kind: "autostart", action: "install" });
    expect(parseFleetCommand("/autostart uninstall")).toEqual({ kind: "autostart", action: "uninstall" });
  });

  test("/autostart with an unrecognised argument is invalid, not a different command", () => {
    expect(parseFleetCommand("/autostart bogus")).toBeNull();
  });

  test("/repos with no argument, or 'list', means list", () => {
    expect(parseFleetCommand("/repos")).toEqual({ kind: "repos", action: "list" });
    expect(parseFleetCommand("/repos list")).toEqual({ kind: "repos", action: "list" });
  });

  test("/repos add with name and path only", () => {
    expect(parseFleetCommand("/repos add seowrite c:\\data\\projects\\seowrite")).toEqual({
      kind: "repos",
      action: "add",
      name: "seowrite",
      path: "c:\\data\\projects\\seowrite",
      base: undefined,
      model: undefined,
    });
  });

  test("/repos add with --base and --model, in either order", () => {
    expect(parseFleetCommand("/repos add seowrite /repos/seowrite --base main --model opus")).toEqual({
      kind: "repos",
      action: "add",
      name: "seowrite",
      path: "/repos/seowrite",
      base: "main",
      model: "opus",
    });
    expect(parseFleetCommand("/repos add seowrite /repos/seowrite --model opus --base main")).toEqual({
      kind: "repos",
      action: "add",
      name: "seowrite",
      path: "/repos/seowrite",
      base: "main",
      model: "opus",
    });
  });

  test("/repos add with a missing name or path is invalid", () => {
    expect(parseFleetCommand("/repos add seowrite")).toBeNull();
    expect(parseFleetCommand("/repos add")).toBeNull();
  });

  test("/repos add rejects an unrecognised flag rather than silently dropping it", () => {
    expect(parseFleetCommand("/repos add seowrite /repos/seowrite --bogus x")).toBeNull();
  });

  test("/repos rm and /repos remove are synonyms", () => {
    expect(parseFleetCommand("/repos rm seowrite")).toEqual({ kind: "repos", action: "rm", name: "seowrite" });
    expect(parseFleetCommand("/repos remove seowrite")).toEqual({ kind: "repos", action: "rm", name: "seowrite" });
  });

  test("/repos rm with no name, or an unknown subcommand, is invalid", () => {
    expect(parseFleetCommand("/repos rm")).toBeNull();
    expect(parseFleetCommand("/repos bogus")).toBeNull();
  });

  test("returns null for anything that isn't one of these commands", () => {
    expect(parseFleetCommand("/model opus")).toBeNull();
    expect(parseFleetCommand("hello")).toBeNull();
    expect(parseFleetCommand("/lsx")).toBeNull();
  });
});

describe("renderHelp", () => {
  test("lists every fleet-scoped and session-scoped command", () => {
    const text = renderHelp();
    for (const cmd of ["/new", "/ls", "/kill", "/rm", "/attach", "/pause", "/usage", "/budget", "/restart", "/settings", "/repos", "/autostart"]) {
      expect(text).toContain(cmd);
    }
    expect(text).toContain("/model <");
    expect(text).toContain("/mode <");
    expect(text).toContain("/effort <");
  });
});

describe("renderSettings", () => {
  test("lists registered repos and the weighted concurrency budget", () => {
    const text = renderSettings(
      [
        { name: "seowrite", path: "c:\\data\\projects\\seowrite", base: "main", model: "sonnet" },
        { name: "aibridge", path: "c:\\data\\projects\\aibridge", base: "main" },
      ],
      { current: 1.5, cap: 4 },
    );
    expect(text).toContain("Registered repos (2):");
    expect(text).toContain("seowrite -&gt; c:\\data\\projects\\seowrite (default model: sonnet)");
    expect(text).toContain("aibridge -&gt; c:\\data\\projects\\aibridge");
    expect(text).toContain("Concurrency: 1.5 / 4 weighted units");
  });

  test("an empty registry says so instead of an empty list", () => {
    expect(renderSettings([], { current: 0, cap: 4 })).toContain("(none - add one to repos.toml, §7.5)");
  });
});

describe("renderReposList", () => {
  test("lists every repo with its base/model extras and the add/rm usage hint", () => {
    const repos: RepoEntry[] = [
      { name: "seowrite", path: "c:\\data\\projects\\seowrite", base: "main", model: "sonnet" },
      { name: "aibridge", path: "c:\\data\\projects\\aibridge" },
    ];
    const text = renderReposList(repos);
    expect(text).toContain("Registered repos (2):");
    expect(text).toContain("seowrite -&gt; c:\\data\\projects\\seowrite (base: main, default model: sonnet)");
    expect(text).toContain("aibridge -&gt; c:\\data\\projects\\aibridge");
    expect(text).toContain("/repos add &lt;name&gt; &lt;path&gt;");
    expect(text).toContain("/repos rm &lt;name&gt;");
  });

  test("an empty registry says so and still shows the usage hint", () => {
    const text = renderReposList([]);
    expect(text).toContain("Registered repos (0):");
    expect(text).toContain("none yet - /repos add");
    expect(text).toContain("/repos rm &lt;name&gt;");
  });
});

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "fix-bug",
    topicId: 2,
    sessionId: "sess-123",
    worktreePath: "c:\\data\\worktrees\\fix-bug",
    branch: "claude/fix-bug-1",
    repoPath: "c:\\data\\projects\\seowrite",
    model: "sonnet",
    ptyPid: 1234,
    state: "idle",
    turnCardMsg: null,
    paused: false,
    renamed: false,
    createdUtc: "2026-08-03T00:00:00.000Z",
    lastEventUtc: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderLsTable", () => {
  test("empty fleet", () => {
    expect(renderLsTable([], Date.parse("2026-08-03T00:10:00.000Z"))).toBe("No sessions.");
  });

  test("includes slug, state, model, branch and age; flags a paused session, column-aligned inside an HTML <pre> block", () => {
    const text = renderLsTable([row(), row({ slug: "other", paused: true })], Date.parse("2026-08-03T00:10:00.000Z"));
    expect(text.startsWith("<pre>")).toBe(true);
    expect(text.endsWith("</pre>")).toBe(true);
    expect(text).toContain("fix-bug");
    expect(text).toContain("idle");
    expect(text).toContain("sonnet");
    expect(text).toContain("claude/fix-bug-1");
    expect(text).toContain("10m");
    expect(text).toContain("other");
    expect(text).toContain("idle (paused)");
  });

  test("every data row and the header share the same line length (column padding)", () => {
    const text = renderLsTable([row(), row({ slug: "other", paused: true })], Date.parse("2026-08-03T00:10:00.000Z"));
    const inner = text.slice("<pre>".length, -"</pre>".length);
    const lineLengths = new Set(inner.split("\n").map((l) => l.length));
    expect(lineLengths.size).toBe(1);
  });

  test("HTML-escapes untrusted content (defense in depth - slugs/branches are already sanitized upstream)", () => {
    const text = renderLsTable([row({ branch: "claude/<b>x</b>" })], Date.parse("2026-08-03T00:10:00.000Z"));
    expect(text).not.toContain("<b>x</b>");
    expect(text).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("§5.7's cost column shows a session's lifetime spend, formatted as USD", () => {
    const text = renderLsTable([row()], Date.parse("2026-08-03T00:10:00.000Z"), new Map([["fix-bug", 1.5]]));
    expect(text).toContain("$1.50");
  });

  test("a session missing from the cost map (no session_id yet, or no recorded spend) shows $0.00", () => {
    const text = renderLsTable([row()], Date.parse("2026-08-03T00:10:00.000Z"));
    expect(text).toContain("$0.00");
  });
});

describe("renderBudget", () => {
  test("shows fleet 5h/7d totals and a sorted, nonzero-only per-session breakdown", () => {
    const text = renderBudget(3.5, 12.25, new Map([["a", 1], ["b", 2.5], ["c", 0]]));
    expect(text).toContain("$3.50");
    expect(text).toContain("$12.25");
    const bLine = text.indexOf("b: $2.50");
    const aLine = text.indexOf("a: $1.00");
    expect(bLine).toBeGreaterThan(-1);
    expect(aLine).toBeGreaterThan(bLine);
    expect(text).not.toContain("c: $0.00");
  });

  test("an all-idle fleet omits the per-session breakdown section entirely", () => {
    const text = renderBudget(0, 0, new Map([["a", 0]]));
    expect(text).not.toContain("by session");
  });
});

describe("renderAttach", () => {
  test("includes the slug, the tail (in an HTML <pre> block) and a claude --resume hint when a session_id is known", () => {
    const text = renderAttach(row(), "some ptv output");
    expect(text).toContain("fix-bug");
    expect(text).toContain("<pre>some ptv output</pre>");
    expect(text).toContain("claude --resume sess-123");
  });

  test("falls back to a placeholder hint with no session_id yet", () => {
    const text = renderAttach(row({ sessionId: null }), "output");
    expect(text).toContain("no session_id recorded yet");
  });

  test("HTML-escapes the PTY tail - untrusted terminal output must not inject markup", () => {
    const text = renderAttach(row(), "</pre><b>pwned</b>");
    expect(text).not.toContain("<b>pwned</b>");
    expect(text).toContain("&lt;/pre&gt;&lt;b&gt;pwned&lt;/b&gt;");
  });
});
