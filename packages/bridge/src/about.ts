/**
 * `/about`: a friendly, short capability overview - distinct from `/help` (§4.2's fixed
 * command-syntax reference, one line per command, no prose). `/about` answers "what can this bot
 * even do" for someone who hasn't read the plan doc, then offers a "more info" button per feature
 * that's too fiddly to explain in one line (bulk `/rm`, permission modes, autostart, the
 * approve/deny/always buttons) - tapping one sends a short worked example instead of making the
 * overview itself longer. `/help` still owns the exhaustive syntax list; `/about` is the on-ramp.
 */
import type { InlineKeyboardButton } from "./commands.ts";

/** `/about` (bare, no aliases - unlike `/help` there's no established `?`/`/h` shorthand to match,
 * and this is new enough not to need one). Works from either the control topic or a session's own
 * topic, same as `/help`. */
export function isAboutCommand(text: string): boolean {
  return text.trim() === "/about";
}

/**
 * One entry per drill-down topic. `blurb` is the one-liner shown in the `/about` overview itself;
 * `details` is the fuller example-driven text sent when the matching button is tapped. Keyed by a
 * short id used verbatim in callback_data (`about:<id>`), so ids must stay `[a-z_]+` - re-validated
 * in `resolveAboutCallback` since callback_data is attacker-shaped input in principle.
 */
export const ABOUT_TOPICS: Record<string, { label: string; blurb: string; details: string }> = {
  sessions: {
    label: "Starting & managing sessions",
    blurb: "Start, list, pause, and stop Claude sessions - each gets its own Telegram topic.",
    details: [
      "Each session is its own Claude Code process, in its own git worktree/branch, with its own Telegram topic.",
      "",
      "Examples:",
      "  /new seowrite fix the flaky CI test - start a session against the 'seowrite' repo (see /settings for registered repos)",
      "  /new --opus seowrite refactor the export pipeline - same, but on Opus instead of the default model",
      "  /ls - table of every session: slug, state, model, branch, age, cost",
      "  /pause seowrite-1 - stop feed updates for that topic without stopping the session (replies/prompts still flow)",
      "  /kill seowrite-1 - stop the session, keep the worktree",
      "  /rm seowrite-1 - stop the session AND remove its worktree/topic",
      "",
      "Inside a session's own topic, /kill, /pause, /attach and /usage all work with no argument - they act on that session.",
    ].join("\n"),
  },
  bulk_rm: {
    label: "Bulk-removing dead sessions",
    blurb: "/rm can clear many dead rows at once instead of one at a time.",
    details: [
      "/rm --dead removes every session currently in the 'dead' state.",
      "/rm --prefix seowrite- removes every dead session whose slug starts with 'seowrite-'.",
      "/rm --all removes every session regardless of state (including live ones) - this is destructive, so it asks for a Yes/No confirm tap before doing anything, unlike the other two.",
      "",
      "/kill --all is the same idea for stopping (not removing) everything live - also confirm-gated.",
      "",
      "A bare /rm sent inside a topic the Bridge has no session row for (e.g. a Telegram topic left behind after an earlier removal) offers to delete that topic itself instead - also confirm-gated.",
    ].join("\n"),
  },
  tuning: {
    label: "Model, mode & effort",
    blurb: "Switch a running session's model, permission mode, or reasoning effort mid-conversation.",
    details: [
      "All three are session-scoped - send them inside that session's own topic, not the control topic.",
      "",
      "/model sonnet|opus|haiku|fable - switch the model live.",
      "/mode manual|acceptEdits|plan|auto - switch how permission prompts are handled:",
      "  manual - every non-allowlisted action asks first (the default, and what the approve/deny buttons are for)",
      "  acceptEdits - file edits are auto-approved, everything else still asks",
      "  plan - Claude plans but doesn't execute until you approve the plan",
      "  auto - nothing asks (use with care - see /about permissions)",
      "/effort low|medium|high|xhigh|max - switch reasoning effort.",
      "",
      "Send any of the three with no argument (just \"/model\") to get a button per choice instead of typing the name.",
    ].join("\n"),
  },
  permissions: {
    label: "Approving actions",
    blurb: "Risky actions raise Approve/Deny/Always buttons instead of running silently.",
    details: [
      "Safe reads/builds/tests are pre-approved automatically. Anything else (writes, git commit/push, network calls, ...) posts an inline card with three buttons:",
      "",
      "  Allow - run this one action, ask again next time",
      "  Deny - refuse this one action",
      "  Always - run it now AND add a matching rule so this exact kind of action is pre-approved for the rest of this session",
      "",
      "A card left untapped for 30 minutes is treated as stale - the eventual tap still works, but the Bridge double-checks nothing changed underneath it first. Restarting the Bridge while a card is outstanding loses that specific prompt (you'll be told, and asked to re-ask).",
    ].join("\n"),
  },
  autostart: {
    label: "Autostart on logon",
    blurb: "Have the Bridge launch itself automatically when you log in to the Windows machine it runs on.",
    details: [
      "This is about the machine running the Bridge daemon itself (the Windows PC/server it's installed on) - not the phone or laptop you're reading Telegram from, which has nothing to autostart.",
      "",
      "/autostart (no argument) - show whether the logon task is currently installed.",
      "/autostart install - register a Task Scheduler entry that starts the Bridge on your next logon to that machine (no admin rights needed).",
      "/autostart uninstall - remove it.",
      "",
      "This only affects whether the Bridge starts automatically - it doesn't touch any running session.",
    ].join("\n"),
  },
  repo_commands: {
    label: "Project commands & skills",
    blurb: "Browse and run a project's own .claude/commands and .claude/skills from Telegram.",
    details: [
      "/commands - list this session's project-defined slash commands (e.g. .claude/commands/review/pre-push.md shows as \"review/pre-push\").",
      "/commands pre-push - filter that list by a search term instead of scrolling a long one.",
      "/skills / /skills <term> - same idea, for .claude/skills.",
      "",
      "/cmd review/pre-push some args - actually run one, with arguments. (/commands review/pre-push same args also works - they're synonyms.)",
      "",
      "These are per-project and only work inside a session's own topic - a fresh repo can have dozens of each, so browsing is search-as-you-type rather than one button per item.",
    ].join("\n"),
  },
};

/** `/about`'s overview text: what the bot is, then a one-liner per topic, pointing at the buttons
 * below for anything that needs a worked example. `/help` is named explicitly since it's the
 * complementary "give me the exact syntax" reference this deliberately doesn't try to be. */
export function renderAbout(): string {
  const lines = [
    "aibridge lets you run and manage several Claude Code sessions from Telegram - one topic per session, against any registered project repo.",
    "",
    "What you can do:",
    ...Object.values(ABOUT_TOPICS).map((t) => `  • ${t.blurb}`),
    "",
    "Tap a button below for examples on any of these, or send /help for the exact command syntax.",
  ];
  return lines.join("\n");
}

/** Builds `/about`'s "more info" keyboard: one button per topic, in the same order as
 * `renderAbout()`'s bullet list. */
export function buildAboutKeyboard(): InlineKeyboardButton[][] {
  return Object.entries(ABOUT_TOPICS).map(([id, topic]) => [{ text: topic.label, callback_data: `about:${id}` }]);
}

/** Parses an `about:<id>` callback_data string, re-validating `id` against the known topic set
 * since callback_data is attacker-shaped input in principle (same discipline as
 * `resolveCommandAction`'s builtin-name check). Returns null for anything else, including an
 * unknown id. */
export function resolveAboutCallback(data: string): string | null {
  const match = data.match(/^about:([a-z_]+)$/);
  if (!match) return null;
  const id = match[1] ?? "";
  return id in ABOUT_TOPICS ? id : null;
}
