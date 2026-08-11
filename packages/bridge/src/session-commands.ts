/**
 * `/model` and `/mode` (§4.2.1, §4.2.2): the two session commands that cannot be a `/cmd`-style shim,
 * because neither has a backing markdown file for Claude to read and follow - both are CLI-native and
 * only exist as something typed (or, for `/mode`, key-cycled) at the prompt. index.ts writes the
 * resulting text/keystrokes straight to the PTY, bypassing `renderChannelTag` entirely.
 */

export const MODELS = ["sonnet", "opus", "haiku", "fable"] as const;
export type Model = (typeof MODELS)[number];

// §4.2.2: the permission-mode picker's own listed order, cycled via Shift+Tab. Inferred, not yet
// live-verified - see the plan's honest caveat before this ships.
export const MODES = ["manual", "acceptEdits", "plan", "auto"] as const;
export type Mode = (typeof MODES)[number];

export const DEFAULT_MODE: Mode = "manual";

// Direct-argument CLI command, same shape as /model - not yet independently live-verified the way
// Phase 2's MCP notification path was (killing the live spike session to watch its mirrored PTY was
// blocked by the auto-mode classifier), but it's the same "type it, press Enter, no ack" mechanism
// /model already proves works, so it carries the same risk /model does, not a new one.
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

// Live-observed default (§4.2.1's PTY status line reads "◐ medium" on a freshly spawned session
// with no /effort ever sent) - same "tracked starting value until the first switch" convention as
// DEFAULT_MODE below, not a verified API-level default.
export const DEFAULT_EFFORT: Effort = "medium";

/** Standard xterm Shift+Tab (back-tab). One press advances the picker by exactly one entry. */
export const SHIFT_TAB = "\x1b[Z";

/** Plain Escape. `/stop` (§4.2) writes this raw to the PTY - the same interrupt-current-turn
 * keystroke the Claude Code TUI's own "stop" button/Esc-while-working binding sends, as opposed to
 * Ctrl+C (`\x03`) which is a harder "exit" signal most TUIs treat as a second, more drastic
 * request. No trailing `\r`: it's a control byte the TUI consumes immediately, not a typed line. */
export const ESCAPE = "\x1b";

export type SessionCommand =
  | { kind: "model"; model: Model }
  | { kind: "mode"; mode: Mode }
  | { kind: "effort"; effort: Effort };

function isModel(value: string): value is Model {
  return (MODELS as readonly string[]).includes(value);
}

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}

function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

/**
 * Returns null for anything that isn't one of these two commands - including a recognised command
 * name with a bad argument, so the caller can tell "not for us" apart from "for us, but invalid"
 * only by also calling the more specific parse below when it needs the rejection message.
 */
export function parseSessionCommand(text: string): SessionCommand | null {
  const trimmed = text.trim();
  const modelMatch = trimmed.match(/^\/model\s+(\S+)$/);
  if (modelMatch) {
    const arg = (modelMatch[1] ?? "").toLowerCase();
    return isModel(arg) ? { kind: "model", model: arg } : null;
  }
  const modeMatch = trimmed.match(/^\/mode\s+(\S+)$/);
  if (modeMatch) {
    const arg = modeMatch[1] ?? "";
    return isMode(arg) ? { kind: "mode", mode: arg } : null;
  }
  const effortMatch = trimmed.match(/^\/effort\s+(\S+)$/);
  if (effortMatch) {
    const arg = (effortMatch[1] ?? "").toLowerCase();
    return isEffort(arg) ? { kind: "effort", effort: arg } : null;
  }
  return null;
}

/** True for `/model ...`, `/mode ...` or `/effort ...` regardless of whether the argument is
 * valid - lets the caller distinguish "recognised command, bad argument" (reject with the valid
 * list) from "not one of these commands at all" (fall through to the ordinary inbound-message
 * path). */
export function isSessionCommandAttempt(text: string): boolean {
  return /^\/(model|mode|effort)\s+/.test(text.trim());
}

/**
 * §4.2.2: the Shift+Tab presses separating `current` from `target` in the cycle, wrapping forward
 * only (the picker has no "previous" direction) - **one array entry per press**, empty if already
 * there. The caller must write them to the PTY spaced apart.
 *
 * There used to be a `buildModeKeystrokes` beside this returning `SHIFT_TAB.repeat(steps)`, one
 * concatenated string. That is exactly the 2026-08-10 defect: written in a single go, a three-press
 * manual->auto switch advanced the picker once (`manual` -> `accept edits on`), because the TUI
 * consumes one key per render frame and discards the rest of the buffer. It was deleted rather than
 * kept for its distance tests - a correct-looking function whose only remaining consumer was its own
 * test, sitting next to the one that replaced it, is how the same burst gets reintroduced.
 */
export function buildModeKeystrokeSteps(current: Mode, target: Mode): string[] {
  const from = MODES.indexOf(current);
  const to = MODES.indexOf(target);
  const steps = (to - from + MODES.length) % MODES.length;
  return Array.from({ length: steps }, () => SHIFT_TAB);
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** A bare `/model`, `/mode` or `/effort` with no argument (no valid target to act on) surfaces a
 * button per option, same UX as the `/help` command list, instead of falling through as ordinary
 * chat text - confirmed live that a bare `/effort` otherwise lands as a plain message Claude
 * answers conversationally rather than a command the CLI intercepts. `current`, when known, gets a
 * "✓ " prefix on its own button so the operator can see where they already are without having to
 * remember or go check - and a trailing "✖️ Cancel" row lets them back out without picking anything,
 * rather than the only escape being to type over the card with an unrelated message. */
function buildLevelKeyboard<T extends string>(namespace: string, levels: readonly T[], current?: T): InlineKeyboardButton[][] {
  const rows = levels.map((level) => [{ text: level === current ? `✓ ${level}` : level, callback_data: `${namespace}:${level}` }]);
  rows.push([{ text: "✖️ Cancel", callback_data: `${namespace}:cancel` }]);
  return rows;
}

/**
 * Parses a `<namespace>:<value>` callback_data string, re-validating against `isValid` rather
 * than trusting the tap - same defensive pattern as resolveCommandAction/resolvePermCallback,
 * since callback_data is attacker-shaped input in principle. "cancel" is reserved (never a valid
 * `T`) so it always falls through here as a non-match - callers check `isLevelCancelCallback`
 * first to tell "cancelled" apart from "unrecognised".
 */
function resolveLevelCallback<T extends string>(namespace: string, data: string, isValid: (value: string) => value is T): T | null {
  const match = data.match(new RegExp(`^${namespace}:(.+)$`));
  if (!match) return null;
  const value = match[1] ?? "";
  return isValid(value) ? value : null;
}

/** True for `<namespace>:cancel` - checked ahead of `resolveLevelCallback` since "cancel" is never
 * a valid level and would otherwise just look like an unrecognised tap. */
function isLevelCancelCallback(namespace: string, data: string): boolean {
  return data === `${namespace}:cancel`;
}

export const buildModelKeyboard = (current?: Model): InlineKeyboardButton[][] => buildLevelKeyboard("model", MODELS, current);
export const buildModeKeyboard = (current?: Mode): InlineKeyboardButton[][] => buildLevelKeyboard("mode", MODES, current);
export const buildEffortKeyboard = (current?: Effort): InlineKeyboardButton[][] => buildLevelKeyboard("effort", EFFORTS, current);

export const resolveModelCallback = (data: string): Model | null => resolveLevelCallback("model", data, isModel);
export const resolveModeCallback = (data: string): Mode | null => resolveLevelCallback("mode", data, isMode);
export const resolveEffortCallback = (data: string): Effort | null => resolveLevelCallback("effort", data, isEffort);

export const isModelCancelCallback = (data: string): boolean => isLevelCancelCallback("model", data);
export const isModeCancelCallback = (data: string): boolean => isLevelCancelCallback("mode", data);
export const isEffortCancelCallback = (data: string): boolean => isLevelCancelCallback("effort", data);

/** `/default`'s own value pickers - same `buildLevelKeyboard` shape as the session-scoped
 * `/mode`/`/effort` pickers above, but under a distinct `defmode:`/`defeffort:` callback namespace.
 * Deliberately not `mode:`/`effort:` - those are resolved (index.ts) against `currentSlug`, which
 * is nonsense in the control-topic-only context `/default` lives in (no session to apply to); a tap
 * misrouted onto the wrong namespace would silently no-op rather than doing anything visibly wrong,
 * which is worse than a clean "unrecognised", hence the separate namespace rather than reusing one. */
export const buildDefaultModeKeyboard = (current?: Mode): InlineKeyboardButton[][] => buildLevelKeyboard("defmode", MODES, current);
export const buildDefaultEffortKeyboard = (current?: Effort): InlineKeyboardButton[][] => buildLevelKeyboard("defeffort", EFFORTS, current);
export const resolveDefaultModeCallback = (data: string): Mode | null => resolveLevelCallback("defmode", data, isMode);
export const resolveDefaultEffortCallback = (data: string): Effort | null => resolveLevelCallback("defeffort", data, isEffort);
export const isDefaultModeCancelCallback = (data: string): boolean => isLevelCancelCallback("defmode", data);
export const isDefaultEffortCancelCallback = (data: string): boolean => isLevelCancelCallback("defeffort", data);

/** The N-valued `/default` categories: the ones with a drill-down value picker behind them. */
export type DefaultPickerCategory = "mode" | "effort";
/** The boolean `/default` categories (bypass-and-autoanswer-plan.md §0.4) - `/auto`'s two toggles,
 * as a new-session default. Deliberately a *different shape* from the two above rather than being
 * forced through the N-valued picker: a boolean has nothing to drill into. */
export type DefaultToggleCategory = "permission" | "answer";
export type DefaultCategory = DefaultPickerCategory | DefaultToggleCategory;

/** `/default`'s top-level picker (bare `/default`, or a tapped "back" from either value picker in
 * a future pass) - one row per category, each button's own label carrying that category's current
 * value so the whole picker doubles as a status readout, plus the same trailing Cancel row every
 * other picker here has.
 *
 * The two boolean rows are direct toggles: tapping applies immediately, no intermediate screen. That
 * makes them value-dependent in *two* places at once - the label AND the `callback_data`, which
 * carries the inverse of the current value - which is why the two new current-value parameters are
 * not optional. An implementer with no current value to hand would have to hardcode
 * `default:permission:on`, producing a button that turns the default on and can then never turn it
 * off, under a label claiming it will. */
export function buildDefaultCategoryKeyboard(currentMode: Mode, currentEffort: Effort, currentBypass: boolean, currentAutoAnswer: boolean): InlineKeyboardButton[][] {
  const toggleRow = (label: string, category: DefaultToggleCategory, current: boolean) => [
    { text: `${label}: ${current ? "ON" : "OFF"} (tap to turn ${current ? "OFF" : "ON"})`, callback_data: `default:${category}:${current ? "off" : "on"}` },
  ];
  return [
    [{ text: `Mode (${currentMode})`, callback_data: "default:mode" }],
    [{ text: `Effort (${currentEffort})`, callback_data: "default:effort" }],
    toggleRow("Auto-permission", "permission", currentBypass),
    toggleRow("Auto-answer", "answer", currentAutoAnswer),
    [{ text: "✖️ Cancel", callback_data: "default:cancel" }],
  ];
}

/** `default:mode`/`default:effort` - not `resolveLevelCallback`-shaped (there's no enum of valid
 * category *values* to re-validate against, just two fixed literal strings), so this is its own
 * small parser rather than a third `buildLevelKeyboard` instantiation.
 *
 * Stays narrow at `DefaultPickerCategory` deliberately, and must not be widened "for consistency"
 * when `DefaultCategory` grows: it resolves the two-segment category-drill-down taps only. The
 * boolean categories have no drill-down screen at all - their three-segment strings are
 * `resolveDefaultToggleCallback`'s below. Widening this would hand a boolean category straight to
 * the drill-down handler, which has no picker to show for it. */
export function resolveDefaultCategoryCallback(data: string): DefaultPickerCategory | null {
  if (data === "default:mode") return "mode";
  if (data === "default:effort") return "effort";
  return null;
}

/** `default:permission:on|off` / `default:answer:on|off` - the direct-toggle rows above. Its own
 * resolver rather than an extension of `resolveDefaultCategoryCallback` (see that function's note),
 * re-validating both segments against fixed literals with the same defensive discipline as every
 * sibling resolver here, since `callback_data` is attacker-shaped input in principle. */
export function resolveDefaultToggleCallback(data: string): { category: DefaultToggleCategory; value: boolean } | null {
  const match = data.match(/^default:(permission|answer):(on|off)$/);
  if (!match) return null;
  return { category: match[1] as DefaultToggleCategory, value: match[2] === "on" };
}

export function isDefaultCategoryCancelCallback(data: string): boolean {
  return data === "default:cancel";
}
