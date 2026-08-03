export interface PendingPermissionRequest {
  requestId: string;
  slug: string;
  toolName: string;
  description: string;
  inputPreview: string;
  topicId: number;
  messageId: number;
  createdAt: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export interface PermissionRegistryOptions {
  ttlMs?: number;
  /** Clock injection for scenario 7's expiry test - never `Date.now()` directly in the class body. */
  now?: () => number;
}

/**
 * The Bridge's own pending-permission-prompt registry (§6.5). No persistence: §4.5 already
 * establishes a pending prompt does not survive a Bridge restart, so on restart it is declared
 * lost and the operator is told to re-ask, never silently reconstructed.
 */
export class PermissionRegistry {
  private readonly pending = new Map<string, PendingPermissionRequest>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: PermissionRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  add(entry: Omit<PendingPermissionRequest, "createdAt">): void {
    this.pending.set(entry.requestId, { ...entry, createdAt: this.now() });
  }

  /**
   * §9 scenario 6: an unknown `request_id` is a no-op, not a crash. §9 scenario 7: an expired
   * `request_id` is refused even though the letters still match a real, now-removed entry - both
   * cases return `undefined` rather than throwing, since a stale Telegram button tap is an
   * expected race, not a caller error.
   */
  resolve(requestId: string): PendingPermissionRequest | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) return undefined;
    this.pending.delete(requestId);
    if (this.now() - entry.createdAt > this.ttlMs) {
      return undefined;
    }
    return entry;
  }

  /** Non-consuming lookup, for the expiry sweep to inspect without resolving. */
  get(requestId: string): PendingPermissionRequest | undefined {
    return this.pending.get(requestId);
  }

  /** All entries past their TTL, for the periodic expiry sweep (§6.5: strip the keyboard, mark "expired"). */
  expired(): PendingPermissionRequest[] {
    const now = this.now();
    return [...this.pending.values()].filter((entry) => now - entry.createdAt > this.ttlMs);
  }

  remove(requestId: string): void {
    this.pending.delete(requestId);
  }
}
