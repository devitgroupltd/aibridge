import { ConfirmRegistry, type ConfirmRegistryOptions } from "./confirm-registry.ts";
import type { AutoCategory } from "./fleet-commands.ts";
import type { InlineKeyboardButton } from "./telegram.ts";

/** `/auto <category> --all on|off`'s confirm kinds - the *value* is carried in the kind itself
 * (bypass-and-autoanswer-plan.md §0.3), which is why a bare `/auto <category> --all` with no value
 * reports fleet status instead of posting a card: there would be no valid kind to construct. */
export type AutoConfirmKind = `${AutoCategory}-${"on" | "off"}`;

export type FleetConfirmKind = "kill" | "rm" | "rm-topic" | "rm-worktree" | "rm-branch" | AutoConfirmKind;

/** Everything `postFleetConfirm` can post a card for - i.e. `FleetConfirmKind` minus the three kinds
 * that have no session rows and their own posters (`rm-topic`/`postOrphanTopicRmConfirm`,
 * `rm-worktree`/`postOrphanWorktreeConfirm`, `rm-branch`/`handleBranchesCommand`). All three carry
 * their targets in the pending entry itself rather than as slugs to look up, which is what makes
 * them postable with nothing in the DB. */
export type FleetBulkKind = Exclude<FleetConfirmKind, "rm-topic" | "rm-worktree" | "rm-branch">;

export const autoConfirmKind = (category: AutoCategory, on: boolean): AutoConfirmKind => `${category}-${on ? "on" : "off"}`;

/**
 * The inverse of `autoConfirmKind`, returning null for every non-auto kind (`kill`/`rm`/`rm-topic`)
 * - which is what makes it safe to use as `executeFleetConfirm`'s branch predicate itself rather
 * than after a separate membership test.
 *
 * Deliberately *not* a generic `kind.split("-")`: `FleetConfirmKind` already contains `"rm-topic"`,
 * which a hyphen-split happily reads as category `"rm"`, value `"topic"` - turning an `/rm --all`
 * tap into an auto-toggle call on a category that doesn't exist. Colocated with `autoConfirmKind`
 * above so the encoding can only ever be changed in one place. The `default: return null` arm is
 * deliberate where `autoCategorySpec` (session-lifecycle-commands.ts) uses a `never`: this function
 * is *asked about* kinds it doesn't own, so an unrecognised kind is the normal case, not a bug.
 */
export function parseAutoConfirmKind(kind: FleetConfirmKind): { category: AutoCategory; on: boolean } | null {
  switch (kind) {
    case "permission-on":
      return { category: "permission", on: true };
    case "permission-off":
      return { category: "permission", on: false };
    case "answer-on":
      return { category: "answer", on: true };
    case "answer-off":
      return { category: "answer", on: false };
    default:
      return null;
  }
}

export interface PendingFleetConfirm {
  id: string;
  kind: FleetConfirmKind;
  /** Empty for `rm-topic` - that variant acts on `topicId` directly, there is no session row (by
   * definition: it's an orphaned topic with nothing in the DB to look up).
   *
   * For `rm-worktree` these are directory names under the worktrees root rather than slugs anything
   * can be looked up by - same reason, opposite side of the matrix: the whole point is that no row
   * exists. `orphan-worktrees.ts` re-validates every one of them at deletion time rather than
   * trusting a value that has made a round trip through Telegram.
   *
   * For `rm-branch` they are full branch names (`claude/<slug>-<id>`) in `repoPath`, re-validated
   * the same way by `orphan-branches.ts`. */
  slugs: string[];
  topicId: number | undefined;
  /** `rm-branch` only: the repo whose `claude/<slug>-<id>` branches `slugs` names. Carried on the
   * pending entry rather than re-derived at tap time so the repo a card was posted about and the
   * repo a tap deletes in cannot drift apart - the same reasoning `worktreesRoot` gets in
   * `fleet-confirm-flow.ts`, and it matters more here because there can be several registered repos
   * and a branch name says nothing about which one it came from. */
  repoPath?: string;
  messageId: number;
  createdAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** TTL + clock injection, both from `ConfirmRegistry` - this registry adds nothing of its own. */
export type FleetConfirmRegistryOptions = ConfirmRegistryOptions;

/**
 * Confirmation registry for `/kill --all`, `/rm --all` (§4.2), and `rm-topic` (§4.5.2 - a bare
 * `/rm` sent inside a Telegram topic that has no matching session row, i.e. an orphaned topic left
 * behind by an earlier `deleteForumTopic` failure) - all three act on something irreversible in one
 * shot, so unlike every other fleet command they go through the same approve/deny-button pattern as
 * a permission prompt (§6.3, permission-registry.ts) instead of executing immediately. A much
 * shorter TTL than the 30-minute permission-prompt one: this is an operator confirming their own
 * just-typed command, not waiting on Claude, so a stale button they forgot about should go cold
 * fast rather than stay armed to fire a fleet-wide kill/remove (or a topic delete) on a late,
 * half-remembered tap.
 */
export class FleetConfirmRegistry extends ConfirmRegistry<PendingFleetConfirm> {
  constructor(opts: FleetConfirmRegistryOptions = {}) {
    super(DEFAULT_TTL_MS, opts);
  }
}

export interface FleetConfirmCallback {
  id: string;
  kind: FleetConfirmKind;
  confirmed: boolean;
}

/** Every `FleetConfirmKind`, as data - the callback regex's alternation is built from this rather
 * than repeating the literals. The `satisfies Record<FleetConfirmKind, true>` is what makes that
 * worth doing: a newly-added kind becomes a compile error here instead of a kind whose buttons post
 * fine and then never resolve, i.e. a live-looking card that silently does nothing when tapped.
 * Order matters for the alternation only in that `rm` precedes `rm-topic` - regex backtracking
 * already handles that (the trailing `:` fails after a bare `rm`), same as before this was derived. */
const FLEET_CONFIRM_KINDS = Object.keys({
  kill: true,
  rm: true,
  "rm-topic": true,
  "rm-worktree": true,
  "rm-branch": true,
  "permission-on": true,
  "permission-off": true,
  "answer-on": true,
  "answer-off": true,
} satisfies Record<FleetConfirmKind, true>);

const FLEET_CONFIRM_CALLBACK_RE = new RegExp(`^fc:(${FLEET_CONFIRM_KINDS.join("|")}):([A-Za-z0-9]{1,20}):(y|n)$`);

/**
 * `fc:<kind>:<id>:<y|n>` - a fresh namespace alongside `perm:`/`ask:`/`run:`, well inside Telegram's
 * 64-byte `callback_data` cap. The id is generated by the Bridge itself (no channel round-trip
 * involved here, unlike a permission request's `request_id`). Re-validates the format rather than
 * trusting the tap - same defensive pattern as resolvePermCallback/resolveAskCallback/
 * resolveCommandAction: any client that can see the message can send arbitrary `callback_data`.
 */
export function resolveFleetConfirmCallback(data: string): FleetConfirmCallback | null {
  const match = data.match(FLEET_CONFIRM_CALLBACK_RE);
  if (!match) return null;
  const kind = match[1] as FleetConfirmKind;
  const id = match[2] ?? "";
  const confirmed = match[3] === "y";
  return { id, kind, confirmed };
}

export function buildFleetConfirmKeyboard(kind: FleetConfirmKind, id: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "✅ Yes, proceed", callback_data: `fc:${kind}:${id}:y` },
      { text: "⛔ Cancel", callback_data: `fc:${kind}:${id}:n` },
    ],
  ];
}
