import { monotonicNowMs } from "./monotonic-clock.ts";

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
  /** Clock injection for scenario 7's expiry test - never `Date.now()` directly in the class
   * body. Defaults to `monotonicNowMs` (§7.4), not `Date.now` - this class only ever computes a
   * duration (`now() - createdAt`), and a wall clock is the wrong tool for that across a sleep. */
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
    this.now = opts.now ?? monotonicNowMs;
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

  /**
   * §6.5's "answered at the terminal" resolution heuristic. There is no protocol event for "a
   * pending prompt was resolved elsewhere" - a `PostToolUse`/`PostToolUseFailure`/`PermissionDenied`
   * hook whose `tool_name` matches a pending entry for the same session means the operator's own
   * terminal answered it. The plan's own worked example pairs on `(session_id, tool_name,
   * deep-equal tool_input)`, but `PermissionRequest` carries neither `session_id` nor structured
   * `tool_input` (only a text `input_preview`, §6.5's own measured-payload finding) - `slug` already
   * identifies the one session a request came from just as uniquely here (one `claude` process per
   * slug), so this pairs on `(slug, toolName)` **plus an input match**. Ties resolve oldest-first,
   * matching the plan's own note that two byte-identical concurrent calls are indistinguishable to
   * the operator too, so arrival order is correct rather than a compromise.
   *
   * The input match is not optional, and dropping it was a real bug rather than a simplification:
   * pairing on the tool *name* alone meant any second call to the same tool consumed the pending
   * entry. A session with a card up for `Bash(rm -rf build)` that then ran the pre-approved
   * `Bash(git status)` had its card edited to "✅ Allowed ... (answered at terminal)" - an approval
   * the operator never gave - and, worse, the entry was deleted without any verdict being sent, so
   * `sweepExpiredPermissions` (the *only* thing that ever sends the compensating `deny`) could no
   * longer fire for it and the session waited forever.
   *
   * `PermissionRequest` carries no structured `tool_input`, but its `inputPreview` is the complete
   * JSON tool input per §6.5's own measured payload, so the hook's own `tool_input` can be compared
   * against it - see `toolInputMatches` for why that comparison has to parse the preview rather than
   * substring-search it. A payload with no `tool_input` at all gets `undefined` rather than a
   * name-only match.
   */
  resolveByToolMatch(slug: string, toolName: string, toolInput: unknown): PendingPermissionRequest | undefined {
    if (toolInput === undefined || toolInput === null) return undefined;
    let oldest: PendingPermissionRequest | undefined;
    for (const entry of this.pending.values()) {
      if (entry.slug !== slug || entry.toolName !== toolName) continue;
      if (!toolInputMatches(entry.inputPreview, toolInput)) continue;
      if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry;
    }
    if (oldest) this.pending.delete(oldest.requestId);
    return oldest;
  }

  /** Non-consuming snapshot of every pending entry - `/ls`'s detail column (fleet-commands.ts's
   * `buildLsDetail`) needs to find "the pending permission for slug X", not resolve one. */
  all(): PendingPermissionRequest[] {
    return [...this.pending.values()];
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

/**
 * Does a hook's `tool_input` describe the same call as a pending request's `inputPreview`?
 *
 * The preview is a **JSON-encoded** string (§6.5's measured payload; `rule-derivation.ts` `JSON.parse`s
 * it too), so comparing a decoded field value against it as a substring silently fails for any value
 * JSON escapes - which on this host is *most* of them: every Windows path contains backslashes
 * (`C:\data\...` is `C:\\data\\...` inside the preview) and any command with a quote in it is escaped
 * the same way. Parsing the preview first is what makes the comparison actually work; the substring
 * path survives only as a fallback for a preview that isn't JSON at all.
 *
 * Comparison is by *identifying field* rather than deep equality, because the preview and the hook
 * payload legitimately differ in the rest (a `Write`'s `content` may be elided in one and present in
 * the other). Where no identifying field exists - `Task`, `TodoWrite`, an `mcp__*` tool - it falls back
 * to comparing the whole shape, so those tools still get a terminal-answer match instead of none.
 */
export function toolInputMatches(inputPreview: string, toolInput: unknown): boolean {
  if (typeof toolInput !== "object" || toolInput === null) return false;
  const actual = toolInput as Record<string, unknown>;

  let parsed: unknown;
  try {
    parsed = JSON.parse(inputPreview);
  } catch {
    // Not JSON after all - fall back to containment, but against the *escaped* form as well as the
    // raw one. Comparing only the raw value here would reproduce the bug this function exists to fix
    // for exactly the payloads that matter (any Windows path, any quoted command).
    const signature = identifyingValue(actual);
    if (signature === undefined) return false;
    const escaped = JSON.stringify(signature).slice(1, -1);
    return inputPreview.includes(signature) || inputPreview.includes(escaped);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const expected = parsed as Record<string, unknown>;

  // Compare *every* identifying field either side carries, not just the first one found: picking one
  // by priority order lets the two sides choose different keys when their payloads carry different
  // subsets (a `Grep` preview with only `pattern` against a hook payload with `pattern` *and* `path`),
  // which reads as a mismatch for what is plainly the same call.
  const shared = IDENTIFYING_KEYS.filter((key) => typeof expected[key] === "string" || typeof actual[key] === "string");
  if (shared.length > 0) {
    return shared.every((key) => expected[key] === actual[key]);
  }

  // No identifying field at all (`Task`, `TodoWrite`, an `mcp__*` tool): compare the whole shape. Key
  // sets must match too - comparing only the preview's keys would let a hook payload that is a strict
  // superset of it match, which is a wrong card finalized and a wrong verdict sent.
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (expectedKeys.length === 0 || expectedKeys.join(" ") !== actualKeys.join(" ")) return false;
  return expectedKeys.every((key) => JSON.stringify(expected[key]) === JSON.stringify(actual[key]));
}

/** The fields that distinguish one call to a tool from another. */
const IDENTIFYING_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query"] as const;

/** The first identifying field present - only used on the non-JSON fallback path, where there is no
 * structure to compare field by field. */
function identifyingValue(input: Record<string, unknown>): string | undefined {
  for (const key of IDENTIFYING_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * §6.5's periodic expiry sweep. Sends the same `deny` verdict a tapped "Deny" button would
 * (§6.3) before editing the Telegram card - without it, the channel server's blocked permission
 * call (and the Claude process behind it) waits forever even though the card correctly shows
 * "expired" (found live 2026-08-04: four concurrent endurance-run sessions each wedged
 * permanently on an unanswered Write/Bash prompt, none ever unblocked).
 */
export function sweepExpiredPermissions(
  registry: PermissionRegistry,
  sendVerdict: (slug: string, requestId: string, behavior: "deny") => void,
  finalizeMessage: (messageId: number, text: string) => Promise<void>,
  onFinalizeError: (err: Error) => void,
): void {
  for (const entry of registry.expired()) {
    registry.remove(entry.requestId);
    sendVerdict(entry.slug, entry.requestId, "deny");
    finalizeMessage(entry.messageId, `⌛ expired: ${entry.toolName} (no answer in time)`).catch(onFinalizeError);
  }
}
