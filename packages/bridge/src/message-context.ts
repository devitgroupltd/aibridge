import type { TelegramForwardOrigin, TelegramReplyTarget } from "./telegram.ts";

/**
 * Live-observed gap (2026-08-07): a forwarded message or a Telegram-native "swipe to reply" quoting
 * an earlier message read to Claude exactly like fresh text typed by the operator - no indication
 * it quoted someone else's words, or which earlier message it was responding to. Both are folded
 * into one prefix here, prepended only at the genuine "this reaches the session as a message"
 * boundary (`index.ts`'s `sendChannelText` call inside `dispatchInboundMessage`'s forward-to-session
 * fallback) - never into the text `parseFleetCommand`/`resolveTargetSlug`/etc. parse against, since
 * a reply-quoting a real `/command` would otherwise stop parsing as one.
 */

/** Just enough of a message to build the prefix from - both a live `TelegramMessage` and a stored
 * `PendingVoiceConfirm`/`PendingStaleConfirm` entry (which persist only these two fields, not a
 * whole message) satisfy this. */
export interface MessageOrigin {
  forward_origin?: TelegramForwardOrigin;
  reply_to_message?: TelegramReplyTarget;
}

function describeForwardOrigin(origin: TelegramForwardOrigin | undefined): string | undefined {
  if (!origin) return undefined;
  if (origin.type === "user") return origin.sender_user.username ? `@${origin.sender_user.username}` : (origin.sender_user.first_name ?? "someone");
  if (origin.type === "hidden_user") return origin.sender_user_name;
  if (origin.type === "chat") return origin.sender_chat.title ?? origin.sender_chat.username ?? "a chat";
  if (origin.type === "channel") return origin.chat.title ?? origin.chat.username ?? "a channel";
  return undefined;
}

/** Same 200-char preview length `postStaleConfirm` (index.ts) already uses for a message preview -
 * consistent rather than inventing a second constant for the same purpose. */
const QUOTE_PREVIEW_MAX = 200;

function previewOf(target: TelegramReplyTarget): string | undefined {
  const text = target.text ?? target.caption;
  if (!text) return undefined;
  return text.length > QUOTE_PREVIEW_MAX ? `${text.slice(0, QUOTE_PREVIEW_MAX)}…` : text;
}

/** Built once per inbound message and prepended only where its content actually reaches the
 * session - see this file's own doc comment. Returns `""` when neither forward nor reply applies,
 * so every call site can just do `buildContextPrefix(origin) + content` unconditionally. */
export function buildContextPrefix(origin: MessageOrigin): string {
  const lines: string[] = [];
  const forwardedFrom = describeForwardOrigin(origin.forward_origin);
  if (forwardedFrom) lines.push(`[Forwarded from ${forwardedFrom}]`);
  if (origin.reply_to_message) {
    const preview = previewOf(origin.reply_to_message);
    lines.push(preview ? `[Replying to an earlier message: "${preview}"]` : "[Replying to an earlier message with no text/caption]");
  }
  return lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
}
