import { execFile } from "node:child_process";
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import type { FleetCommand, RmBulkFilter } from "./fleet-commands.ts";
import { EFFORTS, MODELS, MODES } from "./session-commands.ts";
import type { Effort, Mode, Model, SessionCommand } from "./session-commands.ts";

/**
 * Natural-language command routing: free text (typed, or a voice transcript re-entering the same
 * path per voice-confirm.ts) that isn't already an exact `/command` gets one forced-structured-
 * output classification call before falling through to "unrecognised" / forwarded-to-session. Two
 * backends (`config.ts`'s `nlRouter.backend`) share this one JSON Schema and the same mapping back
 * to a real `FleetCommand`/`SessionCommand` - only the transport differs (`routeViaApi`/`routeViaCli`
 * below). See `config.ts`'s doc comment for the live-measured latency/cost tradeoff between them.
 *
 * The schema is deliberately one flat bag of optional fields keyed by a `kind` discriminator,
 * rather than a `oneOf` of per-kind shapes - both backends' structured-output support is safest
 * treated as "validates a flat object", not relied on for a nested union, and `mapRouterOutput`
 * below does the real per-kind validation anyway (same "don't trust one exact shape" discipline as
 * `parseWhisperServerResponse` in voice-transcribe.ts) - a field present but invalid for its kind
 * is a no-match, not a guess.
 */

export type RouterContext = {
  /** Control topic (no session attached) vs. a session's own topic. */
  isControl: boolean;
  /** Whether `ctx`'s topic has a live session to act on - gates session commands and the slug-less
   * "act on the current session" reading of kill/rm/attach/pause/usage/detail/verbose. */
  hasSession: boolean;
};

/** Not real `FleetCommand`/`SessionCommand` kinds - each is handled by its own dedicated function
 * in index.ts rather than `dispatchFleetCommand`, but all five are real, always-available commands
 * a natural-language message can legitimately mean, so the router needs to recognise them as their
 * own outcome rather than only ever mapping to the fleet/session command unions. `help`/`about`
 * were a live-observed gap (a Russian "show me the commands" phrase fell through to "Unrecognised"
 * without them, 2026-08-06); `commands`/`skills`/`builtin` were added in the same pass for the same
 * reason - completeness, not because any one of them was separately reported broken. None are ever
 * destructive. */
export type RouterAction =
  | { kind: "help" }
  | { kind: "about" }
  | { kind: "commands"; term: string }
  | { kind: "skills"; term: string }
  | { kind: "builtin"; name: "compact" | "clear" };

export type RouterResult = { matched: false } | { matched: true; command: FleetCommand | SessionCommand | RouterAction; destructive: boolean };

/** Single-slug/bulk `/kill`/`/rm`, `/restart`, `/deploy`, `/repos rm` - broader than the CLI's own
 * confirm-gated set (only `kill --all`/`rm --all`, `fleet-confirm.ts`) because an NL match is
 * inherently less certain than an operator typing the exact command. `kill --all`/`rm --all`
 * themselves are the deliberate exception - they already funnel into that existing fleet-confirm
 * flow unchanged the moment they execute (`index.ts`'s `handleKillCommand`/`handleRmCommand`), so
 * marking them destructive *here too* would stack a second, redundant confirm card in front of the
 * first. */
function isDestructive(command: FleetCommand | SessionCommand | RouterAction): boolean {
  if (command.kind === "kill") return !command.all;
  if (command.kind === "rm") return command.bulk?.mode !== "all";
  if (command.kind === "restart" || command.kind === "deploy") return true;
  if (command.kind === "repos" && command.action === "rm") return true;
  return false;
}

/**
 * Every `FleetCommand["kind"]` value (`fleet-commands.ts`) has a matching entry here, one-to-one
 * by name - `nl-router.test.ts`'s "ROUTER_KINDS completeness" test asserts this against a literal
 * copy of that union so a future new fleet command that forgets to update this list fails a test
 * immediately, the same
 * class of gap that let `/help`/`/about`/`/commands`/`/skills`/`/compact`/`/clear` go unrouted
 * until 2026-08-06. `session_model`/`session_mode`/`session_effort` are `SessionCommand`'s
 * `model`/`mode`/`effort` under a router-only prefix (avoids a naming collision with `new`'s own
 * `model` field in the flat schema below); `help`/`about`/`commands`/`skills`/`builtin` are
 * `RouterAction`'s kinds, covering the fixed always-available commands that live outside both
 * unions (`isHelpCommand`/`isAboutCommand`/`parseCommandsQuery`/`parseSkillsQuery`/
 * `isBuiltinPassthroughCommand` in index.ts/fleet-commands.ts/commands.ts).
 */
export const ROUTER_KINDS = [
  "new",
  "ls",
  "kill",
  "rm",
  "attach",
  "pause",
  "usage",
  "budget",
  "restart",
  "deploy",
  "detail",
  "verbose",
  "settings",
  "autostart",
  "repos",
  "voice",
  "voiceconfirm",
  "assist",
  "router",
  "session_model",
  "session_mode",
  "session_effort",
  "help",
  "about",
  "commands",
  "skills",
  "builtin",
  "forward",
] as const;
type RouterKind = (typeof ROUTER_KINDS)[number];

/** Narrows the offered `kind` values to what `dispatchInboundMessage` (index.ts) would actually
 * accept in this context - mirrors that function's own inline `isControl`/`currentSlug` checks
 * rather than inventing separate rules. `/new` and `/budget` are the only fleet commands rejected
 * outright outside the control topic; the rest (kill/rm/attach/etc.) accept an optional slug from
 * either place, so they stay offered everywhere, as do `/help`/`/about`/`/assist`/`/router`.
 * `/commands`/`/skills`/`/compact`/`/clear` are all session-scoped in practice (no worktree/PTY to
 * act on without one - `dispatchInboundMessage`'s own `route`/`currentSlug` checks agree), so they
 * follow the same `hasSession` gate as the three session commands. */
function allowedKinds(ctx: RouterContext): RouterKind[] {
  return ROUTER_KINDS.filter((kind) => {
    if ((kind === "new" || kind === "budget") && !ctx.isControl) return false;
    if (
      (kind === "session_model" || kind === "session_mode" || kind === "session_effort" || kind === "commands" || kind === "skills" || kind === "builtin") &&
      !ctx.hasSession
    )
      return false;
    return true;
  });
}

/** The JSON Schema shared by both backends - see the module doc comment for why this is one flat
 * bag rather than a `oneOf`. `kind` is restricted to `allowedKinds(ctx)` per call, not the full
 * list, so the model is never offered a command this context would reject anyway. */
function buildSchema(ctx: RouterContext): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: allowedKinds(ctx) },
      slug: { type: "string", description: "A session's slug, if the message names one specifically." },
      repo: { type: "string", description: "For 'new': the short repo name from repos.toml." },
      prompt: { type: "string", description: "For 'new': the task to hand the new session." },
      model: { type: "string", enum: [...MODELS], description: "For 'new' or 'session_model'." },
      all: { type: "boolean", description: "For 'kill'/'rm': act on every session." },
      bulkMode: { type: "string", enum: ["dead", "prefix"], description: "For 'rm': bulk-remove dead rows, optionally by prefix." },
      bulkPrefix: { type: "string", description: "For 'rm' with bulkMode 'prefix'." },
      level: { type: "string", enum: ["compact", "full"], description: "For 'detail'." },
      on: { type: "boolean", description: "For 'verbose'." },
      reposAction: { type: "string", enum: ["list", "add", "rm"], description: "For 'repos'." },
      reposName: { type: "string", description: "For 'repos add'/'repos rm'." },
      reposPath: { type: "string", description: "For 'repos add', optional." },
      reposBase: { type: "string", description: "For 'repos add', optional." },
      autostartAction: { type: "string", enum: ["status", "install", "uninstall"], description: "For 'autostart'." },
      voiceModel: { type: "string", description: "For 'voice', optional model name to switch to." },
      mode: { type: "string", enum: [...MODES], description: "For 'session_mode'." },
      effort: { type: "string", enum: [...EFFORTS], description: "For 'session_effort'." },
      assistAction: { type: "string", enum: ["status", "on", "off"], description: "For 'assist': confirm-before-destructive-NL-command toggle." },
      voiceConfirmAction: { type: "string", enum: ["status", "on", "off"], description: "For 'voiceconfirm': confirm-before-sending-a-transcribed-voice-note toggle." },
      routerAction: { type: "string", enum: ["status", "api", "cli"], description: "For 'router': NL-routing backend toggle." },
      term: { type: "string", description: "For 'commands'/'skills': an optional search term to filter the list." },
      builtinName: { type: "string", enum: ["compact", "clear"], description: "For 'builtin': which built-in Claude Code command to run." },
    },
    required: ["kind"],
    additionalProperties: false,
  };
}

const SYSTEM_INSTRUCTIONS =
  "You classify one Telegram message sent to a fleet-control bot for developer Claude Code sessions. " +
  "If the message clearly requests one of the listed commands, respond with that kind and its fields. " +
  "A request to see what commands exist, what the bot can do, or how to use it (in any language) is " +
  "kind='help' (a plain command list) or kind='about' (a friendlier overview with examples) - prefer " +
  "'help' unless the message specifically sounds like someone new asking what this bot even is. " +
  "A request to list this project's own custom commands or skills is kind='commands'/'skills'. " +
  "A request to compact or clear the current conversation is kind='builtin'. " +
  "If it's ambiguous, conversational, or addressed to a coding assistant rather than the fleet itself, " +
  "respond with kind='forward' - never guess a destructive command (kill/rm/restart/deploy/repos-rm) " +
  "from a vague or joking message.";

/** Raw shape returned by either backend, before per-kind validation. Every field optional except
 * `kind` - matches `buildSchema`'s own looseness. */
interface RawRouterOutput {
  kind?: string;
  slug?: string;
  repo?: string;
  prompt?: string;
  model?: string;
  all?: boolean;
  bulkMode?: string;
  bulkPrefix?: string;
  level?: string;
  on?: boolean;
  reposAction?: string;
  reposName?: string;
  reposPath?: string;
  reposBase?: string;
  autostartAction?: string;
  voiceModel?: string;
  mode?: string;
  effort?: string;
  assistAction?: string;
  voiceConfirmAction?: string;
  routerAction?: string;
  term?: string;
  builtinName?: string;
}

function isModel(v: unknown): v is Model {
  return typeof v === "string" && (MODELS as readonly string[]).includes(v);
}
function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}
function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

/**
 * Validates and maps the raw structured output into a real `FleetCommand`/`SessionCommand`. A
 * `kind` outside `allowedKinds(ctx)`, or missing/invalid required fields for that kind, is a
 * no-match (`{ matched: false }`) rather than a best-effort guess - same "fail open to today's
 * fallthrough" posture the router needs everywhere else (`nl-router.ts`'s module doc comment).
 */
export function mapRouterOutput(raw: RawRouterOutput, ctx: RouterContext): RouterResult {
  const kind = raw.kind;
  if (!kind || !allowedKinds(ctx).includes(kind as RouterKind)) return { matched: false };

  const command = ((): FleetCommand | SessionCommand | RouterAction | null => {
    switch (kind as RouterKind) {
      case "help":
        return { kind: "help" };
      case "about":
        return { kind: "about" };
      case "new":
        return raw.repo && raw.prompt ? { kind: "new", repo: raw.repo, prompt: raw.prompt, model: isModel(raw.model) ? raw.model : undefined } : null;
      case "ls":
        return { kind: "ls" };
      case "kill":
        return { kind: "kill", slug: raw.slug, all: raw.all === true };
      case "rm": {
        const bulk: RmBulkFilter | undefined =
          raw.all === true
            ? { mode: "all" }
            : raw.bulkMode === "dead"
              ? { mode: "dead" }
              : raw.bulkMode === "prefix" && raw.bulkPrefix
                ? { mode: "prefix", prefix: raw.bulkPrefix }
                : undefined;
        return { kind: "rm", slug: raw.slug, bulk };
      }
      case "attach":
        return { kind: "attach", slug: raw.slug };
      case "pause":
        return { kind: "pause", slug: raw.slug };
      case "usage":
        return { kind: "usage", slug: raw.slug };
      case "budget":
        return { kind: "budget" };
      case "restart":
        return { kind: "restart" };
      case "deploy":
        return raw.slug ? { kind: "deploy", slug: raw.slug } : null;
      case "detail":
        return { kind: "detail", slug: raw.slug, level: raw.level === "compact" || raw.level === "full" ? raw.level : undefined };
      case "verbose":
        return { kind: "verbose", slug: raw.slug, on: raw.on };
      case "settings":
        return { kind: "settings" };
      case "autostart":
        return raw.autostartAction === "status" || raw.autostartAction === "install" || raw.autostartAction === "uninstall"
          ? { kind: "autostart", action: raw.autostartAction }
          : null;
      case "repos":
        if (raw.reposAction === "list") return { kind: "repos", action: "list" };
        if (raw.reposAction === "add" && raw.reposName) return { kind: "repos", action: "add", name: raw.reposName, path: raw.reposPath, base: raw.reposBase };
        if (raw.reposAction === "rm" && raw.reposName) return { kind: "repos", action: "rm", name: raw.reposName };
        return null;
      case "voice":
        return { kind: "voice", model: raw.voiceModel };
      case "assist":
        return raw.assistAction === "status" || raw.assistAction === "on" || raw.assistAction === "off" ? { kind: "assist", action: raw.assistAction } : null;
      case "voiceconfirm":
        return raw.voiceConfirmAction === "status" || raw.voiceConfirmAction === "on" || raw.voiceConfirmAction === "off"
          ? { kind: "voiceconfirm", action: raw.voiceConfirmAction }
          : null;
      case "router":
        return raw.routerAction === "status" || raw.routerAction === "api" || raw.routerAction === "cli" ? { kind: "router", action: raw.routerAction } : null;
      case "commands":
        return { kind: "commands", term: raw.term ?? "" };
      case "skills":
        return { kind: "skills", term: raw.term ?? "" };
      case "builtin":
        return raw.builtinName === "compact" || raw.builtinName === "clear" ? { kind: "builtin", name: raw.builtinName } : null;
      case "session_model":
        return isModel(raw.model) ? { kind: "model", model: raw.model } : null;
      case "session_mode":
        return isMode(raw.mode) ? { kind: "mode", mode: raw.mode } : null;
      case "session_effort":
        return isEffort(raw.effort) ? { kind: "effort", effort: raw.effort } : null;
      case "forward":
        return null;
      default:
        return null;
    }
  })();

  if (!command) return { matched: false };
  return { matched: true, command, destructive: isDestructive(command) };
}

export type RouterLog = (level: "WARN" | "ERROR", msg: string) => void;

/** Direct `@anthropic-ai/sdk` call - `config.ts`'s `"api"` backend. Forces a single tool call
 * (`tool_choice: { type: "tool", name: "route" }`) so the response is always the schema's shape,
 * never free text to parse. */
async function routeViaApi(text: string, ctx: RouterContext, apiKey: string, model: string, log: RouterLog): Promise<RawRouterOutput | null> {
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: 512,
      system: SYSTEM_INSTRUCTIONS,
      messages: [{ role: "user", content: text }],
      tools: [{ name: "route", description: "Classify the message.", input_schema: buildSchema(ctx) as Anthropic.Tool.InputSchema }],
      tool_choice: { type: "tool", name: "route" },
    });
    const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (!toolUse) return null;
    return toolUse.input as RawRouterOutput;
  } catch (err) {
    log("WARN", `nl-router (api backend) call failed: ${(err as Error).message}`);
    return null;
  }
}

/** `claude -p --json-schema` - `config.ts`'s `"cli"` backend, using the operator's existing
 * subscription rather than a separate API key. Run from the OS temp dir, not the Bridge's own
 * cwd or any worktree - live-measured 2026-08-06: even an *empty* directory still costs ~20-30k
 * tokens of the CLI's own fixed system-prompt/tool-schema overhead, and running from inside a real
 * project would additionally load its CLAUDE.md on every single call for no benefit here. */
function routeViaCli(text: string, ctx: RouterContext, model: string, log: RouterLog): Promise<RawRouterOutput | null> {
  return new Promise((resolve) => {
    const schema = JSON.stringify(buildSchema(ctx));
    execFile(
      "claude",
      ["-p", `${SYSTEM_INSTRUCTIONS}\n\nMessage: ${text}`, "--output-format", "json", "--json-schema", schema, "--model", model],
      { cwd: os.tmpdir(), timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          log("WARN", `nl-router (cli backend) call failed: ${(err as Error).message}`);
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { structured_output?: RawRouterOutput };
          resolve(parsed.structured_output ?? null);
        } catch {
          log("WARN", "nl-router (cli backend): couldn't parse claude -p's stdout as JSON");
          resolve(null);
        }
      },
    );
  });
}

export interface RouterConfig {
  enabled: boolean;
  apiKey: string | undefined;
  model: string;
  backend: "api" | "cli";
}

/** Entry point. Never throws and never blocks a message on a slow/erroring call for longer than
 * necessary - both backends already catch their own failures and resolve `null`, which becomes
 * `{ matched: false }` here, the same "fail open to today's fallthrough" contract every caller in
 * index.ts should rely on. */
export async function routeText(text: string, ctx: RouterContext, cfg: RouterConfig, log: RouterLog): Promise<RouterResult> {
  if (!cfg.enabled) return { matched: false };
  if (cfg.backend === "api") {
    if (!cfg.apiKey) {
      log("WARN", "nl-router: backend is 'api' but ANTHROPIC_API_KEY is missing - routing disabled until it's set.");
      return { matched: false };
    }
    const raw = await routeViaApi(text, ctx, cfg.apiKey, cfg.model, log);
    return raw ? mapRouterOutput(raw, ctx) : { matched: false };
  }
  const raw = await routeViaCli(text, ctx, cfg.model, log);
  return raw ? mapRouterOutput(raw, ctx) : { matched: false };
}
