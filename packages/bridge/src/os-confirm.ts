import { ConfirmRegistry, type ConfirmRegistryOptions } from "./confirm-registry.ts";
import type { InlineKeyboardButton } from "./telegram.ts";

/**
 * `/os shutdown|reboot`'s confirm-card protocol: action type, pending-entry shape, registry,
 * `callback_data` parser and keyboard.
 *
 * Its own module now, matching every other confirm protocol (`fleet-confirm.ts`, `nl-confirm.ts`,
 * `stale-confirm.ts`, `voice-confirm.ts`, `repo-picker.ts`, `restart-confirm.ts`) - it previously
 * lived inside `os-power-commands.ts`, which made `callback-query-router.ts` and `index.ts` import
 * a registry class out of a command module.
 */

export type OsAction = "shutdown" | "reboot";

export interface PendingOsConfirm {
  id: string;
  action: OsAction;
  topicId: number | undefined;
  messageId: number;
  createdAt: number;
}

const DEFAULT_TTL_MS = 2 * 60 * 1000;

/** TTL + clock injection, both from `ConfirmRegistry` - this registry adds nothing of its own.
 * Shorter TTL than `FleetConfirmRegistry`'s 5 minutes (fleet-confirm.ts): a stale button here is
 * scarier to leave armed than one that only kills/removes sessions. */
export type OsConfirmRegistryOptions = ConfirmRegistryOptions;

export class OsConfirmRegistry extends ConfirmRegistry<PendingOsConfirm> {
  constructor(opts: OsConfirmRegistryOptions = {}) {
    super(DEFAULT_TTL_MS, opts);
  }
}

export interface OsConfirmCallback {
  id: string;
  action: OsAction;
  confirmed: boolean;
}

/** `os:<shutdown|reboot>:<id>:<y|n>` - a fresh namespace alongside `fc:`/`nc:`/`sc:`/`vc:`, well
 * inside Telegram's 64-byte `callback_data` cap. Re-validates the format rather than trusting the
 * tap - same defensive pattern as `resolveFleetConfirmCallback`. */
export function resolveOsConfirmCallback(data: string): OsConfirmCallback | null {
  const match = data.match(/^os:(shutdown|reboot):([A-Za-z0-9]{1,20}):(y|n)$/);
  if (!match) return null;
  const action = match[1] as OsAction;
  const id = match[2] ?? "";
  const confirmed = match[3] === "y";
  return { id, action, confirmed };
}

export function buildOsConfirmKeyboard(action: OsAction, id: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "✅ Yes, proceed", callback_data: `os:${action}:${id}:y` },
      { text: "⛔ Cancel", callback_data: `os:${action}:${id}:n` },
    ],
  ];
}
