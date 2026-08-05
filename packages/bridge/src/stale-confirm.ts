import { monotonicNowMs } from "./monotonic-clock.ts";
import type { InlineKeyboardButton } from "./telegram.ts";

/**
 * The confirm-button half of §7.4's stale-inbound handling: a message flagged by
 * `stale-inbound.ts` is never dispatched directly, only replayed if the operator taps "Yes" on a
 * card posted in its place. Same registry/callback/keyboard shape as `fleet-confirm.ts`'s
 * kill/rm confirms (own namespace, own short TTL, resolve-pops-and-checks-TTL) rather than
 * reusing that registry directly - the payload here (a whole inbound message to replay) doesn't
 * fit `FleetConfirmKind`'s slugs-array shape, and forcing it in would make that module's type
 * lie about what it holds.
 */
export interface PendingStaleConfirm {
  id: string;
  /** `undefined` means the control topic, same convention as everywhere else in this codebase. */
  threadId: number | undefined;
  /** The original Telegram message id, forwarded on replay so a downstream `<channel>` tag still
   * carries the real id rather than a synthetic one. */
  messageId: number;
  /** Raw, unstripped `message.text` - bot-mention stripping happens at dispatch time, not here,
   * so a replay goes through the exact same normalization a live message would. */
  rawText: string;
  from: string;
  confirmCardMessageId: number;
  createdAt: number;
}

/** This project's own choice, not a plan-specified number: long enough that an operator who just
 * woke their phone up and is reading a backlog has time to notice and tap, short enough that a
 * forgotten card doesn't stay armed to replay a command hours later - the exact failure mode this
 * whole feature exists to prevent, just moved one step later if the TTL were too generous. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface StaleConfirmRegistryOptions {
  ttlMs?: number;
  /** Clock injection for expiry tests - never `Date.now()` directly in the class body, and
   * defaults to `monotonicNowMs` (§7.4): this only ever computes a duration, and a wall clock is
   * the wrong tool for that across a sleep. */
  now?: () => number;
}

export class StaleConfirmRegistry {
  private readonly pending = new Map<string, PendingStaleConfirm>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: StaleConfirmRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? monotonicNowMs;
  }

  add(entry: Omit<PendingStaleConfirm, "createdAt">): void {
    this.pending.set(entry.id, { ...entry, createdAt: this.now() });
  }

  /** An unknown or expired id is a no-op, not a crash - same discipline as every other
   * resolve-a-tap path in this codebase (a stale/duplicate tap on this very card is expected). */
  resolve(id: string): PendingStaleConfirm | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (this.now() - entry.createdAt > this.ttlMs) return undefined;
    return entry;
  }
}

export interface StaleConfirmCallback {
  id: string;
  confirmed: boolean;
}

/** `sc:<id>:<y|n>` - a fresh namespace alongside `perm:`/`ask:`/`run:`/`fc:`. Re-validates the
 * format rather than trusting the tap, same defensive pattern as every other `resolve*Callback`
 * here: any client that can see the message can send arbitrary `callback_data`. */
export function resolveStaleConfirmCallback(data: string): StaleConfirmCallback | null {
  const match = data.match(/^sc:([A-Za-z0-9]{1,20}):(y|n)$/);
  if (!match) return null;
  const id = match[1] ?? "";
  const confirmed = match[2] === "y";
  return { id, confirmed };
}

export function buildStaleConfirmKeyboard(id: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "✅ Yes, still want this", callback_data: `sc:${id}:y` },
      { text: "⛔ No, skip it", callback_data: `sc:${id}:n` },
    ],
  ];
}
