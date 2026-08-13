import { ConfirmRegistry, type ConfirmRegistryOptions } from "./confirm-registry.ts";
import type { InlineKeyboardButton } from "./telegram.ts";

/**
 * `/restart`'s confirm-card protocol: pending-entry shape, registry, `callback_data` parser and
 * keyboard.
 *
 * Its own module now, matching every other confirm protocol (`fleet-confirm.ts`, `nl-confirm.ts`,
 * `stale-confirm.ts`, `voice-confirm.ts`, `repo-picker.ts`, `os-confirm.ts`). It previously lived
 * inside `deploy-lifecycle-commands.ts`, which meant `callback-query-router.ts` and `index.ts` both
 * imported a registry class out of a command module - the one arrangement none of the other six use.
 */

/** Confirm gate for `/restart` (2026-08-12 operator request): with at least one non-`dead` session
 * in the fleet, a typed `/restart` is destructive enough - it kills every live session with the
 * process, per §4.5's own measurement - to get the same Yes/Cancel confirm card `/os shutdown|reboot`
 * already does, rather than executing on the same message the way it did before this. With zero
 * live sessions there is nothing to lose, so `handleRestartCommand` skips this registry entirely and
 * restarts immediately, same as always. Deliberately its own registry rather than piggybacking on
 * `fleet-confirm.ts`'s `FleetConfirmRegistry`: that one's `kind` discriminator exists because several
 * *different* destructive actions share one registry/namespace, which `/restart` has no need for -
 * one pending card, one action, same "own `Map`, own TTL, own `callback_data` namespace" shape as
 * `OsConfirmRegistry`. */
export interface PendingRestartConfirm {
  id: string;
  topicId: number | undefined;
  messageId: number;
  createdAt: number;
  /** Only set when this confirm originated from `/merge`'s or `/ship`'s self-repo restart tail
   * (`restartIfSelfRepo`) rather than a direct `/restart` - `executeRestartConfirm` uses it to write
   * the deploy marker at confirm time (not at merge time, since a Cancel tap must leave nothing
   * written) and to log/notify with the right command label and outcome shas. */
  selfRepoRestart?: {
    commandLabel: string;
    repoPath: string;
    branch: string;
    previousHeadSha: string;
    newHeadSha: string;
  };
}

const RESTART_CONFIRM_TTL_MS = 2 * 60 * 1000;

/** TTL + clock injection, both from `ConfirmRegistry` - this registry adds nothing of its own. */
export type RestartConfirmRegistryOptions = ConfirmRegistryOptions;

export class RestartConfirmRegistry extends ConfirmRegistry<PendingRestartConfirm> {
  constructor(opts: RestartConfirmRegistryOptions = {}) {
    super(RESTART_CONFIRM_TTL_MS, opts);
  }
}

export interface RestartConfirmCallback {
  id: string;
  confirmed: boolean;
}

/** `rs:<id>:<y|n>` - a fresh namespace alongside `fc:`/`os:`/`nc:`/`sc:`/`vc:`/`rp:`, well inside
 * Telegram's 64-byte `callback_data` cap. Re-validates the format rather than trusting the tap, same
 * defensive pattern as every other `resolve*Callback` in this codebase. */
export function resolveRestartConfirmCallback(data: string): RestartConfirmCallback | null {
  const match = data.match(/^rs:([A-Za-z0-9]{1,20}):(y|n)$/);
  if (!match) return null;
  return { id: match[1] ?? "", confirmed: match[2] === "y" };
}

export function buildRestartConfirmKeyboard(id: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "✅ Yes, restart", callback_data: `rs:${id}:y` },
      { text: "⛔ Cancel", callback_data: `rs:${id}:n` },
    ],
  ];
}
