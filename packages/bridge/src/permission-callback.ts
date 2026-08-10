import type { InlineKeyboardButton } from "./telegram.ts";

export type PermVerdictAction = "allow" | "deny" | "always";

export interface PermCallback {
  requestId: string;
  action: PermVerdictAction;
}

/**
 * §6.3's encoding: `p:<request_id>:<a|d|A>` in the plan's own worked example, well inside
 * Telegram's 64-byte `callback_data` cap. Named `perm:` here instead of `p:` for readability -
 * still comfortably under the limit for a 5-letter request_id. Re-validates the format rather
 * than trusting the tap, same defensive pattern as `commands.ts`'s `resolveCommandAction`: any
 * client that can see the message can send arbitrary `callback_data` for it.
 */
export function resolvePermCallback(data: string): PermCallback | null {
  // request_id is observed to be 5 letters from [a-km-z] (§6.3), but that charset isn't a
  // guaranteed contract - bound the length generously rather than hard-code an alphabet that a
  // future client version could silently change.
  const match = data.match(/^perm:([A-Za-z0-9]{1,20}):(a|d|A)$/);
  if (!match) return null;
  const requestId = match[1] ?? "";
  const code = match[2];
  const action: PermVerdictAction = code === "a" ? "allow" : code === "d" ? "deny" : "always";
  return { requestId, action };
}

export function buildPermissionKeyboard(requestId: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "✅ Allow", callback_data: `perm:${requestId}:a` },
      { text: "⛔ Deny", callback_data: `perm:${requestId}:d` },
    ],
    [{ text: "♾️ Always allow this pattern", callback_data: `perm:${requestId}:A` }],
  ];
}

export interface PermissionCardFields {
  slug: string;
  toolName: string;
  description: string;
  inputPreview: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * `inputPreview` is Claude Code's own `JSON.stringify` of the tool's raw input (§6.3) - dumping it
 * straight into the card meant a real command showed up as one escaped blob (`\"...\"`, literal
 * `\n`, a `description` field that's usually a word-for-word repeat of `fields.description` above
 * it) - live-observed 2026-08-10 on a `/commit` card with a heredoc-style multiline message, unreadable
 * on a phone. Parses it back into an object and renders something a human can actually scan:
 * a Bash `command` gets its real newlines back inside a monospace `<pre>` block (Telegram HTML,
 * §7 index.ts already uses this parse mode for other cards); anything else becomes one
 * `key: value` line per field, skipping a `description` field that only repeats the line above.
 * Falls back to the raw (HTML-escaped) string if it isn't parseable JSON - never hides the input
 * entirely just because it doesn't match the shape this function expects.
 */
function renderInputPreview(toolName: string, description: string, inputPreview: string): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(inputPreview);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed) return `<pre>${escapeHtml(inputPreview)}</pre>`;

  if (toolName === "Bash" && typeof parsed.command === "string") {
    return `<pre>${escapeHtml(parsed.command)}</pre>`;
  }

  const lines = Object.entries(parsed)
    .filter(([key, value]) => !(key === "description" && value === description))
    .map(([key, value]) => `<b>${escapeHtml(key)}</b>: ${escapeHtml(typeof value === "string" ? value : JSON.stringify(value))}`);
  return lines.length > 0 ? lines.join("\n") : `<pre>${escapeHtml(inputPreview)}</pre>`;
}

/** §6.3's card shape - a permission request rendered from the channel notification alone (§6.5).
 * Rendered as Telegram HTML (§7 index.ts's `sendMessage(..., "HTML")` call) so the bold header and
 * the monospace command block below actually render, rather than showing their raw tags. */
export function renderPermissionCard(fields: PermissionCardFields): string {
  const body = renderInputPreview(fields.toolName, fields.description, fields.inputPreview);
  return `🔐 <b>${escapeHtml(fields.slug)}</b> wants to run <b>${escapeHtml(fields.toolName)}</b>\n\n${escapeHtml(fields.description)}\n\n${body}`;
}
