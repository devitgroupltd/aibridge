import { ConfirmRegistry, type ConfirmRegistryOptions } from "./confirm-registry.ts";
import type { Model } from "./session-commands.ts";
import type { InlineKeyboardButton } from "./telegram.ts";

/**
 * Ask-which-repo gate for an NL-matched `kind='new'` whose message never named a registered repo
 * (`nl-router.ts`'s `mapRouterOutput` "new" case, `RouterAction`'s `new_pick_repo`) - only ever
 * posted when the ambiguity is real (2+ repos registered); a single registered repo is filled in
 * automatically instead, with no card at all. Same registry/callback/keyboard shape as
 * `nl-confirm.ts` - own `Map`, own TTL via injected `monotonicNowMs`, add/resolve-pops-and-checks-TTL,
 * own `callback_data` namespace.
 */
export interface PendingRepoPick {
  id: string;
  /** The classifier's own paraphrase, handed to `handleNewCommand` if nothing better is available -
   * mirrors `nl-dispatch.ts`'s existing `FleetCommand["new"]["prompt"]`. */
  prompt: string;
  /** The operator's own raw message text, attached as the eventual `FleetCommand["new"]["sourceText"]`
   * once a repo is picked - the same "operator's own words, not the classifier's English paraphrase"
   * treatment `routeOrFallback` already gives a directly-matched `kind='new'`. */
  sourceText: string;
  model: Model | undefined;
  /** Always the control topic in practice - `new`/`new_pick_repo` are control-topic-only
   * (`nl-router.ts`'s `allowedKinds`) - kept as `threadId` for the same convention every other
   * pending-* shape in this codebase uses. */
  threadId: number | undefined;
  messageId: number;
  createdAt: number;
}

/** Same as `nl-confirm.ts`'s `DEFAULT_TTL_MS` - this card is a step removed from what the operator
 * actually typed, same as an NL-matched destructive command, so it should go cold quickly too. */
const DEFAULT_TTL_MS = 3 * 60 * 1000;

export type RepoPickRegistryOptions = ConfirmRegistryOptions;

/** `add`/`take`/`resolve`/`takeExpired` all come from `ConfirmRegistry` - see that module for why
 * the confirm/pick registries share one implementation rather than separate copies. */
export class RepoPickRegistry extends ConfirmRegistry<PendingRepoPick> {
  constructor(opts: RepoPickRegistryOptions = {}) {
    super(DEFAULT_TTL_MS, opts);
  }
}

export type RepoPickCallback = { id: string; repo: string } | { id: string; cancel: true };

const CANCEL_TOKEN = "_cancel";

/** `rp:<id>:<repoName|_cancel>` - a fresh namespace alongside `nc:`/`fc:`/`vc:`/`d:`/`sc:`. Repo
 * names are already restricted to `[A-Za-z0-9_-]+` at registration time
 * (`repos-registry.ts`'s `isValidRepoName`), so the raw name round-trips through `callback_data`
 * with no extra encoding. Re-validates the format rather than trusting the tap, same defensive
 * pattern as every other `resolve*Callback` in this codebase: any client that can see the message
 * can send arbitrary `callback_data`. */
export function resolveRepoPickCallback(data: string): RepoPickCallback | null {
  const match = data.match(/^rp:([A-Za-z0-9]{1,20}):([A-Za-z0-9_-]{1,64})$/);
  if (!match) return null;
  const id = match[1] ?? "";
  const value = match[2] ?? "";
  if (value === CANCEL_TOKEN) return { id, cancel: true };
  return { id, repo: value };
}

/** One row per registered repo, plus a trailing Cancel row - same "run/don't-ask/cancel" shape as
 * `nl-confirm.ts`'s keyboard, minus the "don't ask again" option (there's no recurring toggle to
 * flip off here, just a one-off choice). */
export function buildRepoPickKeyboard(id: string, repoNames: readonly string[]): InlineKeyboardButton[][] {
  return [...repoNames.map((name): InlineKeyboardButton[] => [{ text: name, callback_data: `rp:${id}:${name}` }]), [{ text: "❌ Cancel", callback_data: `rp:${id}:${CANCEL_TOKEN}` }]];
}
