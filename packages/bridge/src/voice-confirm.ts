import { ConfirmRegistry, type ConfirmRegistryOptions } from "./confirm-registry.ts";
import type { InlineKeyboardButton } from "./telegram.ts";

/**
 * The confirm-button half of voice-note input: a transcribed voice message is never dispatched
 * directly, only replayed if the operator taps "Send" on the card posted in its place. Whisper's
 * accuracy varies a lot across languages - Azerbaijani in particular is meaningfully weaker than
 * English/Russian/Ukrainian - so showing the transcript before it reaches the session is
 * load-bearing, not cosmetic. Same registry/callback/keyboard shape as `stale-confirm.ts` - own
 * namespace, own TTL, resolve-pops-and-checks-TTL.
 */
export interface PendingVoiceConfirm {
  id: string;
  /** `undefined` means the control topic, same convention as everywhere else in this codebase. */
  threadId: number | undefined;
  /** The original voice message's id, forwarded on send so a downstream `<channel>` tag still
   * carries the real id rather than a synthetic one - same reasoning as `stale-confirm.ts`. */
  messageId: number;
  transcript: string;
  from: string;
  confirmCardMessageId: number;
  createdAt: number;
}

/** Long enough to record, read the transcript back, and decide; short enough that an abandoned
 * card can't resurrect a days-old transcript into a live session. Same order of magnitude as
 * `stale-confirm.ts`'s own TTL. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** TTL + clock injection, both from `ConfirmRegistry` - this registry adds nothing of its own. */
export type VoiceConfirmRegistryOptions = ConfirmRegistryOptions;

export class VoiceConfirmRegistry extends ConfirmRegistry<PendingVoiceConfirm> {
  constructor(opts: VoiceConfirmRegistryOptions = {}) {
    super(DEFAULT_TTL_MS, opts);
  }
}

export type VoiceConfirmAction = "send" | "send_and_stop_asking" | "rerecord" | "type" | "cancel";

export interface VoiceConfirmCallback {
  id: string;
  action: VoiceConfirmAction;
}

const CODE_ACTION: Record<string, VoiceConfirmAction> = { s: "send", a: "send_and_stop_asking", r: "rerecord", t: "type", c: "cancel" };

/** `vc:<id>:<s|a|r|t|c>` - a fresh namespace alongside `perm:`/`ask:`/`sc:`/`fc:`/`d:`. Re-validates
 * the format rather than trusting the tap, same defensive pattern as every other
 * `resolve*Callback` here: any client that can see the message can send arbitrary `callback_data`. */
export function resolveVoiceConfirmCallback(data: string): VoiceConfirmCallback | null {
  const match = data.match(/^vc:([A-Za-z0-9]{1,20}):(s|a|r|t|c)$/);
  if (!match) return null;
  const action = CODE_ACTION[match[2] ?? ""];
  if (!action) return null;
  return { id: match[1] ?? "", action };
}

/** Send gets its own row - the primary action, not one of five equally-weighted buttons. "Send,
 * don't ask again" sits right below it, same "adjacent to but visually distinct from the button it
 * modifies" placement as `nl-confirm.ts`'s own "don't ask again" row - it both sends *this*
 * transcript and flips `voice_confirm_enabled` off, a bigger decision than a single tap should be
 * conflated with plain "Send". The remaining three all just discard the transcript (§ index.ts's
 * shared "not sending" finalize text) - kept as three distinct buttons rather than collapsed into
 * one because they carry different implied next steps for the operator (re-record vs type vs
 * "never mind, drop it"), even though the registry/callback code treats them identically past the
 * send/no-send branch. */
export function buildVoiceConfirmKeyboard(id: string): InlineKeyboardButton[][] {
  return [
    [{ text: "✅ Send", callback_data: `vc:${id}:s` }],
    [{ text: "🔇 Send, don't ask again", callback_data: `vc:${id}:a` }],
    [
      { text: "🔁 Re-record", callback_data: `vc:${id}:r` },
      { text: "✏️ I'll type instead", callback_data: `vc:${id}:t` },
      { text: "❌ Cancel", callback_data: `vc:${id}:c` },
    ],
  ];
}
