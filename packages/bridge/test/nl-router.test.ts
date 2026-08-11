import { describe, expect, test } from "bun:test";
import { botCommandList } from "../src/fleet-commands.ts";
import { buildAnswerViaCliArgs, buildRouteViaCliArgs, buildSystemInstructions, mapRouterOutput, ROUTER_KINDS } from "../src/nl-router.ts";

const CONTROL: { isControl: true; hasSession: false } = { isControl: true, hasSession: false };
const SESSION: { isControl: false; hasSession: true } = { isControl: false, hasSession: true };

/**
 * A literal copy of `fleet-commands.ts`'s `FleetCommand["kind"]` union, kept here on purpose - not
 * imported, so this test can't pass by accident just because `nl-router.ts` and `fleet-commands.ts`
 * happen to agree. If someone adds an 19th fleet command and forgets `ROUTER_KINDS`, this list
 * silently drifts out of sync with the real union too - but TypeScript's own exhaustiveness check
 * on `fleet-commands.ts`'s `parseFleetCommand` switch already catches *that* half; this test's job
 * is only the half TypeScript can't check by itself, namely "does `nl-router.ts` know about it."
 */
const ALL_FLEET_COMMAND_KINDS = [
  "new",
  "ls",
  "kill",
  "rm",
  "attach",
  "pause",
  "resume",
  "usage",
  "budget",
  "restart",
  "merge",
  "detail",
  "verbose",
  "settings",
  "autostart",
  "repos",
  "voice",
  "voiceconfirm",
  "assist",
  "router",
] as const;

describe("ROUTER_KINDS completeness", () => {
  test("every FleetCommand kind has a matching router kind - catches the class of gap that let /help/etc. go unrouted", () => {
    const missing = ALL_FLEET_COMMAND_KINDS.filter((kind) => !(ROUTER_KINDS as readonly string[]).includes(kind));
    expect(missing).toEqual([]);
  });

  test("the fixed always-available commands outside both unions are also covered", () => {
    const kinds: readonly string[] = ROUTER_KINDS;
    for (const kind of ["help", "about", "commands", "skills", "builtin", "browse", "find"]) {
      expect(kinds.includes(kind)).toBe(true);
    }
  });

  /**
   * The two lists above are hand-copied - useful as a readable spec, but neither would fail if a
   * *future* new command were added to `botCommandList()` (fleet-commands.ts, the single real
   * source of every command this bot recognises - it drives Telegram's own "/" autocomplete) and
   * simply forgotten in `nl-router.ts`, since a hand-copied list drifts in lockstep with the very
   * mistake it's meant to catch. This test is sourced from `botCommandList()` directly, so it's the
   * one that actually would have failed on the day `/browse`/`/find` shipped without a router entry.
   * `COMMAND_TO_ROUTER_KIND` covers the few real renames: `/model`/`/mode`/`/effort` map to a
   * `session_*`-prefixed kind (avoids a schema field collision with `/new`'s own `model`), and
   * `/compact`/`/clear` both map to the single `builtin` kind (their distinction is `builtinName`,
   * a field, not a separate `kind`).
   */
  const COMMAND_TO_ROUTER_KIND: Record<string, string> = {
    model: "session_model",
    mode: "session_mode",
    effort: "session_effort",
    compact: "builtin",
    clear: "builtin",
    remove: "rm",
  };

  /** `/retry` (retry-store.ts) is one deliberate exception: `isRetryPhrase` intercepts it (and its
   * "try again"/"do it again" equivalents) in `dispatchInboundMessage` *before* the NL router is
   * ever consulted, and what it re-arms is per-topic in-memory state (`retryStore`) the router has
   * no way to produce as structured output anyway - there is no `FleetCommand`/`SessionCommand`
   * shape for "the thing that just expired here" to map to.
   *
   * `/os` (os-power-commands.ts) is the second, for a different reason: it's a real `FleetCommand`
   * kind with a real router-shaped output, deliberately kept OUT of `ROUTER_KINDS` on purpose - a
   * misparsed natural-language phrase must never be able to shut down or reboot the host machine,
   * confirmed with the operator (plans/swirling-crafting-pixel.md). Exact `/os shutdown|reboot|cancel`
   * syntax only. */
  const NEVER_ROUTED = new Set(["retry", "os"]);

  test("every command in botCommandList() (Telegram's own autocomplete source) maps to a known router kind", () => {
    const kinds: readonly string[] = ROUTER_KINDS;
    const missing = botCommandList()
      .map((c) => c.command)
      .filter((command) => !NEVER_ROUTED.has(command))
      .filter((command) => !kinds.includes(COMMAND_TO_ROUTER_KIND[command] ?? command));
    expect(missing).toEqual([]);
  });
});

describe("mapRouterOutput - one case per kind", () => {
  test("new: requires at least a prompt", () => {
    expect(mapRouterOutput({ kind: "new", repo: "seowrite", prompt: "fix the bug" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "new", repo: "seowrite", prompt: "fix the bug", model: undefined },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "new", repo: "seowrite" }, CONTROL)).toEqual({ matched: false });
  });

  test("new: a missing repo auto-fills to the only registered repo - no other repo could have been meant", () => {
    expect(mapRouterOutput({ kind: "new", prompt: "analyze this alarm" }, { ...CONTROL, repoNames: ["aibridge"] })).toEqual({
      matched: true,
      command: { kind: "new", repo: "aibridge", prompt: "analyze this alarm", model: undefined },
      destructive: false,
    });
  });

  test("new: a missing repo with 2+ registered is a real ambiguity - new_pick_repo, not a guess", () => {
    expect(mapRouterOutput({ kind: "new", prompt: "analyze this alarm" }, { ...CONTROL, repoNames: ["aibridge", "seowrite"] })).toEqual({
      matched: true,
      command: { kind: "new_pick_repo", prompt: "analyze this alarm", model: undefined },
      destructive: false,
    });
  });

  test("new: a missing repo with none registered (or no hint given) is still a no-match, same as today", () => {
    expect(mapRouterOutput({ kind: "new", prompt: "analyze this alarm" }, CONTROL)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "new", prompt: "analyze this alarm" }, { ...CONTROL, repoNames: [] })).toEqual({ matched: false });
  });

  test("new: rejected outside the control topic, same scoping as dispatchInboundMessage", () => {
    expect(mapRouterOutput({ kind: "new", repo: "seowrite", prompt: "fix it" }, SESSION)).toEqual({ matched: false });
  });

  test("ls: no fields needed", () => {
    expect(mapRouterOutput({ kind: "ls" }, CONTROL)).toEqual({ matched: true, command: { kind: "ls" }, destructive: false });
  });

  test("kill: single-slug is destructive even without --all", () => {
    expect(mapRouterOutput({ kind: "kill", slug: "fix-bug" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "kill", slug: "fix-bug", all: false },
      destructive: true,
    });
  });

  test("kill --all is NOT destructive here - it already gets its own confirm card the moment it executes (fleet-confirm.ts)", () => {
    expect(mapRouterOutput({ kind: "kill", all: true }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "kill", slug: undefined, all: true },
      destructive: false,
    });
  });

  // "stop asking me for permission on this one" is the sentence isDestructive's own comment names as
  // `mode auto`'s most plausible fuzzy match - it describes this command even more exactly.
  test("auto <category> on is destructive - one gate covers both categories", () => {
    for (const category of ["permission", "answer"] as const) {
      expect(mapRouterOutput({ kind: "auto", autoCategory: category, slug: "fix-bug", on: true }, SESSION)).toEqual({
        matched: true,
        command: { kind: "auto", category, slug: "fix-bug", all: false, on: true },
        destructive: true,
      });
    }
  });

  test("auto <category> off and the bare status form are not destructive - only turning a guard off is", () => {
    expect(mapRouterOutput({ kind: "auto", autoCategory: "permission", slug: "fix-bug", on: false }, SESSION)).toMatchObject({ matched: true, destructive: false });
    expect(mapRouterOutput({ kind: "auto", autoCategory: "permission", slug: "fix-bug" }, SESSION)).toMatchObject({ matched: true, destructive: false });
  });

  test("auto --all on is NOT destructive here - it posts its own confirm card, same as kill --all", () => {
    expect(mapRouterOutput({ kind: "auto", autoCategory: "permission", all: true, on: true }, CONTROL)).toMatchObject({ matched: true, destructive: false });
  });

  test("auto with a missing or unknown category does not fall through to either one", () => {
    expect(mapRouterOutput({ kind: "auto", on: true }, SESSION).matched).toBe(false);
    expect(mapRouterOutput({ kind: "auto", autoCategory: "ship", on: true }, SESSION).matched).toBe(false);
  });

  test("default permission|answer take their value from `on`, and a missing one is the status form", () => {
    expect(mapRouterOutput({ kind: "default", defaultCategory: "permission", on: true }, CONTROL)).toMatchObject({
      matched: true,
      command: { kind: "default", category: "permission", value: true },
    });
    expect(mapRouterOutput({ kind: "default", defaultCategory: "answer", on: false }, CONTROL)).toMatchObject({
      matched: true,
      command: { kind: "default", category: "answer", value: false },
    });
    expect(mapRouterOutput({ kind: "default", defaultCategory: "permission" }, CONTROL)).toMatchObject({
      matched: true,
      command: { kind: "default", category: "permission", value: undefined },
    });
  });

  // Wider than `/auto <category> on`, not narrower: it applies to every session created from that
  // point on, and unlike `--all` it posts no confirm card of its own.
  test("default permission|answer ON is destructive; off and the bare form are not", () => {
    expect(mapRouterOutput({ kind: "default", defaultCategory: "permission", on: true }, CONTROL)).toMatchObject({ matched: true, destructive: true });
    expect(mapRouterOutput({ kind: "default", defaultCategory: "answer", on: true }, CONTROL)).toMatchObject({ matched: true, destructive: true });
    expect(mapRouterOutput({ kind: "default", defaultCategory: "permission", on: false }, CONTROL)).toMatchObject({ matched: true, destructive: false });
    expect(mapRouterOutput({ kind: "default", defaultCategory: "permission" }, CONTROL)).toMatchObject({ matched: true, destructive: false });
    // The pre-existing categories keep their own (non-destructive) treatment.
    expect(mapRouterOutput({ kind: "default", defaultCategory: "mode", mode: "auto" }, CONTROL)).toMatchObject({ matched: true, destructive: false });
  });

  test("the schema the model actually sees offers all four defaultCategory values", () => {
    // Asserted through the CLI arg builder because that's the only exported surface the schema
    // reaches - a value the mapper handles but the schema never offers is one the model can't emit.
    const args = buildRouteViaCliArgs("make new sessions auto-approve", CONTROL, "claude-haiku-4-5-20251001").join(" ");
    expect(args).toContain('"mode","effort","permission","answer"');
  });

  // The regression test for "auto reads like default, so group it with default": doing that filters
  // it out of every session topic, killing the feature's most likely natural-language invocation.
  test("auto is offered in a session topic as well as the control topic", () => {
    expect(mapRouterOutput({ kind: "auto", autoCategory: "permission", on: true }, SESSION).matched).toBe(true);
    expect(mapRouterOutput({ kind: "auto", autoCategory: "permission", slug: "fix-bug", on: true }, CONTROL).matched).toBe(true);
  });

  test("kill: bare (no slug) inside a session topic - relies on dispatch's own currentSlug fallback", () => {
    expect(mapRouterOutput({ kind: "kill" }, SESSION)).toEqual({
      matched: true,
      command: { kind: "kill", slug: undefined, all: false },
      destructive: true,
    });
  });

  test("rm: --all bulk is NOT destructive here either - same fleet-confirm.ts double-confirm reasoning as kill --all", () => {
    expect(mapRouterOutput({ kind: "rm", all: true }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "rm", slug: undefined, bulk: { mode: "all" } },
      destructive: false,
    });
  });

  test("rm: --dead bulk", () => {
    expect(mapRouterOutput({ kind: "rm", bulkMode: "dead" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "rm", slug: undefined, bulk: { mode: "dead" } },
      destructive: true,
    });
  });

  test("rm: --prefix bulk requires bulkPrefix", () => {
    expect(mapRouterOutput({ kind: "rm", bulkMode: "prefix", bulkPrefix: "fix-" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "rm", slug: undefined, bulk: { mode: "prefix", prefix: "fix-" } },
      destructive: true,
    });
    // bulkMode 'prefix' with no bulkPrefix falls through to a plain single-slug rm, not a crash.
    expect(mapRouterOutput({ kind: "rm", bulkMode: "prefix" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "rm", slug: undefined, bulk: undefined },
      destructive: true,
    });
  });

  test("attach/pause/usage: optional slug, none destructive", () => {
    expect(mapRouterOutput({ kind: "attach", slug: "fix-bug" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "attach", slug: "fix-bug" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "pause" }, SESSION)).toEqual({ matched: true, command: { kind: "pause", slug: undefined }, destructive: false });
    expect(mapRouterOutput({ kind: "usage" }, SESSION)).toEqual({ matched: true, command: { kind: "usage", slug: undefined }, destructive: false });
  });

  test("budget: control-topic only", () => {
    expect(mapRouterOutput({ kind: "budget" }, CONTROL)).toEqual({ matched: true, command: { kind: "budget" }, destructive: false });
    expect(mapRouterOutput({ kind: "budget" }, SESSION)).toEqual({ matched: false });
  });

  test("restart and merge are destructive", () => {
    expect(mapRouterOutput({ kind: "restart" }, CONTROL)).toEqual({ matched: true, command: { kind: "restart" }, destructive: true });
    expect(mapRouterOutput({ kind: "merge", slug: "fix-bug" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "merge", slug: "fix-bug" },
      destructive: true,
    });
    // merge requires a slug - there's nothing sensible to merge without one.
    expect(mapRouterOutput({ kind: "merge" }, CONTROL)).toEqual({ matched: false });
  });

  test("detail and verbose: not destructive, validate their enum fields", () => {
    expect(mapRouterOutput({ kind: "detail", slug: "fix-bug", level: "full" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "detail", slug: "fix-bug", level: "full" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "verbose", on: true }, SESSION)).toEqual({
      matched: true,
      command: { kind: "verbose", slug: undefined, on: true },
      destructive: false,
    });
  });

  test("settings, autostart, voice: not destructive", () => {
    expect(mapRouterOutput({ kind: "settings" }, CONTROL)).toEqual({ matched: true, command: { kind: "settings" }, destructive: false });
    expect(mapRouterOutput({ kind: "autostart", autostartAction: "status" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "autostart", action: "status" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "autostart", autostartAction: "bogus" }, CONTROL)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "voice", voiceModel: "medium" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "voice", model: "medium" },
      destructive: false,
    });
  });

  test("default: control-topic only, status when no category given, category with no value shows a picker, never destructive (a deliberate typed/tapped command, not a fuzzy NL guess)", () => {
    expect(mapRouterOutput({ kind: "default" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "default", category: "status" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "default", defaultCategory: "mode" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "default", category: "mode", value: undefined },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "default", defaultCategory: "mode", mode: "auto" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "default", category: "mode", value: "auto" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "default", defaultCategory: "mode", mode: "auto" }, SESSION)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "default", defaultCategory: "effort" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "default", category: "effort", value: undefined },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "default", defaultCategory: "effort", effort: "xhigh" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "default", category: "effort", value: "xhigh" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "default", defaultCategory: "effort", effort: "xhigh" }, SESSION)).toEqual({ matched: false });
  });

  test("repos: list/add/rm, only rm is destructive", () => {
    expect(mapRouterOutput({ kind: "repos", reposAction: "list" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "repos", action: "list" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "repos", reposAction: "add", reposName: "seowrite" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "repos", action: "add", name: "seowrite", path: undefined, base: undefined },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "repos", reposAction: "rm", reposName: "seowrite" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "repos", action: "rm", name: "seowrite" },
      destructive: true,
    });
    // add/rm without a name is a no-match, not a crash.
    expect(mapRouterOutput({ kind: "repos", reposAction: "add" }, CONTROL)).toEqual({ matched: false });
  });

  test("session_model/session_mode/session_effort: require a session, and a valid enum value", () => {
    expect(mapRouterOutput({ kind: "session_model", model: "opus" }, SESSION)).toEqual({
      matched: true,
      command: { kind: "model", model: "opus" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "session_model", model: "opus" }, CONTROL)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "session_model", model: "not-a-real-model" }, SESSION)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "session_mode", mode: "plan" }, SESSION)).toEqual({
      matched: true,
      command: { kind: "mode", mode: "plan" },
      destructive: false,
    });
    // ...but `mode auto` is: it fires the Shift+Tab keystrokes that leave the session running every
    // tool call with no approval card, i.e. decision 3's whole permission model switched off. "stop
    // asking me for permission on this one" is a very plausible match for it, so it must confirm.
    expect(mapRouterOutput({ kind: "session_mode", mode: "auto" }, SESSION)).toEqual({
      matched: true,
      command: { kind: "mode", mode: "auto" },
      destructive: true,
    });
    expect(mapRouterOutput({ kind: "session_effort", effort: "high" }, SESSION)).toEqual({
      matched: true,
      command: { kind: "effort", effort: "high" },
      destructive: false,
    });
  });

  test("help and about: no fields needed, never destructive, offered from anywhere - live gap fixed 2026-08-06 (a Russian 'show me the commands' phrase fell through to 'Unrecognised' before this)", () => {
    expect(mapRouterOutput({ kind: "help" }, CONTROL)).toEqual({ matched: true, command: { kind: "help" }, destructive: false });
    expect(mapRouterOutput({ kind: "help" }, SESSION)).toEqual({ matched: true, command: { kind: "help" }, destructive: false });
    expect(mapRouterOutput({ kind: "about" }, CONTROL)).toEqual({ matched: true, command: { kind: "about" }, destructive: false });
  });

  test("assist and router: their own status/on/off and status/api/cli enums", () => {
    // `assist off` is destructive by design: it removes the confirm card from every *subsequent*
    // destructive NL match, so an unconfirmed match that disables confirmation is self-propagating.
    expect(mapRouterOutput({ kind: "assist", assistAction: "off" }, CONTROL)).toEqual({ matched: true, command: { kind: "assist", action: "off" }, destructive: true });
    expect(mapRouterOutput({ kind: "assist", assistAction: "on" }, CONTROL)).toEqual({ matched: true, command: { kind: "assist", action: "on" }, destructive: false });
    expect(mapRouterOutput({ kind: "assist", assistAction: "bogus" }, CONTROL)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "router", routerAction: "api" }, CONTROL)).toEqual({ matched: true, command: { kind: "router", action: "api" }, destructive: false });
    expect(mapRouterOutput({ kind: "router", routerAction: "bogus" }, CONTROL)).toEqual({ matched: false });
  });

  test("voiceconfirm: its own status/on/off enum; turning it off is gated like any other guard", () => {
    // Same reasoning as `assist off` above - switching a review step off is at least as consequential
    // as the thing it reviews, and "don't keep asking me" is an easy accidental NL match.
    expect(mapRouterOutput({ kind: "voiceconfirm", voiceConfirmAction: "off" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "voiceconfirm", action: "off" },
      destructive: true,
    });
    expect(mapRouterOutput({ kind: "voiceconfirm", voiceConfirmAction: "on" }, CONTROL)).toEqual({
      matched: true,
      command: { kind: "voiceconfirm", action: "on" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "voiceconfirm", voiceConfirmAction: "bogus" }, CONTROL)).toEqual({ matched: false });
  });

  test("commands and skills: session-scoped, optional term, never destructive", () => {
    expect(mapRouterOutput({ kind: "commands" }, SESSION)).toEqual({ matched: true, command: { kind: "commands", term: "" }, destructive: false });
    expect(mapRouterOutput({ kind: "commands", term: "deploy" }, SESSION)).toEqual({ matched: true, command: { kind: "commands", term: "deploy" }, destructive: false });
    expect(mapRouterOutput({ kind: "commands" }, CONTROL)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "skills" }, SESSION)).toEqual({ matched: true, command: { kind: "skills", term: "" }, destructive: false });
    expect(mapRouterOutput({ kind: "skills" }, CONTROL)).toEqual({ matched: false });
  });

  test("builtin: compact/clear, session-scoped, requires a valid name", () => {
    expect(mapRouterOutput({ kind: "builtin", builtinName: "compact" }, SESSION)).toEqual({ matched: true, command: { kind: "builtin", name: "compact" }, destructive: false });
    expect(mapRouterOutput({ kind: "builtin", builtinName: "clear" }, SESSION)).toEqual({ matched: true, command: { kind: "builtin", name: "clear" }, destructive: false });
    expect(mapRouterOutput({ kind: "builtin", builtinName: "bogus" }, SESSION)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "builtin", builtinName: "compact" }, CONTROL)).toEqual({ matched: false });
  });

  test("browse: session-scoped, optional path, never destructive", () => {
    expect(mapRouterOutput({ kind: "browse" }, SESSION)).toEqual({ matched: true, command: { kind: "browse", path: "" }, destructive: false });
    expect(mapRouterOutput({ kind: "browse", path: "src" }, SESSION)).toEqual({ matched: true, command: { kind: "browse", path: "src" }, destructive: false });
    expect(mapRouterOutput({ kind: "browse" }, CONTROL)).toEqual({ matched: false });
  });

  test("find: session-scoped, requires a query, never destructive", () => {
    expect(mapRouterOutput({ kind: "find", query: "package.json" }, SESSION)).toEqual({
      matched: true,
      command: { kind: "find", query: "package.json" },
      destructive: false,
    });
    expect(mapRouterOutput({ kind: "find" }, SESSION)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "find", query: "package.json" }, CONTROL)).toEqual({ matched: false });
  });

  test("forward: always a no-match, by design - it means 'not a command'", () => {
    expect(mapRouterOutput({ kind: "forward" }, CONTROL)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "forward" }, SESSION)).toEqual({ matched: false });
  });

  // 2026-08-09: `isRetryPhrase`'s exact-match regex (retry-store.ts) only ever caught a bare
  // "retry"/"try again"/"do it again" - a full sentence built around the same request, in English or
  // any other language, needs the classifier instead. Never gated by hasSession/isControl: a retry
  // can be asked for from the control topic or from inside a session's own topic alike.
  test("retry: matches in both control and session contexts, never destructive", () => {
    expect(mapRouterOutput({ kind: "retry" }, CONTROL)).toEqual({ matched: true, command: { kind: "retry" }, destructive: false });
    expect(mapRouterOutput({ kind: "retry" }, SESSION)).toEqual({ matched: true, command: { kind: "retry" }, destructive: false });
  });

  test("an unrecognised or missing kind is a no-match, not a throw", () => {
    expect(() => mapRouterOutput({}, CONTROL)).not.toThrow();
    expect(mapRouterOutput({}, CONTROL)).toEqual({ matched: false });
    expect(mapRouterOutput({ kind: "not-a-real-kind" }, CONTROL)).toEqual({ matched: false });
  });
});

describe("buildSystemInstructions", () => {
  // 2026-08-07: a bare "delete this session"/"kill yourself" typed inside a session's own topic
  // named no slug and no "all", so it fell through to kind='forward' and landed on Claude itself -
  // which has no way to remove its own session - instead of resolving to that topic's own slug the
  // way a typed slug-less `/kill`/`/rm` already does (index.ts's resolveTargetSlug).
  test("only mentions self-referential kill/rm ('this session') when a session is in context", () => {
    expect(buildSystemInstructions(SESSION)).toContain("kill yourself");
    expect(buildSystemInstructions(CONTROL)).not.toContain("kill yourself");
  });

  test("repo-name hint still appends after the self-reference hint, when both apply", () => {
    const withRepos = buildSystemInstructions({ ...SESSION, repoNames: ["aibridge"] });
    expect(withRepos).toContain("kill yourself");
    expect(withRepos).toContain("aibridge");
  });

  // Live-verified 2026-08-10 (plans/control-topic-nl-dialogue-plan.md "Known limitation"): a
  // question that names real commands (e.g. "does /ship duplicate /deploy?") was read as
  // kind='help' before it ever reached the control-topic Q&A no-match path. Narrowed the
  // help/about trigger sentence to exclude questions that already name a specific command.
  test("carves out questions naming a specific command from the help/about trigger", () => {
    const text = buildSystemInstructions(CONTROL);
    expect(text).toContain("already names one or more specific commands");
    expect(text).toContain("NOT kind='help'/'about'");
  });

  // Live-observed 2026-08-11: "If i will use word 'branch' instead of session will you understand
  // that need to create new session with new command?" - a meta question about the router's own
  // synonym tolerance, naming no exact slash command - was read as kind='help' and answered with the
  // full command list instead of reaching the control-topic Q&A path. The 2026-08-10 carve-out above
  // only excludes messages naming a specific *command*; this one names generic words ('session',
  // 'new command') that appear in the schema's own vocabulary without naming an actual command.
  test("carves out hypothetical/meta questions about the router's own interpretation, even without naming a command", () => {
    const text = buildSystemInstructions(CONTROL);
    expect(text).toContain("hypothetical or meta question about how");
    expect(text).toContain("no exact command name mentioned at all");
  });
});

describe("buildRouteViaCliArgs", () => {
  // 2026-08-07: without --strict-mcp-config, every claude -p call (including this classifier)
  // auto-connects to the Bridge's own named pipe as a stray channel (the aibridge-telegram MCP
  // server is registered user-level in ~/.claude.json) - live-root-caused to a garbled voice
  // transcript timing out and falling through to "Unrecognised control-topic command". This test
  // exists so a future "simplification" that drops the flag fails here instead of only live.
  test("always includes --strict-mcp-config", () => {
    expect(buildRouteViaCliArgs("hello", CONTROL, "claude-haiku-4-5-20251001")).toContain("--strict-mcp-config");
  });

  test("carries the model, the JSON schema, and the message text", () => {
    const args = buildRouteViaCliArgs("delete this session", SESSION, "claude-haiku-4-5-20251001");
    expect(args).toContain("claude-haiku-4-5-20251001");
    expect(args).toContain("json");
    expect(args.some((a) => a.includes("delete this session"))).toBe(true);
    expect(args.some((a) => a.includes('"kind"'))).toBe(true);
  });
});

// Control-topic free-form Q&A (plans/control-topic-nl-dialogue-plan.md) - the second, schema-less
// call. Same "impure execFile call isn't unit-testable, the array it's handed should be" split as
// buildRouteViaCliArgs's own tests above.
describe("buildAnswerViaCliArgs", () => {
  test("always includes --strict-mcp-config, and never --json-schema", () => {
    const args = buildAnswerViaCliArgs("does /ship duplicate /deploy?", "grounding text", "", "claude-haiku-4-5-20251001");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--json-schema");
  });

  test("carries the model, the grounding text, the history text, and the message", () => {
    const args = buildAnswerViaCliArgs("does /ship duplicate /deploy?", "GROUNDING_MARKER", "Recent conversation:\nOperator: hi\n\n", "claude-haiku-4-5-20251001");
    expect(args).toContain("claude-haiku-4-5-20251001");
    expect(args.some((a) => a.includes("does /ship duplicate /deploy?"))).toBe(true);
    expect(args.some((a) => a.includes("GROUNDING_MARKER"))).toBe(true);
    expect(args.some((a) => a.includes("Recent conversation:"))).toBe(true);
  });

  test("omits the history block cleanly when historyText is empty", () => {
    const args = buildAnswerViaCliArgs("hi", "grounding", "", "claude-haiku-4-5-20251001");
    expect(args.some((a) => a.includes("Recent conversation:"))).toBe(false);
  });
});
