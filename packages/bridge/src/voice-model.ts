import { readdirSync } from "node:fs";
import type { InlineKeyboardButton } from "./telegram.ts";

/**
 * `/voice` - switching Whisper models from Telegram, live-verified 2026-08-05 against
 * whisper-server's own `/load` endpoint (accepts a `model` form field naming a path on disk;
 * `voice-transcribe.ts`'s `loadWhisperModel` does the actual POST). No process restart needed -
 * switching to a 487MB model took under half a second live; a bigger model will take longer to
 * read off disk but the mechanism is the same.
 *
 * Deliberately whisper-server-global, not per-session, the same reasoning as `/budget`/`/ls`
 * being control-topic-only: there is exactly one supervised whisper-server for the whole Bridge
 * (voice-transcribe.ts's `startWhisperServer`), not one per session, so there is nothing to scope
 * a "current model" to besides the Bridge itself.
 */

const MODEL_FILE_RE = /^ggml-([a-z0-9.-]{1,40})\.bin$/;

/** Scans `voiceDir` for `ggml-<name>.bin` files rather than hardcoding a list - only models that
 * are actually on disk (via setup-windows.ps1 or a manual download) can ever be offered, same
 * "don't assert what you haven't checked" discipline as the rest of this feature. Returns `[]`,
 * not a throw, if the directory doesn't exist yet - the caller renders that as "no models found"
 * rather than an error. */
export function listAvailableVoiceModels(voiceDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(voiceDir);
  } catch {
    return [];
  }
  return entries
    .map((name) => name.match(MODEL_FILE_RE)?.[1])
    .filter((name): name is string => Boolean(name))
    .sort();
}

/** The current model gets a ✅ prefix so `/voice`'s own list doubles as "what's active right now"
 * without a separate status line to keep in sync. */
export function buildVoiceModelKeyboard(models: readonly string[], current: string): InlineKeyboardButton[][] {
  return models.map((name) => [{ text: name === current ? `✅ ${name}` : name, callback_data: `vm:${name}` }]);
}

/** `vm:<name>` - a fresh namespace alongside `vc:`/`d:`/`sc:`/`fc:`. Only ever compared against a
 * freshly re-scanned `listAvailableVoiceModels` result before use, never trusted as a path
 * fragment on its own - the regex here is a shape check for the callback format, not the security
 * boundary (that's the whitelist-by-membership check at the call site). */
export function resolveVoiceModelCallback(data: string): string | null {
  const match = data.match(/^vm:([a-z0-9.-]{1,40})$/);
  return match?.[1] ?? null;
}
