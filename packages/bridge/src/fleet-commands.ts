import type { AttachmentKind } from "./attachment-inbox.ts";
import { escapeForFeed } from "./feed-escape.ts";
import type { RepoEntry } from "./repos-registry.ts";
import type { Effort, Mode, Model } from "./session-commands.ts";
import { EFFORTS, MODELS, MODES } from "./session-commands.ts";
import type { SessionRow } from "./session-store.ts";

/** Bytes for an attachment sent alongside a control-topic `/new <repo> <prompt>` caption
 * (attachment-triggered-session-creation-plan.md) - carried in memory (never written to a temp
 * file) until `handleNewCommand` knows the session's `slug`, at which point it's moved into that
 * session's own inbox the same way an existing-session attachment already is
 * (`attachment-inbox.ts`'s `writeAttachmentToInbox`). */
export interface PendingAttachment {
  kind: AttachmentKind;
  name: string;
  bytes: Uint8Array;
  /** Set only when the caption wasn't literal `/new <repo> <prompt>` syntax and was instead routed
   * through the NL router (inbound-media.ts's `handleControlTopicAttachment`) - the router's
   * `prompt` field is an English paraphrase (right for the slug/topic title, wrong for what the
   * announcement should show), so this carries the operator's actual raw caption text for
   * `handleNewCommand` to use in `buildAttachmentAnnouncement` instead. Left unset for the literal-
   * syntax path, where `cmd.prompt` is already verbatim and no override is needed. */
  rawCaption?: string;
}

/**
 * §4.2's fleet-scoped commands. `/new`/`/ls`/`/budget` are control-topic only (no target to act on
 * besides the fleet itself); `/kill`/`/rm`/`/attach`/`/pause`/`/usage`/`/ship` take an optional
 * `<slug>` so they can be sent from the control topic *or* bare from inside the session's own topic
 * (§4.2: "`/kill` with no argument inside a session topic kills that session"). `/deploy` stays the
 * one exception requiring an explicit `<slug>` from the control topic only (§5.9) - `/ship` runs the
 * identical merge+gate, so a bare invocation is exactly as deliberate an action from inside that
 * session's own topic, but an *explicit* slug naming a different session still needs the control
 * topic either way (`deploy-lifecycle-commands.ts`'s `handleShipCommand`).
 */
/**
 * `/rm`'s bulk forms (added 2026-08-04, live testing produced dozens of `dead` rows within a
 * single sitting with no way to clear them except one `/rm <slug>` at a time). `--dead`/`--prefix`
 * are scoped to `dead` rows only, always - a bulk command is exactly the kind of action a
 * fat-fingered pattern shouldn't be able to turn into an accidental mass-`/kill` of live sessions.
 * `--all` (added 2026-08-04) is the deliberate exception - it can remove live sessions too, which
 * is why `index.ts` routes it through the `/kill --all` confirm-button flow (fleet-confirm.ts)
 * instead of executing on the same message, unlike its `dead`-only siblings here.
 */
export type RmBulkFilter = { mode: "dead" } | { mode: "prefix"; prefix: string } | { mode: "all" };

export type FleetCommand =
  | { kind: "new"; repo: string; prompt: string; model?: Model; sourceText?: string; pendingAttachment?: PendingAttachment }
  | { kind: "ls" }
  | { kind: "kill"; slug?: string; all?: boolean; force?: boolean }
  | { kind: "rm"; slug?: string; bulk?: RmBulkFilter; force?: boolean }
  | { kind: "attach"; slug?: string }
  | { kind: "pause"; slug?: string }
  | { kind: "usage"; slug?: string }
  | { kind: "stop"; slug?: string }
  | { kind: "budget" }
  | { kind: "restart" }
  | { kind: "deploy"; slug: string }
  | { kind: "ship"; slug?: string }
  | { kind: "detail"; slug?: string; level?: "compact" | "full" }
  | { kind: "verbose"; slug?: string; on?: boolean }
  | { kind: "settings" }
  | { kind: "autostart"; action: "status" | "install" | "uninstall" }
  | { kind: "repos"; action: "list" }
  | { kind: "repos"; action: "add"; name: string; path?: string; base?: string; model?: string }
  | { kind: "repos"; action: "rm"; name: string }
  | { kind: "voice"; model?: string }
  | { kind: "assist"; action: "status" | "on" | "off" }
  | { kind: "router"; action: "status" | "api" | "cli" }
  | { kind: "voiceconfirm"; action: "status" | "on" | "off" }
  | { kind: "default"; category: "status" }
  | { kind: "default"; category: "mode"; value?: Mode }
  | { kind: "default"; category: "effort"; value?: Effort }
  | { kind: "os"; action: "shutdown" | "reboot" | "cancel" };

const MODEL_FLAG_RE = new RegExp(`^--(${MODELS.join("|")})$`);

/**
 * Every recognised flag word across every fleet command that takes one (`/kill --all`,
 * `/rm --all|--dead|--prefix`, `/repos add ... --base|--model`, `/new --opus|...`) - kept as one
 * list so a single-dash typo (`/rm -all`, operator-reported 2026-08-07: typing `--` reliably on a
 * phone keyboard is its own small tax) is recognised the same way everywhere, rather than only for
 * whichever command happened to get a bug report first.
 */
const KNOWN_FLAG_WORDS = ["all", "dead", "prefix", "base", "model", "force", ...MODELS] as const;

/** Matches a *single* leading hyphen immediately before one of `KNOWN_FLAG_WORDS`, but not a second
 * hyphen of an already-double-dash flag (the `(?<!-)` lookbehind) and not a longer word that merely
 * starts with one of these (the `(?![a-zA-Z])` lookahead - `-allocate` must not become `--allocate`
 * of a flag that doesn't exist). */
const SINGLE_DASH_FLAG_RE = new RegExp(`(?<!-)-(${KNOWN_FLAG_WORDS.join("|")})(?![a-zA-Z])`, "g");

/**
 * Mobile keyboards' "smart punctuation"/autocorrect commonly rewrites a typed `--` into a single
 * en dash (–, U+2013), em dash (—, U+2014), or figure dash (‒, U+2012) mid-message - live-observed
 * 2026-08-06 (a phone keyboard did this, not Telegram's own client, which passes typed text through
 * unchanged). Every `--flag` this codebase parses only ever means the ASCII double-hyphen, so
 * normalising back before parsing is always safe *here* - unlike a general chat message forwarded
 * to a session, which never runs through this function at all and could legitimately contain a real
 * em dash in prose.
 *
 * Also normalises a plain single dash before a recognised flag word (`/rm -all` -> `/rm --all`),
 * same idea as the dash-character fix above - a keyboard that dropped one hyphen shouldn't produce
 * a different, unhelpful error (or worse, get parsed as a slug named "-all") instead of the command
 * that was obviously meant.
 *
 * `-f` is a second, separate alias straight to `--force` (operator-requested 2026-08-08, alongside
 * `-force`/`--force` - see `parseKill`/`parseRm`'s force handling below) rather than going through
 * `KNOWN_FLAG_WORDS`: that mechanism replaces a matched word with itself (`-all` -> `--all`), which
 * would turn `-f` into the non-existent `--f`, not `--force`. Kept as its own trailing replace so
 * it never fires on the `-f` inside an already-double-dashed `--force` (the `(?<!-)` lookbehind
 * rejects a hyphen with another hyphen right before it).
 */
export function normalizeDashFlags(text: string): string {
  return text
    .replace(/[‒–—]/g, "--")
    .replace(SINGLE_DASH_FLAG_RE, "--$1")
    .replace(/(?<!-)-f(?![a-zA-Z])/g, "--force");
}

/** `/new [--opus|--haiku|--fable|--sonnet] <repo> <prompt...>` - the flag, if present, must come
 * immediately after `/new`, matching the plan's own `[--opus|--haiku] <repo> <prompt>` ordering. */
function parseNew(rest: string): FleetCommand | null {
  const tokens = rest.trim().split(/\s+/);
  let model: Model | undefined;
  if (tokens[0] && MODEL_FLAG_RE.test(tokens[0])) {
    const flagMatch = tokens[0].match(MODEL_FLAG_RE);
    model = flagMatch?.[1] as Model;
    tokens.shift();
  }
  const repo = tokens.shift();
  const prompt = tokens.join(" ");
  if (!repo || !prompt) return null;
  return { kind: "new", repo, prompt, model };
}

/** What actually gets shown in-topic and sent as the session's first turn: the operator's own words
 * when known (`sourceText`, threaded through only for an NL-router-matched `/new` - `index.ts`'s
 * `routeOrFallback` attaches it from the raw incoming message), never the router's English paraphrase
 * (`prompt`) - that stays reserved for the slug/topic title, which are meant to stay English
 * regardless of what language the conversation itself runs in. A typed `/new <repo> <task>` command
 * never sets `sourceText` at all, since `prompt` there is already the operator's verbatim text. */
export function newSessionContent(cmd: { prompt: string; sourceText?: string }): string {
  return cmd.sourceText ?? cmd.prompt;
}

function parseSlugArg(kind: "attach" | "pause" | "usage" | "stop", rest: string): FleetCommand {
  const slug = rest.trim();
  return { kind, slug: slug.length > 0 ? slug : undefined };
}

/**
 * Shared shape behind `/detail`/`/verbose` (§5.9): both take an optional `<slug>` (control-topic
 * form, same as `/pause`) plus an optional value token - "bare from inside the session's own
 * topic" and "with a slug from the control topic" are the same two forms every other
 * `parseSlugArg`-style command already supports, this just also has a value to set.
 *
 * A single token is ambiguous between "the value, session-topic bare-set form" and "the slug,
 * control-topic bare-report form" - resolved by checking `isValue` first, since the value's
 * alphabet (`compact`/`full`, `on`/`off`) can never collide with a real slug (slugs are generated
 * from the session's own prompt text and never land on one of these exact words by construction).
 */
function parseSlugAndValue<V extends string>(rest: string, isValue: (s: string) => s is V): { slug?: string; value?: V } | null {
  const tokens = rest.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return {};
  if (tokens.length === 1) {
    const [only] = tokens as [string];
    return isValue(only) ? { value: only } : { slug: only };
  }
  if (tokens.length === 2) {
    const [slug, value] = tokens as [string, string];
    return isValue(value) ? { slug, value } : null;
  }
  return null;
}

function isDetailLevel(s: string): s is "compact" | "full" {
  return s === "compact" || s === "full";
}

function isOnOff(s: string): s is "on" | "off" {
  return s === "on" || s === "off";
}

/** `/detail [<slug>] [compact|full]` - see `parseSlugAndValue`'s note on the two supported forms. */
function parseDetail(rest: string): FleetCommand | null {
  const parsed = parseSlugAndValue(rest, isDetailLevel);
  return parsed ? { kind: "detail", slug: parsed.slug, level: parsed.value } : null;
}

/** `/verbose [<slug>] [on|off]` - same shape as `parseDetail`. */
function parseVerbose(rest: string): FleetCommand | null {
  const parsed = parseSlugAndValue(rest, isOnOff);
  if (!parsed) return null;
  return { kind: "verbose", slug: parsed.slug, on: parsed.value === undefined ? undefined : parsed.value === "on" };
}

/** `/kill --all` requests fleet-confirm-gated (`index.ts`, fleet-confirm.ts) termination of every
 * live session. Anything else falls through to the ordinary single-slug form.
 *
 * `--force` (operator-requested 2026-08-08, alongside its `-force`/`-f` aliases normalised above)
 * skips that Yes/No card and has `index.ts` tear everything down on the same message instead - the
 * escape hatch for an operator who's already decided and doesn't want to round-trip a button tap.
 * Deliberately narrow: it's only recognised alongside `--all`, the one form that shows a card at
 * all - a bare `/kill <slug>` already executes immediately with no confirmation to skip (§4.2), so
 * `force` on that path would be a no-op flag with nothing to explain what it did. */
function parseKill(rest: string): FleetCommand {
  const tokens = rest.trim().split(/\s+/).filter((t) => t.length > 0);
  const force = tokens.includes("--force");
  const withoutForce = tokens.filter((t) => t !== "--force");
  if (withoutForce.length === 1 && withoutForce[0] === "--all") {
    return force ? { kind: "kill", all: true, force: true } : { kind: "kill", all: true };
  }
  const trimmed = withoutForce.join(" ");
  return { kind: "kill", slug: trimmed.length > 0 ? trimmed : undefined };
}

/** `/rm --dead` removes every `dead`-state row; `/rm --prefix <text>` removes every `dead`-state
 * row whose slug starts with `<text>` (still `dead`-only, for the same reason `--dead` is - see
 * `RmBulkFilter`'s own note); `/rm --all` requests fleet-confirm-gated removal of every session
 * regardless of state. Anything else falls through to the ordinary single-slug form.
 *
 * `--force` is `parseKill`'s same escape hatch, scoped the same way: only meaningful alongside
 * `--all`, since that's the only `/rm` form that posts a confirm card - `--dead`/`--prefix` already
 * execute immediately (never touch a live session, so there was never anything to confirm), and a
 * bare `/rm <slug>` does too. A stray `--force` on any of those is harmlessly stripped rather than
 * rejected, same tolerance the dash-normalisation above already extends to typos. */
function parseRm(rest: string): FleetCommand {
  const tokens = rest.trim().split(/\s+/).filter((t) => t.length > 0);
  const force = tokens.includes("--force");
  const trimmed = tokens.filter((t) => t !== "--force").join(" ");
  if (trimmed === "--dead") return { kind: "rm", bulk: { mode: "dead" } };
  if (trimmed === "--all") return force ? { kind: "rm", bulk: { mode: "all" }, force: true } : { kind: "rm", bulk: { mode: "all" } };
  const prefixMatch = trimmed.match(/^--prefix\s+(\S+)$/);
  if (prefixMatch?.[1]) return { kind: "rm", bulk: { mode: "prefix", prefix: prefixMatch[1] } };
  return { kind: "rm", slug: trimmed.length > 0 ? trimmed : undefined };
}

/** `/os shutdown|reboot|cancel` - host power control (plans/swirling-crafting-pixel.md), gated
 * behind a Yes/No confirm card in index.ts/os-power-commands.ts exactly like `/kill --all`. Unlike
 * `/autostart`'s bare-defaults-to-status shape, there is no safe default here - a bare `/os` with
 * no argument is rejected rather than assumed to mean anything. */
function parseOs(rest: string): FleetCommand | null {
  const action = rest.trim();
  if (action !== "shutdown" && action !== "reboot" && action !== "cancel") return null;
  return { kind: "os", action };
}

/** `/autostart` with no argument defaults to `status`; anything besides `status`/`install`/
 * `uninstall` is a malformed argument, not a different command. */
function parseAutostart(rest: string): FleetCommand | null {
  const trimmed = rest.trim();
  const action = trimmed.length === 0 ? "status" : trimmed;
  if (action !== "status" && action !== "install" && action !== "uninstall") return null;
  return { kind: "autostart", action };
}

/** `/assist [on|off]` - whether a natural-language-matched *destructive* command shows a confirm
 * card first (nl-confirm.ts), or the typeable equivalent of that card's own "don't ask again"
 * button. Bare `/assist` reports the current setting, same "no argument defaults to status" shape
 * as `/autostart`. Named for what it reads as in a sentence ("/assist off") rather than spelling
 * out "nl"/"confirm" literally - see the plan's changelog for the naming discussion. */
function parseAssist(rest: string): FleetCommand | null {
  const trimmed = rest.trim();
  const action = trimmed.length === 0 ? "status" : trimmed;
  if (action !== "status" && action !== "on" && action !== "off") return null;
  return { kind: "assist", action };
}

/** `/router [api|cli]` - live switch for the NL-router backend (`config.ts`'s `nlRouter.backend`
 * one-time startup default, overridden here without a restart - see `settings-store.ts`'s
 * `nl_router_backend` key). Per explicit operator direction: configuring an API key must never be
 * the thing that switches this on its own - this command (or its own confirm-free execution in
 * index.ts) is the only way to actually opt in to spending real money, and switching back to
 * `"cli"` is exactly as supported as switching to `"api"` in the first place. */
function parseRouterBackend(rest: string): FleetCommand | null {
  const trimmed = rest.trim();
  const action = trimmed.length === 0 ? "status" : trimmed;
  if (action !== "status" && action !== "api" && action !== "cli") return null;
  return { kind: "router", action };
}

/** `/voiceconfirm [on|off]` - whether a transcribed voice note shows a Send/Re-record/Type-instead
 * card first (voice-confirm.ts) before it's dispatched, or the typeable equivalent of that card's
 * own "Send, don't ask again" button. Bare `/voiceconfirm` reports the current setting, same
 * "no argument defaults to status" shape as `/assist`/`/autostart`. Kept as its own command rather
 * than folded into `/voice` (which already takes an optional `<model>` token as its rest-of-line
 * argument, so `/voice off` would be ambiguous with a (nonexistent) model literally named "off"). */
function parseVoiceConfirm(rest: string): FleetCommand | null {
  const trimmed = rest.trim();
  const action = trimmed.length === 0 ? "status" : trimmed;
  if (action !== "status" && action !== "on" && action !== "off") return null;
  return { kind: "voiceconfirm", action };
}

/** `/default [mode|effort] [<value>]` - one command for both new-session defaults (permission mode
 * and reasoning effort), rather than two separately-named commands to remember (operator feedback,
 * 2026-08-07: "I just want one /default I can remember, that shows me what I can set"). Three
 * depths, each a valid stopping point:
 * - Bare `/default` (or `/default status`): category is `"status"` - index.ts shows both current
 *   values plus a tappable Mode/Effort keyboard (`session-commands.ts`'s
 *   `buildDefaultCategoryKeyboard`) to drill into either one.
 * - `/default mode` / `/default effort` with no value: category set, `value` left `undefined` -
 *   index.ts shows that category's own value picker (`buildDefaultModeKeyboard`/
 *   `buildDefaultEffortKeyboard`), current value marked, same shape as bare `/mode`/`/effort`'s
 *   session-scoped pickers but under a different callback namespace (`defmode:`/`defeffort:`, not
 *   `mode:`/`effort:`) - a tap here must never be mistaken for a live session's own mode/effort
 *   switch, which is control-topic-scoped nonsense to begin with (no `currentSlug` to apply to).
 * - `/default mode <value>` / `/default effort <value>` - a direct set, for anyone who'd rather type
 *   the whole thing than tap through the picker; same shape `/mode <value>`/`/effort <value>`
 *   already offer for a live session.
 *
 * Applied in `handleNewCommand` before a new session's first turn (index.ts), persisted via
 * `settings-store.ts` (survives a Bridge restart), and control-topic only - a fleet-wide setting,
 * not something any one session's topic acts on (`nl-router.ts`'s `allowedKinds` mirrors this the
 * same way it already does for `/new`/`/budget`).
 *
 * Setting mode to `auto` is not specially confirmed here the way a live `/mode auto` is treated as
 * destructive by the NL router (`nl-router.ts`'s `isDestructive`) - an explicit `/default mode auto`
 * (typed or tapped) is a deliberate command, not a fuzzy natural-language guess, so the same "don't
 * second-guess an exact command" posture every other bare fleet command already gets applies here
 * too. The operator-facing risk (every future session starts with no permission prompts at all
 * until this is changed back) is surfaced in the confirmation text instead
 * (index.ts's `handleDefaultCommand`). */
function parseDefault(rest: string): FleetCommand | null {
  const tokens = rest.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens[0] === "status") return { kind: "default", category: "status" };
  const category = tokens[0];
  const rawValue = tokens[1];
  if (category === "mode") {
    if (rawValue === undefined) return { kind: "default", category: "mode" };
    return (MODES as readonly string[]).includes(rawValue) ? { kind: "default", category: "mode", value: rawValue as Mode } : null;
  }
  if (category === "effort") {
    if (rawValue === undefined) return { kind: "default", category: "effort" };
    return (EFFORTS as readonly string[]).includes(rawValue) ? { kind: "default", category: "effort", value: rawValue as Effort } : null;
  }
  return null;
}

/**
 * `/repos [list]` / `/repos add <name> [<path>|<git-url>] [--base <branch>] [--model <model>]` /
 * `/repos rm|remove <name>` - §7.5's registry, made mutable from Telegram (`repos-registry.ts`'s
 * `addRepoEntry`/`removeRepoEntry`) instead of only by hand-editing the file. Bare `/repos` and
 * `/repos list` are the same as `/repos` itself is already the read path - `list` exists only so a
 * typed-out form matches `add`/`rm`'s shape. Neither `<name>` nor `<path>` accept embedded spaces,
 * same "no quoting" convention as every other fleet command's arguments (e.g. `/new`'s `<repo>`
 * token).
 *
 * `<path>` is optional - `index.ts`'s `handleReposCommand` fills it in (`inferDefaultRepoPath`) when
 * every already-registered repo shares one parent folder, or clones it first (`cloneRepo`) when the
 * token is a git URL (`isGitUrl`) rather than a local path. This parser only has to tell "no path
 * given" apart from "a flag came right after the name" (`/repos add foo --base main`), which is why
 * a leading `--` token is never consumed as the path.
 */
function parseRepos(rest: string): FleetCommand | null {
  const tokens = rest.trim().split(/\s+/).filter((t) => t.length > 0);
  const sub = tokens.length === 0 ? "list" : tokens.shift();
  if (sub === "list") return { kind: "repos", action: "list" };
  if (sub === "add") {
    const name = tokens.shift();
    if (!name) return null;
    const repoPath = tokens.length > 0 && !tokens[0]?.startsWith("--") ? tokens.shift() : undefined;
    let base: string | undefined;
    let model: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "--base" && tokens[i + 1]) {
        base = tokens[++i];
      } else if (tokens[i] === "--model" && tokens[i + 1]) {
        model = tokens[++i];
      } else {
        return null;
      }
    }
    return { kind: "repos", action: "add", name, path: repoPath, base, model };
  }
  if (sub === "rm" || sub === "remove") {
    const name = tokens.shift();
    if (!name || tokens.length > 0) return null;
    return { kind: "repos", action: "rm", name };
  }
  return null;
}

/**
 * Telegram's own "/" autocomplete popup inserts "@<botusername>" right after the command name in
 * a group chat (confirmed live 2026-08-04 - see CLAUDE.md's live-verification note), so a tapped
 * suggestion arrives as e.g. `/kill@om_aibridge_control_bot slug` rather than `/kill slug`. Every
 * command match in this codebase (`parseFleetCommand`, `parseSessionCommand`, the `/help` exact
 * checks, `isBuiltinPassthroughCommand`) assumes a bare `/command` - without stripping the mention
 * first, a tapped suggestion would silently match nothing and fall through as plain chat text
 * instead of running the command. Only a mention directly following the leading `/word` with no
 * intervening space is stripped, matching exactly what Telegram inserts - a genuine `@name`
 * anywhere else in a real message (e.g. actual conversational text) is left untouched.
 */
export function stripBotMention(text: string): string {
  return text.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+\b/, "$1");
}

/**
 * `/help`/`/?`/`/h` (plus bare `?`, control-topic only - ambiguous with real chat text inside a
 * session topic): the fixed fleet+session command reference, never filtered. `/commands`
 * (formerly a `/help` alias, repurposed 2026-08-04 - see `parseCommandsQuery`) and `/skills` are
 * the ones that take a search term, since they're the ones whose item count actually scales with
 * the project.
 */
export function isHelpCommand(text: string, isControl: boolean): boolean {
  const trimmed = text.trim();
  if (trimmed === "?") return isControl;
  return trimmed === "/help" || trimmed === "/?" || trimmed === "/h";
}

/**
 * `/commands [<term>]` - lists the session's own `.claude/commands/**\/*.md`, optionally filtered.
 * Repurposed 2026-08-04 from a bare `/help` alias: once real projects showed up with 40+ repo
 * commands (seowrite, confirmed live) a flat per-item button list couldn't scale, and per Telegram
 * bot UX convention the fix for "too many items for buttons" is search-as-you-type browsing via a
 * dedicated command, not deeper pagination. Returns null for anything that isn't this command,
 * distinct from `{ term: "" }` (recognised, no filter given - list everything).
 */
export function parseCommandsQuery(text: string): { term: string } | null {
  const match = text.trim().match(/^\/commands(?:\s+(.+))?$/);
  if (!match) return null;
  return { term: (match[1] ?? "").trim() };
}

/** `/skills [<term>]` - same idea as `parseCommandsQuery`, for `.claude/skills/*`. */
export function parseSkillsQuery(text: string): { term: string } | null {
  const match = text.trim().match(/^\/skills(?:\s+(.+))?$/);
  if (!match) return null;
  return { term: (match[1] ?? "").trim() };
}

/** Shared between `parseFleetCommand` and `matchFleetCommandName` below - the list of command
 * *names* this module recognises, independent of whether the rest of the message parses. */
const FLEET_COMMAND_NAME_RE = /^\/(new|ls|kill|rm|attach|pause|stop|usage|budget|restart|deploy|ship|detail|verbose|settings|autostart|repos|voice|voiceconfirm|assist|router|default|os)\b/;

/**
 * Same command-name match as `parseFleetCommand`, but returns the bare word even when the rest of
 * the message doesn't parse (missing/malformed required argument, e.g. `/new` with no repo, `/deploy`
 * with no slug, `/repos add` with no name). Lets `command-dispatch.ts` tell "not a fleet command at
 * all" (fall through to NL routing/forwarding as plain chat) apart from "recognised command, invalid
 * argument" (surface help/usage instead) - operator-reported: a mistyped `/new` or `/deploy` was
 * otherwise silently swallowed into the NL router or forwarded into the session as literal chat text.
 */
export function matchFleetCommandName(text: string): string | null {
  const match = text.trim().match(FLEET_COMMAND_NAME_RE);
  return match ? match[1]! : null;
}

/** Returns null for anything that isn't one of these commands. A recognised command with a
 * malformed argument (e.g. `/new` with no repo) also returns null - same "not for us" vs.
 * "for us, but invalid" split as `session-commands.ts`'s parser; `matchFleetCommandName` above is
 * how a caller distinguishes the two. */
export function parseFleetCommand(text: string): FleetCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(new RegExp(FLEET_COMMAND_NAME_RE.source + "(.*)$", "s"));
  if (!match) return null;
  const [, cmd, rawRest] = match as [string, string, string];
  const rest = normalizeDashFlags(rawRest);
  switch (cmd) {
    case "new":
      return parseNew(rest);
    case "ls":
      return { kind: "ls" };
    case "budget":
      return { kind: "budget" };
    case "restart":
      return { kind: "restart" };
    case "deploy": {
      const slug = rest.trim();
      return slug.length > 0 ? { kind: "deploy", slug } : null;
    }
    case "ship": {
      // Unlike `/deploy`, a bare slug is allowed here - resolved against `currentSlug` (the
      // dispatch layer, per §4.2's existing convention for `/kill`/`/rm`/`/pause`/`/usage`) when
      // sent from inside a session's own topic, so "ship" typed there is never left to fall through
      // as plain chat text to the session's own Claude process (which - lacking any real command by
      // that name if the worktree predates this feature - would otherwise go off trying to guess
      // what "/ship" meant, rather than the Bridge just running it).
      const slug = rest.trim();
      return { kind: "ship", slug: slug.length > 0 ? slug : undefined };
    }
    case "detail":
      return parseDetail(rest);
    case "verbose":
      return parseVerbose(rest);
    case "settings":
      return { kind: "settings" };
    case "autostart":
      return parseAutostart(rest);
    case "assist":
      return parseAssist(rest);
    case "router":
      return parseRouterBackend(rest);
    case "voiceconfirm":
      return parseVoiceConfirm(rest);
    case "default":
      return parseDefault(rest);
    case "os":
      return parseOs(rest);
    case "repos":
      return parseRepos(rest);
    case "voice": {
      const model = rest.trim();
      return { kind: "voice", model: model.length > 0 ? model : undefined };
    }
    case "rm":
      return parseRm(rest);
    case "kill":
      return parseKill(rest);
    case "attach":
    case "pause":
    case "usage":
    case "stop":
      return parseSlugArg(cmd, rest);
    default:
      return null;
  }
}

function ageLabel(createdUtc: string, nowMs: number): string {
  const ms = nowMs - new Date(createdUtc).getTime();
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Left-pads every row's cells to its column's widest entry - Telegram has no real table markup,
 * but a monospace `<pre>` block (§5.3 already relies on the same tag for the feed card) renders
 * space-padded columns aligned on every client, which is the closest fake-a-table gets without one. */
function padColumns(rows: readonly string[][]): string[][] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)));
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** §4.2's `/ls`: slug, state, worktree, branch, age, model, and (§5.7, added 2026-08-04) lifetime
 * cost per session, sourced from `cost-tracker.ts` and keyed by `session_id` - `costBySlug` is
 * optional so every existing caller/test that only cares about the lifecycle columns is unaffected,
 * and a session with no `session_id` yet (or simply no recorded spend) shows `$0.00` rather than a
 * blank cell. Rendered as an HTML `<pre>` block (call sites must pass `parseMode: "HTML"`) so the
 * columns line up as a monospace table instead of Telegram's default proportional font.
 *
 * `detailBySlug` (added 2026-08-05): the `state` column alone only says a session is `working` or
 * `awaiting_input`, not *what* it's doing or *what* it's waiting on - the actually urgent question
 * when glancing at the fleet from a phone. `index.ts` builds this map from the same sources the
 * per-session turn card already reads (`feed-state.ts`'s current activity line for `working`,
 * `PermissionRegistry`/`AskRegistry`'s pending entries for `awaiting_input`) rather than inventing a
 * new state machine - this is a read-only join, not new tracked state. Rendered as a second section
 * below the table, one line per session that has something to say, so a fleet where nothing is
 * waiting doesn't grow an empty section. */
export function renderLsTable(
  rows: readonly SessionRow[],
  nowMs: number,
  costBySlug?: ReadonlyMap<string, number>,
  detailBySlug?: ReadonlyMap<string, string>,
): string {
  if (rows.length === 0) return "No sessions.";
  const header = ["SLUG", "STATE", "MODEL", "BRANCH", "AGE", "COST"];
  const body = rows.map((r) => [
    r.slug,
    r.paused ? `${r.state} (paused)` : r.state,
    r.model,
    r.branch,
    ageLabel(r.createdUtc, nowMs),
    formatUsd(costBySlug?.get(r.slug) ?? 0),
  ]);
  const [paddedHeader, ...paddedBody] = padColumns([header, ...body]);
  const headerLine = (paddedHeader as string[]).join("  ");
  const separator = "-".repeat(headerLine.length);
  const lines = [headerLine, separator, ...paddedBody.map((row) => row.join("  "))];
  let text = `<pre>${escapeForFeed(lines.join("\n"))}</pre>`;
  const details = rows.map((r) => [r.slug, detailBySlug?.get(r.slug)] as const).filter(([, detail]) => detail !== undefined);
  if (details.length > 0) {
    const detailLines = details.map(([slug, detail]) => `  ${slug}: ${detail}`);
    text += `\n${escapeForFeed(detailLines.join("\n"))}`;
  }
  return text;
}

/** Elapsed-time label for a turn/wait duration already in milliseconds - `ageLabel`'s sibling, kept
 * separate since that one takes an ISO timestamp and this always takes a precomputed delta (a turn's
 * `turnStartedAtMs`, a pending permission/ask's `createdAt`). */
function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Truncates a tool-input preview to keep the `/ls` detail line short - the full text is already
 * available on the permission card itself in that session's own topic, this is just an at-a-glance
 * hint of *which* pending prompt it is. */
function truncatePreview(text: string, maxLen = 40): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

/** Builds `renderLsTable`'s `detailBySlug` from the same sources the per-session turn card already
 * reads. Empty/absent for a session with nothing worth calling out (`idle`, `dead`, `quota_stopped`,
 * or a `working` session between hook events with no `feed-state.ts` line yet).
 *
 * Takes *two* clocks, not one - confirmed live 2026-08-05: a first pass that reused `nowMs` (wall
 * clock, matching `feed-state.ts`'s `turnStartedAtMs`) to also diff against
 * `PermissionRegistry`/`AskRegistry`'s `createdAt` produced a nonsense duration ("496088h12m"),
 * because those two registries stamp `createdAt` with `monotonicNowMs()` (§7.4 - never wall-clock,
 * so a suspend/resume can't mass-expire every pending prompt). Mixing the two clock bases in one
 * subtraction is exactly the silent-wrong failure mode §9 asks this kind of helper to be tested
 * against, not a crash - it would have shipped looking plausible. */
export function buildLsDetail(
  rows: readonly SessionRow[],
  nowMs: number,
  monotonicNowMs: number,
  feedStates: ReadonlyMap<string, { turnActive: boolean; turnStartedAtMs: number | null; lines: readonly { summary: string; status: string }[] }>,
  pendingPermissions: readonly { slug: string; toolName: string; inputPreview: string; createdAt: number }[],
  pendingAsks: readonly { slug: string; questions: readonly { question: string; answerLabel?: string }[]; createdAt: number }[],
): Map<string, string> {
  const detail = new Map<string, string>();
  for (const r of rows) {
    if (r.state === "working") {
      const state = feedStates.get(r.slug);
      const running = [...(state?.lines ?? [])].reverse().find((l) => l.status === "running");
      if (running && state?.turnStartedAtMs != null) {
        detail.set(r.slug, `running: ${truncatePreview(running.summary)} (${durationLabel(nowMs - state.turnStartedAtMs)})`);
      }
    } else if (r.state === "awaiting_input") {
      const permission = pendingPermissions.find((p) => p.slug === r.slug);
      if (permission) {
        detail.set(
          r.slug,
          `waiting: permission (${permission.toolName}: ${truncatePreview(permission.inputPreview)}) - ${durationLabel(monotonicNowMs - permission.createdAt)}`,
        );
        continue;
      }
      const ask = pendingAsks.find((a) => a.slug === r.slug);
      if (ask) {
        const unanswered = ask.questions.find((q) => q.answerLabel === undefined);
        detail.set(
          r.slug,
          `waiting: question${unanswered ? ` (${truncatePreview(unanswered.question)})` : ""} - ${durationLabel(monotonicNowMs - ask.createdAt)}`,
        );
        continue;
      }
      detail.set(r.slug, "waiting: reply");
    }
  }
  return detail;
}

/** §10.5 point 2's `/budget`: rolling 5-hour and weekly fleet spend, plus a per-session breakdown
 * sorted highest-spend-first so the session actually driving the number is the first thing visible.
 * `perSessionFiveHour` only lists sessions with nonzero 5h spend - a fleet of mostly-idle sessions
 * shouldn't produce a wall of `$0.00` rows. */
export function renderBudget(fleetFiveHour: number, fleetWeekly: number, perSessionFiveHour: ReadonlyMap<string, number>): string {
  const lines = [`Fleet spend - last 5h: ${formatUsd(fleetFiveHour)} · last 7d: ${formatUsd(fleetWeekly)}`];
  const nonzero = [...perSessionFiveHour.entries()].filter(([, cost]) => cost > 0).sort((a, b) => b[1] - a[1]);
  if (nonzero.length > 0) {
    lines.push("", "Last 5h by session:");
    for (const [slug, cost] of nonzero) {
      lines.push(`  ${slug}: ${formatUsd(cost)}`);
    }
  }
  return escapeForFeed(lines.join("\n"));
}

/** `/settings`: a read-only card for the machine-level config an operator can't see from `/ls`
 * (registered repos, the weighted concurrency budget) - control-topic only, same reasoning as
 * `/budget` (there's no single session to scope this to). */
export function renderSettings(repos: readonly RepoEntry[], concurrency: { current: number; cap: number }): string {
  const lines = ["Bridge settings:", "", `Registered repos (${repos.length}):`];
  if (repos.length === 0) {
    lines.push("  (none - add one to repos.toml, §7.5)");
  } else {
    for (const r of repos) {
      lines.push(`  ${r.name} -> ${r.path}${r.model ? ` (default model: ${r.model})` : ""}`);
    }
  }
  lines.push("", `Concurrency: ${concurrency.current} / ${concurrency.cap} weighted units (§10.5)`);
  return escapeForFeed(lines.join("\n"));
}

/** `/repos [list]`: same registry `/settings` already shows a slice of, but as its own dedicated
 * command with a usage hint for `add`/`rm` underneath - `/settings` stays read-only (§7.5's original
 * "editing repos.toml is the only way in" model), this is the mutate-from-Telegram surface. */
export function renderReposList(repos: readonly RepoEntry[]): string {
  const lines = [`Registered repos (${repos.length}):`];
  if (repos.length === 0) {
    lines.push("  (none yet - /repos add <name> <path> to register one)");
  } else {
    for (const r of repos) {
      const extras = [r.base ? `base: ${r.base}` : null, r.model ? `default model: ${r.model}` : null].filter((x) => x !== null);
      lines.push(`  ${r.name} -> ${r.path}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`);
    }
  }
  lines.push(
    "",
    "/repos add <name> [path|git-url] [--base <branch>] [--model <model>] - register an already-cloned repo, clone a URL, or (if every repo above shares one parent folder) omit the path to reuse it",
    "/repos rm <name> - unregister one (leaves any existing worktree/session alone)",
  );
  return escapeForFeed(lines.join("\n"));
}

/** `/help`: the fixed fleet- and session-scoped command reference, plain text (no `parse_mode`,
 * unlike the other render functions here - the `/help` call site sends it alongside the
 * built-in/category button keyboard, not in place of it). `/commands`/`/skills` are the
 * per-project, item-count-scoped lists (see `commands.ts`'s `renderCommandsListText`/
 * `renderSkillsListText`) - this only covers what's fixed regardless of project. */
export function renderHelp(): string {
  return [
    "Fleet commands (control topic; also /help, /?, /h, or bare ? here):",
    "  /about - what this bot can do, with examples (start here if you're new)",
    "  /new [--model] <repo> <prompt> - start a new session (or send a photo/file into this topic",
    "    with that same text as its caption, to start the session with that attachment already in",
    "    its inbox)",
    "  /ls - list sessions, with what's running/waiting on each",
    "  /kill [<slug>|--all [--force]] - stop a session (or all, confirm-gated unless --force)",
    "  /rm [<slug>|--dead|--prefix <text>|--all [--force]] - remove a dead session row (--all is",
    "    confirm-gated unless --force)",
    "  /rm (bare, inside a topic with no tracked session) - offers to delete that orphaned Telegram topic itself, confirm-gated",
    "  /attach [<slug>] - show a session's PTY tail",
    "  /pause [<slug>] - pause a session",
    "  /usage [<slug>] - token/cost usage",
    "  /budget - fleet spend (5h/7d)",
    "  /restart - restart the Bridge daemon",
    "  /os shutdown|reboot|cancel - ⚠️ shut down or restart the WHOLE HOST MACHINE (not just the",
    "    Bridge), confirm-gated with a 60s window to /os cancel",
    "  /deploy <slug> - merge that session's branch into its repo, run tests, and (if the repo is",
    "    aibridge's own) restart the Bridge to pick up the fix (§5.9)",
    "  /ship [<slug>] - one-shot land to main: auto-commits uncommitted work in that session's",
    "    worktree, does /deploy's merge+gate, then pushes origin (bare, from inside that session's",
    "    own topic, targets that session - no permission buttons, this runs as trusted Bridge code)",

    "  /detail [<slug>] [compact|full] - how much of each tool call the feed card shows (default",
    "    compact); bare from inside a session's own topic, or with <slug> from the control topic",
    "  /verbose [<slug>] [on|off] - also show real tool output, not just what was asked for (default",
    "    off, only visible once /detail is full)",
    "  /settings - registered repos + concurrency budget",
    "  /repos [list|add <name> [path|git-url] [--base <b>] [--model <m>]|rm <name>] - manage repos.toml",
    "  /autostart [status|install|uninstall] - manage the logon Task Scheduler entry",
    "  /voice [<model>] - show/switch the Whisper model used for voice-note transcription",
    "  /voiceconfirm [on|off] - whether a transcribed voice note shows a Send/Re-record/Type-instead",
    "    card first before it's dispatched (default on)",
    "  /assist [on|off] - whether a natural-language-matched destructive command (kill/rm/",
    "    restart/deploy/ship/repos rm) shows a confirm card first (default on)",
    "  /router [api|cli] - natural-language routing backend: 'cli' uses your Claude Code",
    "    subscription (slower, no extra cost), 'api' uses a funded ANTHROPIC_API_KEY (faster, real",
    "    but small per-message cost). Defaults to 'cli' even if a key is configured - switch on",
    "    purpose, either direction, any time",
    "  /default [mode|effort] [<value>] - what new sessions start with (mode default manual, effort",
    "    default medium); bare /default shows a tappable picker, 'auto' mode skips permission prompts",
    "    entirely for every future session until changed back",
    "",
    "You can also just say what you want in plain English (typed or a voice note) instead of the",
    "exact command above - e.g. \"show me the sessions\" or \"restart this session\".",
    "",
    "Session commands (inside a session's own topic):",
    `  /model <${MODELS.join("|")}>`,
    `  /mode <${MODES.join("|")}>`,
    `  /effort <${EFFORTS.join("|")}>`,
    "  /commands [<term>] - list this project's .claude/commands",
    "  /skills [<term>] - list this project's .claude/skills",
    "  /browse [<path>] - browse this session's worktree, tap folders/files to navigate",
    "  /find <query> - search filenames + file content in this session's worktree",
    "  /diff - review pending (uncommitted) changes via a GitHub compare link, or a .diff file",
    "    if there's no GitHub remote",
    "",
    "Built-in passthrough is below - tap a button, or type /compact or /clear directly:",
  ].join("\n");
}

/** Drives `index.ts`'s startup `setMyCommands` call - Telegram's native "/" autocomplete popup
 * (`telegram.ts`'s `BotCommand`/`setMyCommands`). Mirrors `renderHelp()`'s content, minus the
 * `/?`/`/h`/bare-`?` aliases: Telegram command names are restricted to `[a-z0-9_]`, so those three
 * have no representable form here. The Bot API has no per-forum-topic command scope (only whole-chat
 * scopes), so this single list necessarily includes both fleet- and session-scoped commands together
 * - a suggestion tapped from the wrong topic just falls through to the existing wrong-topic rejection
 * the text parser already sends, rather than being filtered out by Telegram itself. */
/**
 * Is this text an invocation of a command this bot actually recognises? Keyed off `botCommandList()`
 * so it can't drift from the real command set (the same source `nl-router.ts`'s coverage test uses).
 *
 * Used by the inbound gate for a topic with no route and no session row: a leading "/" alone is not
 * enough there, because anything unrecognised would fall through to the NL router and spend an LLM
 * call on a topic nothing can act on. Tolerates Telegram's `@botname` suffix and mixed case, both of
 * which a phone keyboard produces routinely.
 */
export function isKnownCommandText(text: string | undefined): boolean {
  const first = (text ?? "").trim().split(/\s+/)[0] ?? "";
  const match = /^\/([A-Za-z0-9_]+)(?:@\S+)?$/.exec(first);
  if (!match) return false;
  const name = (match[1] ?? "").toLowerCase();
  return botCommandList().some((c) => c.command === name);
}

export function botCommandList(): { command: string; description: string }[] {
  return [
    { command: "about", description: "What this bot can do, with examples" },
    { command: "new", description: "Start a new session: /new [--model] <repo> <prompt> (or a captioned attachment here)" },
    { command: "ls", description: "List sessions, with what's running/waiting on each" },
    { command: "kill", description: "Stop a session: /kill [<slug>|--all [--force]]" },
    { command: "rm", description: "Remove a dead session row: /rm [<slug>|--dead|--prefix <text>|--all [--force]]" },
    { command: "attach", description: "Show a session's PTY tail" },
    { command: "stop", description: "Interrupt the current turn (Escape) - session stays alive: /stop [<slug>]" },
    { command: "pause", description: "Pause a session" },
    { command: "usage", description: "Token/cost usage" },
    { command: "budget", description: "Fleet spend (5h/7d)" },
    { command: "restart", description: "Restart the Bridge daemon" },
    { command: "os", description: "Shut down or reboot the HOST MACHINE (not just the Bridge): /os shutdown|reboot|cancel - confirm-gated" },
    { command: "deploy", description: "Merge a session's branch and run tests: /deploy <slug> (restarts if it's aibridge's own repo)" },
    { command: "ship", description: "One-shot land to main: /ship [<slug>] - auto-commits uncommitted work, /deploy's merge+gate, then pushes origin (bare, inside a session's own topic, targets that session)" },
    { command: "detail", description: "Feed card detail level: /detail [<slug>] [compact|full]" },
    { command: "verbose", description: "Show real tool output on the feed card: /verbose [<slug>] [on|off]" },
    { command: "settings", description: "Registered repos + concurrency budget" },
    { command: "repos", description: "Manage repos.toml: list|add <name> [path|git-url]|rm <name>" },
    { command: "autostart", description: "Manage the logon Task Scheduler entry: status|install|uninstall" },
    { command: "voice", description: "Show/switch the Whisper model used for voice-note transcription" },
    { command: "voiceconfirm", description: "Confirm before sending a transcribed voice note: /voiceconfirm [on|off]" },
    { command: "assist", description: "Confirm before running a natural-language-matched destructive command: /assist [on|off]" },
    { command: "router", description: "NL-routing backend: /router [api|cli] - subscription (cli, default) or a funded API key (api)" },
    { command: "default", description: "What new sessions start with: /default [mode|effort] [<value>] - bare shows a tappable picker" },
    { command: "help", description: "Show the full command list" },
    { command: "model", description: `Set model: /model <${MODELS.join("|")}>` },
    { command: "mode", description: `Set mode: /mode <${MODES.join("|")}>` },
    { command: "effort", description: `Set effort: /effort <${EFFORTS.join("|")}>` },
    { command: "commands", description: "List this project's .claude/commands: /commands [<term>]" },
    { command: "skills", description: "List this project's .claude/skills: /skills [<term>]" },
    { command: "browse", description: "Browse this session's worktree: /browse [<path>]" },
    { command: "find", description: "Search filenames + content in this session's worktree: /find <query>" },
    { command: "diff", description: "Review pending changes via a GitHub compare link (or a .diff file if there's no GitHub remote)" },
    { command: "retry", description: "Re-arm the last expired confirmation in this topic (also works as spoken/typed 'retry'/'try again')" },
    { command: "compact", description: "Compact the session's conversation" },
    { command: "clear", description: "Clear the session's conversation" },
  ];
}

/** §4.2's `/attach`: the PTY tail plus the local pickup command - both best-effort, same "takes it
 * on faith" convention as `/model`'s confirmation (§4.2.1). Markdown-style triple backticks render
 * as literal text without a matching `parse_mode`, so this uses the same HTML `<pre>` convention as
 * `renderLsTable` - callers must pass `parseMode: "HTML"`. */
export function renderAttach(row: SessionRow, tail: string): string {
  const resumeHint = row.sessionId ? `claude --resume ${row.sessionId}` : "(no session_id recorded yet)";
  return `${escapeForFeed(row.slug)} - last output:\n<pre>${escapeForFeed(tail)}</pre>\nLocal pickup: <code>${escapeForFeed(resumeHint)}</code>`;
}
