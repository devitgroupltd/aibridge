import type { FleetCommand } from "./fleet-commands.ts";
import { monotonicNowMs } from "./monotonic-clock.ts";
import type { SessionCommand } from "./session-commands.ts";
import type { InlineKeyboardButton } from "./telegram.ts";

/**
 * Confirm gate for a destructive NL-matched command (`nl-router.ts`'s `isDestructive`) - an NL match
 * is inherently less certain than an operator typing the exact command, so it's never executed
 * immediately unless the operator has explicitly turned confirmation off (`settings-store.ts`'s
 * `nl_confirm_enabled`). Same registry/callback/keyboard shape as `fleet-confirm.ts`/
 * `voice-confirm.ts` - own `Map`, own TTL via injected `monotonicNowMs`, add/resolve-pops-and-
 * checks-TTL, own `callback_data` namespace.
 */
export interface PendingNlConfirm {
  id: string;
  command: FleetCommand | SessionCommand;
  /** `undefined` means the control topic, same convention as every other pending-confirm shape in
   * this codebase. */
  threadId: number | undefined;
  /** The slug the command should run against, if this originated inside a session's own topic -
   * mirrors `dispatchInboundMessage`'s own `currentSlug` so the confirmed execution can call the
   * exact same handler with the exact same context it would have used immediately. */
  currentSlug: string | undefined;
  messageId: number;
  createdAt: number;
}

/** Shorter than `fleet-confirm.ts`'s 5 minutes: an NL match is already a step removed from what the
 * operator actually typed, so a stale card should go cold quickly rather than stay armed to fire a
 * destructive command off a half-remembered tap. */
const DEFAULT_TTL_MS = 3 * 60 * 1000;

export interface NlConfirmRegistryOptions {
  ttlMs?: number;
  now?: () => number;
}

export class NlConfirmRegistry {
  private readonly pending = new Map<string, PendingNlConfirm>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: NlConfirmRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? monotonicNowMs;
  }

  add(entry: Omit<PendingNlConfirm, "createdAt">): void {
    this.pending.set(entry.id, { ...entry, createdAt: this.now() });
  }

  /** An unknown or expired id is a no-op, not a crash - a stale/duplicate tap is expected, same as
   * every other resolve-a-tap path in this codebase. */
  resolve(id: string): PendingNlConfirm | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (this.now() - entry.createdAt > this.ttlMs) return undefined;
    return entry;
  }
}

export type NlConfirmAction = "run" | "run_and_stop_asking" | "cancel";

export interface NlConfirmCallback {
  id: string;
  action: NlConfirmAction;
}

const CODE_ACTION: Record<string, NlConfirmAction> = { y: "run", s: "run_and_stop_asking", n: "cancel" };

/** `nc:<id>:<y|s|n>` - a fresh namespace alongside `perm:`/`ask:`/`fc:`/`vc:`/`d:`/`sc:`. Re-
 * validates the format rather than trusting the tap, same defensive pattern as every other
 * `resolve*Callback` in this codebase: any client that can see the message can send arbitrary
 * `callback_data`. */
export function resolveNlConfirmCallback(data: string): NlConfirmCallback | null {
  const match = data.match(/^nc:([A-Za-z0-9]{1,20}):(y|s|n)$/);
  if (!match) return null;
  const action = CODE_ACTION[match[2] ?? ""];
  if (!action) return null;
  return { id: match[1] ?? "", action };
}

/** "Yes, don't ask again" gets its own row, distinct from plain "Yes" - it both runs this command
 * and flips `nl_confirm_enabled` off, a bigger decision than a single tap should be visually
 * conflated with, same reasoning `voice-confirm.ts`'s own keyboard gives "Send" its own row. */
export function buildNlConfirmKeyboard(id: string): InlineKeyboardButton[][] {
  return [
    [{ text: "✅ Yes, run it", callback_data: `nc:${id}:y` }],
    [{ text: "🔇 Yes, don't ask again", callback_data: `nc:${id}:s` }],
    [{ text: "❌ Cancel", callback_data: `nc:${id}:n` }],
  ];
}
