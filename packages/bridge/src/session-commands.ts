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

/** Standard xterm Shift+Tab (back-tab). One press advances the picker by exactly one entry. */
export const SHIFT_TAB = "\x1b[Z";

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

/** §4.2.2: how many Shift+Tab presses separate `current` from `target` in the cycle, wrapping
 * forward only (the picker has no "previous" direction). Zero if already there. */
export function buildModeKeystrokes(current: Mode, target: Mode): string {
  const from = MODES.indexOf(current);
  const to = MODES.indexOf(target);
  const steps = (to - from + MODES.length) % MODES.length;
  return SHIFT_TAB.repeat(steps);
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** A bare `/model`, `/mode` or `/effort` with no argument (no valid target to act on) surfaces a
 * button per option, same UX as the `/help` command list, instead of falling through as ordinary
 * chat text - confirmed live that a bare `/effort` otherwise lands as a plain message Claude
 * answers conversationally rather than a command the CLI intercepts. */
function buildLevelKeyboard<T extends string>(namespace: string, levels: readonly T[]): InlineKeyboardButton[][] {
  return levels.map((level) => [{ text: level, callback_data: `${namespace}:${level}` }]);
}

/**
 * Parses a `<namespace>:<value>` callback_data string, re-validating against `isValid` rather
 * than trusting the tap - same defensive pattern as resolveCommandAction/resolvePermCallback,
 * since callback_data is attacker-shaped input in principle.
 */
function resolveLevelCallback<T extends string>(namespace: string, data: string, isValid: (value: string) => value is T): T | null {
  const match = data.match(new RegExp(`^${namespace}:(.+)$`));
  if (!match) return null;
  const value = match[1] ?? "";
  return isValid(value) ? value : null;
}

export const buildModelKeyboard = (): InlineKeyboardButton[][] => buildLevelKeyboard("model", MODELS);
export const buildModeKeyboard = (): InlineKeyboardButton[][] => buildLevelKeyboard("mode", MODES);
export const buildEffortKeyboard = (): InlineKeyboardButton[][] => buildLevelKeyboard("effort", EFFORTS);

export const resolveModelCallback = (data: string): Model | null => resolveLevelCallback("model", data, isModel);
export const resolveModeCallback = (data: string): Mode | null => resolveLevelCallback("mode", data, isMode);
export const resolveEffortCallback = (data: string): Effort | null => resolveLevelCallback("effort", data, isEffort);
