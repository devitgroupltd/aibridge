import { describe, expect, test } from "bun:test";
import {
  botCommandList,
  buildLsDetail,
  isKnownCommandText,
  isHelpCommand,
  newSessionContent,
  normalizeDashFlags,
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

describe("normalizeDashFlags", () => {
  test("rewrites en/em/figure dashes back to --, leaving ordinary ASCII hyphens alone", () => {
    expect(normalizeDashFlags("–all")).toBe("--all");
    expect(normalizeDashFlags("—all")).toBe("--all");
    expect(normalizeDashFlags("‒all")).toBe("--all");
    expect(normalizeDashFlags("--all")).toBe("--all");
    expect(normalizeDashFlags("--prefix say-hello")).toBe("--prefix say-hello");
  });

  // Operator-reported 2026-08-07: typing `--` reliably on a phone keyboard is its own small tax -
  // a single dash before a recognised flag word should mean the same thing as the double-dash form,
  // for every fleet command that has one, not just whichever got the bug report.
  test("rewrites a single dash before a known flag word to --, for every command that has one", () => {
    expect(normalizeDashFlags("-all")).toBe("--all");
    expect(normalizeDashFlags("-dead")).toBe("--dead");
    expect(normalizeDashFlags("-prefix foo")).toBe("--prefix foo");
    expect(normalizeDashFlags("-opus some repo prompt")).toBe("--opus some repo prompt");
    expect(normalizeDashFlags("name -base main -model sonnet")).toBe("name --base main --model sonnet");
  });

  test("leaves an ordinary word that merely starts with a flag word's letters alone", () => {
    // "-allocate" must not become "--allocate" of a flag that doesn't exist, and a real slug/prefix
    // argument that happens to start with one of these words (e.g. "-deadline") must survive too.
    expect(normalizeDashFlags("-allocate")).toBe("-allocate");
    expect(normalizeDashFlags("--prefix -deadline-fix")).toBe("--prefix -deadline-fix");
  });

  test("--all already double-dashed is left alone, not doubled again", () => {
    expect(normalizeDashFlags("--all")).toBe("--all");
    expect(normalizeDashFlags("--dead")).toBe("--dead");
  });
});

describe("parseFleetCommand with a single-dash flag", () => {
  test("/rm -all parses the same as /rm --all", () => {
    expect(parseFleetCommand("/rm -all")).toEqual(parseFleetCommand("/rm --all"));
    expect(parseFleetCommand("/rm -all")).toEqual({ kind: "rm", bulk: { mode: "all" } });
  });

  test("/kill -all parses the same as /kill --all", () => {
    expect(parseFleetCommand("/kill -all")).toEqual({ kind: "kill", all: true });
  });

  test("/rm -dead and /rm -prefix <text> also work single-dash", () => {
    expect(parseFleetCommand("/rm -dead")).toEqual({ kind: "rm", bulk: { mode: "dead" } });
    expect(parseFleetCommand("/rm -prefix foo")).toEqual({ kind: "rm", bulk: { mode: "prefix", prefix: "foo" } });
  });
});

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

describe("newSessionContent", () => {
  // The 2026-08-07 language-mirroring fix: an NL-router-matched `/new` attaches the operator's raw
  // original message as `sourceText` (index.ts's routeOrFallback) precisely because `prompt` is an
  // emergent English paraphrase - so the session's actual first turn must prefer `sourceText`.
  test("prefers sourceText over prompt when both are present", () => {
    expect(newSessionContent({ prompt: "check what still needs to be done", sourceText: "проверь, что еще нужно сделать" })).toBe(
      "проверь, что еще нужно сделать",
    );
  });

  // A typed `/new <repo> <task>` command never sets sourceText - prompt there is already the
  // operator's verbatim text (parseNew), so falling back to it is correct, not a compromise.
  test("falls back to prompt when sourceText is absent", () => {
    expect(newSessionContent({ prompt: "fix the login bug" })).toBe("fix the login bug");
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

  test("/stop with and without a slug", () => {
    expect(parseFleetCommand("/stop fix-bug")).toEqual({ kind: "stop", slug: "fix-bug" });
    expect(parseFleetCommand("/stop")).toEqual({ kind: "stop", slug: undefined });
  });

  test("/budget takes no argument", () => {
    expect(parseFleetCommand("/budget")).toEqual({ kind: "budget" });
  });

  test("/os shutdown|reboot|cancel", () => {
    expect(parseFleetCommand("/os shutdown")).toEqual({ kind: "os", action: "shutdown" });
    expect(parseFleetCommand("/os reboot")).toEqual({ kind: "os", action: "reboot" });
    expect(parseFleetCommand("/os cancel")).toEqual({ kind: "os", action: "cancel" });
  });

  test("/os with no argument, or an unrecognised argument, is invalid - no safe default", () => {
    expect(parseFleetCommand("/os")).toBeNull();
    expect(parseFleetCommand("/os poweroff")).toBeNull();
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

  test("/kill --all --force skips the confirm flow", () => {
    expect(parseFleetCommand("/kill --all --force")).toEqual({ kind: "kill", all: true, force: true });
    expect(parseFleetCommand("/kill --force --all")).toEqual({ kind: "kill", all: true, force: true });
  });

  test("/rm --all --force skips the confirm flow", () => {
    expect(parseFleetCommand("/rm --all --force")).toEqual({ kind: "rm", bulk: { mode: "all" }, force: true });
  });

  test("-force and -f are recognised as --force aliases", () => {
    expect(parseFleetCommand("/kill --all -force")).toEqual({ kind: "kill", all: true, force: true });
    expect(parseFleetCommand("/kill --all -f")).toEqual({ kind: "kill", all: true, force: true });
    expect(parseFleetCommand("/rm --all -f")).toEqual({ kind: "rm", bulk: { mode: "all" }, force: true });
  });

  test("--force with no --all is a no-op flag on the single-slug/bulk forms, stripped rather than rejected", () => {
    expect(parseFleetCommand("/kill fix-bug --force")).toEqual({ kind: "kill", slug: "fix-bug" });
    expect(parseFleetCommand("/rm --dead --force")).toEqual({ kind: "rm", bulk: { mode: "dead" } });
  });

  test("a mobile keyboard's autocorrected dash (en/em/figure) in place of -- is normalized before parsing", () => {
    expect(parseFleetCommand("/kill –all")).toEqual({ kind: "kill", all: true });
    expect(parseFleetCommand("/rm —all")).toEqual({ kind: "rm", bulk: { mode: "all" } });
    expect(parseFleetCommand("/rm ‒dead")).toEqual({ kind: "rm", bulk: { mode: "dead" } });
    expect(parseFleetCommand("/rm —prefix say-hello")).toEqual({ kind: "rm", bulk: { mode: "prefix", prefix: "say-hello" } });
    expect(parseFleetCommand("/repos add seowrite –base main —model opus")).toEqual({
      kind: "repos",
      action: "add",
      name: "seowrite",
      path: undefined,
      base: "main",
      model: "opus",
    });
    expect(parseFleetCommand("/new –opus seowrite fix it")).toEqual({ kind: "new", repo: "seowrite", prompt: "fix it", model: "opus" });
  });

  test("/restart takes no argument", () => {
    expect(parseFleetCommand("/restart")).toEqual({ kind: "restart" });
  });

  test("/deploy requires a slug", () => {
    expect(parseFleetCommand("/deploy fix-the-thing")).toEqual({ kind: "deploy", slug: "fix-the-thing" });
    expect(parseFleetCommand("/deploy")).toBeNull();
    expect(parseFleetCommand("/deploy   ")).toBeNull();
  });

  test("/ship takes an optional slug - bare resolves later against currentSlug, not left to fall through as chat text", () => {
    expect(parseFleetCommand("/ship fix-the-thing")).toEqual({ kind: "ship", slug: "fix-the-thing" });
    expect(parseFleetCommand("/ship")).toEqual({ kind: "ship", slug: undefined });
    expect(parseFleetCommand("/ship   ")).toEqual({ kind: "ship", slug: undefined });
  });

  test("/detail bare reports (no slug, no level)", () => {
    expect(parseFleetCommand("/detail")).toEqual({ kind: "detail", slug: undefined, level: undefined });
  });

  test("/detail <level> sets, session-topic bare form", () => {
    expect(parseFleetCommand("/detail full")).toEqual({ kind: "detail", slug: undefined, level: "full" });
    expect(parseFleetCommand("/detail compact")).toEqual({ kind: "detail", slug: undefined, level: "compact" });
  });

  test("/detail <slug> reports that session, control-topic form", () => {
    expect(parseFleetCommand("/detail fix-bug")).toEqual({ kind: "detail", slug: "fix-bug", level: undefined });
  });

  test("/detail <slug> <level> sets that session", () => {
    expect(parseFleetCommand("/detail fix-bug full")).toEqual({ kind: "detail", slug: "fix-bug", level: "full" });
  });

  test("/detail with a bad level (as a two-token form) is invalid", () => {
    expect(parseFleetCommand("/detail fix-bug bogus")).toBeNull();
  });

  test("/verbose follows the same shape as /detail, with on|off", () => {
    expect(parseFleetCommand("/verbose")).toEqual({ kind: "verbose", slug: undefined, on: undefined });
    expect(parseFleetCommand("/verbose on")).toEqual({ kind: "verbose", slug: undefined, on: true });
    expect(parseFleetCommand("/verbose off")).toEqual({ kind: "verbose", slug: undefined, on: false });
    expect(parseFleetCommand("/verbose fix-bug")).toEqual({ kind: "verbose", slug: "fix-bug", on: undefined });
    expect(parseFleetCommand("/verbose fix-bug on")).toEqual({ kind: "verbose", slug: "fix-bug", on: true });
    expect(parseFleetCommand("/verbose fix-bug bogus")).toBeNull();
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

  test("/assist with no argument defaults to status", () => {
    expect(parseFleetCommand("/assist")).toEqual({ kind: "assist", action: "status" });
  });

  test("/assist on and /assist off", () => {
    expect(parseFleetCommand("/assist on")).toEqual({ kind: "assist", action: "on" });
    expect(parseFleetCommand("/assist off")).toEqual({ kind: "assist", action: "off" });
  });

  test("/assist with an unrecognised argument is invalid, not a different command", () => {
    expect(parseFleetCommand("/assist bogus")).toBeNull();
  });

  test("/router with no argument defaults to status", () => {
    expect(parseFleetCommand("/router")).toEqual({ kind: "router", action: "status" });
  });

  test("/router api and /router cli", () => {
    expect(parseFleetCommand("/router api")).toEqual({ kind: "router", action: "api" });
    expect(parseFleetCommand("/router cli")).toEqual({ kind: "router", action: "cli" });
  });

  test("/router with an unrecognised argument is invalid, not a different command", () => {
    expect(parseFleetCommand("/router bogus")).toBeNull();
  });

  test("/voiceconfirm with no argument defaults to status", () => {
    expect(parseFleetCommand("/voiceconfirm")).toEqual({ kind: "voiceconfirm", action: "status" });
  });

  test("/voiceconfirm on and /voiceconfirm off", () => {
    expect(parseFleetCommand("/voiceconfirm on")).toEqual({ kind: "voiceconfirm", action: "on" });
    expect(parseFleetCommand("/voiceconfirm off")).toEqual({ kind: "voiceconfirm", action: "off" });
  });

  test("/voiceconfirm with an unrecognised argument is invalid, not a different command", () => {
    expect(parseFleetCommand("/voiceconfirm bogus")).toBeNull();
  });

  test("/voiceconfirm is a distinct command from /voice, not a model name collision", () => {
    expect(parseFleetCommand("/voice off")).toEqual({ kind: "voice", model: "off" });
    expect(parseFleetCommand("/voiceconfirm off")).toEqual({ kind: "voiceconfirm", action: "off" });
  });

  test("/default with no argument (or 'status') reports the status category", () => {
    expect(parseFleetCommand("/default")).toEqual({ kind: "default", category: "status" });
    expect(parseFleetCommand("/default status")).toEqual({ kind: "default", category: "status" });
  });

  test("/default mode / /default effort with no value shows that category's picker (value undefined)", () => {
    expect(parseFleetCommand("/default mode")).toEqual({ kind: "default", category: "mode" });
    expect(parseFleetCommand("/default effort")).toEqual({ kind: "default", category: "effort" });
  });

  test("/default mode <value> accepts every real mode", () => {
    expect(parseFleetCommand("/default mode manual")).toEqual({ kind: "default", category: "mode", value: "manual" });
    expect(parseFleetCommand("/default mode acceptEdits")).toEqual({ kind: "default", category: "mode", value: "acceptEdits" });
    expect(parseFleetCommand("/default mode plan")).toEqual({ kind: "default", category: "mode", value: "plan" });
    expect(parseFleetCommand("/default mode auto")).toEqual({ kind: "default", category: "mode", value: "auto" });
  });

  test("/default effort <value> accepts every real effort level", () => {
    expect(parseFleetCommand("/default effort low")).toEqual({ kind: "default", category: "effort", value: "low" });
    expect(parseFleetCommand("/default effort medium")).toEqual({ kind: "default", category: "effort", value: "medium" });
    expect(parseFleetCommand("/default effort high")).toEqual({ kind: "default", category: "effort", value: "high" });
    expect(parseFleetCommand("/default effort xhigh")).toEqual({ kind: "default", category: "effort", value: "xhigh" });
    expect(parseFleetCommand("/default effort max")).toEqual({ kind: "default", category: "effort", value: "max" });
  });

  test("/default with an unrecognised category or value is invalid, not a different command", () => {
    expect(parseFleetCommand("/default bogus")).toBeNull();
    expect(parseFleetCommand("/default mode bogus")).toBeNull();
    expect(parseFleetCommand("/default effort bogus")).toBeNull();
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

  test("/repos add with no path leaves it undefined for index.ts to infer", () => {
    expect(parseFleetCommand("/repos add seowrite")).toEqual({
      kind: "repos",
      action: "add",
      name: "seowrite",
      path: undefined,
      base: undefined,
      model: undefined,
    });
  });

  test("/repos add with no path but flags right after the name doesn't swallow a flag as the path", () => {
    expect(parseFleetCommand("/repos add seowrite --base main")).toEqual({
      kind: "repos",
      action: "add",
      name: "seowrite",
      path: undefined,
      base: "main",
      model: undefined,
    });
  });

  test("/repos add with a git URL as the path", () => {
    expect(parseFleetCommand("/repos add seowrite https://github.com/example/seowrite.git")).toEqual({
      kind: "repos",
      action: "add",
      name: "seowrite",
      path: "https://github.com/example/seowrite.git",
      base: undefined,
      model: undefined,
    });
  });

  test("/repos add with a missing name is invalid", () => {
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
    for (const cmd of [
      "/new",
      "/ls",
      "/kill",
      "/rm",
      "/attach",
      "/pause",
      "/usage",
      "/budget",
      "/restart",
      "/deploy",
      "/ship",
      "/detail",
      "/verbose",
      "/settings",
      "/repos",
      "/autostart",
      "/assist",
      "/router",
      "/default",
    ]) {
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
    expect(text).toContain("/repos add &lt;name&gt; [path|git-url]");
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
    feedDetail: "compact",
    feedVerbose: false,
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

  test("a detail map appends a waiting/running line under the table, HTML-escaped", () => {
    const text = renderLsTable(
      [row()],
      Date.parse("2026-08-03T00:10:00.000Z"),
      undefined,
      new Map([["fix-bug", "running: Edit <b>x</b>.ts (12s)"]]),
    );
    expect(text).toContain("fix-bug: running: Edit &lt;b&gt;x&lt;/b&gt;.ts (12s)");
  });

  test("no detail section at all when the map is empty or omitted", () => {
    const withoutMap = renderLsTable([row()], Date.parse("2026-08-03T00:10:00.000Z"));
    const withEmptyMap = renderLsTable([row()], Date.parse("2026-08-03T00:10:00.000Z"), undefined, new Map());
    expect(withoutMap.endsWith("</pre>")).toBe(true);
    expect(withEmptyMap.endsWith("</pre>")).toBe(true);
  });
});

describe("buildLsDetail", () => {
  const nowMs = Date.parse("2026-08-03T00:10:00.000Z");
  // Deliberately a wildly different magnitude from `nowMs` - `PermissionRegistry`/`AskRegistry`
  // stamp `createdAt` with the monotonic clock (§7.4, process-uptime-based), not wall time, so a
  // test that picked a monotonic value close to `nowMs` would pass even with the two clocks
  // accidentally swapped in the implementation (the exact bug this caught live 2026-08-05).
  const monotonicNowMs = 500_000;

  test("a working session with a running activity line shows what it's doing and for how long", () => {
    const detail = buildLsDetail(
      [row({ state: "working" })],
      nowMs,
      monotonicNowMs,
      new Map([["fix-bug", { turnActive: true, turnStartedAtMs: nowMs - 12_000, lines: [{ summary: "Edit src/foo.ts", status: "running" }] }]]),
      [],
      [],
    );
    expect(detail.get("fix-bug")).toBe("running: Edit src/foo.ts (12s)");
  });

  test("a working session with no running line yet (between hook events) gets no detail", () => {
    const detail = buildLsDetail(
      [row({ state: "working" })],
      nowMs,
      monotonicNowMs,
      new Map([["fix-bug", { turnActive: true, turnStartedAtMs: nowMs, lines: [] }]]),
      [],
      [],
    );
    expect(detail.has("fix-bug")).toBe(false);
  });

  test("an awaiting_input session with a pending permission names the tool and preview, timed off the monotonic clock", () => {
    const detail = buildLsDetail(
      [row({ state: "awaiting_input" })],
      nowMs,
      monotonicNowMs,
      new Map(),
      [{ slug: "fix-bug", toolName: "Bash", inputPreview: "npm test", createdAt: monotonicNowMs - 5_000 }],
      [],
    );
    expect(detail.get("fix-bug")).toBe("waiting: permission (Bash: npm test) - 5s");
  });

  test("an awaiting_input session with a pending question names it, preferring the first unanswered one", () => {
    const detail = buildLsDetail(
      [row({ state: "awaiting_input" })],
      nowMs,
      monotonicNowMs,
      new Map(),
      [],
      [
        {
          slug: "fix-bug",
          createdAt: monotonicNowMs - 30_000,
          questions: [
            { question: "Use library A or B?", answerLabel: "A" },
            { question: "Add tests?" },
          ],
        },
      ],
    );
    expect(detail.get("fix-bug")).toBe("waiting: question (Add tests?) - 30s");
  });

  test("an awaiting_input session with neither a pending permission nor ask falls back to a generic wait", () => {
    const detail = buildLsDetail([row({ state: "awaiting_input" })], nowMs, monotonicNowMs, new Map(), [], []);
    expect(detail.get("fix-bug")).toBe("waiting: reply");
  });

  test("idle/dead/quota_stopped sessions get no detail at all", () => {
    const detail = buildLsDetail(
      [row({ state: "idle" }), row({ slug: "d", state: "dead" }), row({ slug: "q", state: "quota_stopped" })],
      nowMs,
      monotonicNowMs,
      new Map(),
      [],
      [],
    );
    expect(detail.size).toBe(0);
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

/**
 * The inbound gate for a topic with no route and no session row uses this instead of a bare "starts
 * with /" check: anything unrecognised there falls through to the NL router and spends an LLM call
 * (on the `cli` backend, ~20-30k tokens) answering something no session can act on. Keyed off
 * `botCommandList()` so it can't drift from the real command set.
 */
describe("isKnownCommandText", () => {
  test("recognises every command the bot actually advertises", () => {
    for (const { command } of botCommandList()) {
      expect(isKnownCommandText(`/${command}`)).toBe(true);
      expect(isKnownCommandText(`/${command} with args`)).toBe(true);
    }
  });

  test("tolerates Telegram's @botname suffix and a phone keyboard's capitalisation", () => {
    expect(isKnownCommandText("/ls@aibridge_control_bot")).toBe(true);
    expect(isKnownCommandText("/Ls")).toBe(true);
    expect(isKnownCommandText("  /ls  ")).toBe(true);
  });

  test("rejects free text, a bare slash, and an unrecognised slash-word", () => {
    expect(isKnownCommandText("just talking in this topic")).toBe(false);
    expect(isKnownCommandText("/")).toBe(false);
    expect(isKnownCommandText("/not-a-real-command")).toBe(false);
    expect(isKnownCommandText("hello /ls")).toBe(false); // not the first token
    expect(isKnownCommandText(undefined)).toBe(false);
    expect(isKnownCommandText("")).toBe(false);
  });

  test("a path-looking string is not mistaken for a command", () => {
    // Git Bash's own MSYS path conversion turns "/ls" into "C:/Program Files/Git/ls" - and a session
    // topic legitimately carries absolute paths in prose.
    expect(isKnownCommandText("/usr/local/bin/thing")).toBe(false);
    expect(isKnownCommandText("C:/Program Files/Git/ls")).toBe(false);
  });
});
