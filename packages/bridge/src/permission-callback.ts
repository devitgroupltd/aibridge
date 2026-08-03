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

/** §6.3's card shape - a permission request rendered from the channel notification alone (§6.5). */
export function renderPermissionCard(fields: PermissionCardFields): string {
  return `🔐 ${fields.slug} wants to run ${fields.toolName}\n\n${fields.description}\n\n${fields.inputPreview}`;
}
