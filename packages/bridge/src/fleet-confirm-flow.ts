import { randomUUID } from "node:crypto";
import { buildFleetConfirmKeyboard, FleetConfirmRegistry } from "./fleet-confirm.ts";
import type { PendingFleetConfirm } from "./fleet-confirm.ts";
import type { ConfirmCards } from "./confirm-cards.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import type { SessionLifecycleCommands } from "./session-lifecycle-commands.ts";
import type { RateGovernor } from "./rate-governor.ts";
import type { Routing } from "./routing.ts";
import type { SessionRow, SessionStore } from "./session-store.ts";
import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import type { ThinkingPlaceholder } from "./thinking-placeholder.ts";
import type { TypingIndicator } from "./typing-indicator.ts";
import type { ForumTopicSource, SendMessageSource } from "./telegram.ts";
import { formatUsagePanel } from "./usage-panel.ts";
import { stripAnsi } from "./session-launcher.ts";

/** `/kill --all`/`/rm --all`'s Yes/No confirm-card flow, `/kill --all --force`/`/rm --all --force`'s
 * same teardown without the round-trip, `/usage`, and the `confirmSessionCommand` primitive nearly
 * every other module in this split is built on. Split into two factories rather than one:
 *
 * - `createConfirmSessionCommand` is tiny and has to be constructed very early in `main()` - it's
 *   an injected dependency of nearly every other module (session-supervisor.ts, feed-wiring.ts,
 *   confirm-cards.ts, and every fleet-command module extracted so far), most of which are
 *   themselves constructed long before `sessionLifecycle` (session-lifecycle-commands.ts) exists.
 * - `createFleetConfirmFlow` bundles everything else in this file, which - unlike
 *   `confirmSessionCommand` - genuinely needs `sessionLifecycle`'s `killSessionRow`/
 *   `removeSessionRow`/`resolveTargetSlug` and so is constructed later, once that module exists,
 *   taking the already-built `confirmSessionCommand` as a plain injected value rather than
 *   rebuilding it. Same split `deploy-lifecycle-commands.ts`'s `createProcessRunner`/
 *   `createDeployLifecycleCommands` already established for an analogous early/late dependency
 *   mismatch. */
export interface ConfirmSessionCommandOptions {
  feedGovernor: RateGovernor;
  controlBot: SendMessageSource;
  supergroupChatId: string;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}

export function createConfirmSessionCommand(opts: ConfirmSessionCommandOptions): ConfirmSessionCommand {
  const { feedGovernor, controlBot, supergroupChatId, log } = opts;

  // §5.4's P1 lane: every fleet-command echo and session lifecycle notice this Bridge posts on
  // its own initiative funnels through here, so wiring it through the governor once covers all of
  // them - never delayed behind P2 feed traffic, itself never allowed to delay a P0 permission
  // prompt or question.
  return function confirmSessionCommand(topicId, text, parseMode, keyboard) {
    feedGovernor
      .scheduleAsync("P1", () => controlBot.sendMessage(supergroupChatId, topicId, text, keyboard, parseMode))
      .catch((err: unknown) => log("WARN", `failed to send command confirmation: ${(err as Error).message}`));
  };
}

export interface StopIndicatorsForTopicOptions {
  typingIndicator: TypingIndicator;
  thinkingPlaceholder: ThinkingPlaceholder;
  controlBot: SendMessageSource;
  feedGovernor: RateGovernor;
  supergroupChatId: string;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}

/** §4.2's `/kill`/`/rm`: no `reply` will ever land for this topic again, so the two "Claude is
 * working" signals (§5) need an explicit stop rather than their normal reply-triggered one - left
 * running, the typing indicator nags Telegram for up to its 30-minute backstop and the "🤔
 * Thinking..." placeholder sits there forever, both outliving the session they described.
 *
 * Kept as its own small factory, constructed early alongside `confirmSessionCommand` rather than
 * bundled into `createFleetConfirmFlow` below: it has no dependency on `sessionLifecycle`, but
 * `sessionLifecycle` (session-lifecycle-commands.ts) takes this as an injected callback at its own
 * construction time, and `createFleetConfirmFlow` itself must be constructed *after*
 * `sessionLifecycle` exists (see that function's own doc comment) - keeping this dependency-free
 * function separate avoids needing it either way. */
export function createStopIndicatorsForTopic(opts: StopIndicatorsForTopicOptions): (topicId: number) => void {
  const { typingIndicator, thinkingPlaceholder, controlBot, feedGovernor, supergroupChatId, log } = opts;

  return function stopIndicatorsForTopic(topicId: number): void {
    const topicIdStr = String(topicId);
    typingIndicator.stop(topicIdStr);
    thinkingPlaceholder.consume(topicIdStr).then((messageId) => {
      if (messageId === undefined || !controlBot.editMessageText) return;
      return feedGovernor.scheduleAsync("P1", () => controlBot.editMessageText!(supergroupChatId, messageId, "Session ended."));
    }).catch((err: unknown) => log("WARN", `failed to clear thinking placeholder for topic ${topicId}: ${(err as Error).message}`));
  };
}

export interface FleetConfirmFlowOptions {
  controlBot: SendMessageSource & ForumTopicSource;
  routing: Routing;
  sessionStore: SessionStore;
  confirmCards: ConfirmCards;
  fleetConfirmRegistry: FleetConfirmRegistry;
  sessionLifecycle: Pick<SessionLifecycleCommands, "killSessionRow" | "removeSessionRow" | "resolveTargetSlug">;
  confirmSessionCommand: ConfirmSessionCommand;
  usageWaiters: Map<string, { buffer: string; check: () => void }>;
  orphanTopicNote: string;
  supergroupChatId: string;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}

export interface FleetConfirmFlow {
  postFleetConfirm(kind: "kill" | "rm", topicId: number | undefined, targets: readonly SessionRow[], promptText: string): Promise<void>;
  executeFleetConfirm(pending: PendingFleetConfirm): Promise<void>;
  executeFleetActionDirect(kind: "kill" | "rm", topicId: number | undefined, targets: readonly SessionRow[]): Promise<void>;
  requestUsagePanel(slug: string, timeoutMs?: number): Promise<string>;
  handleUsageCommand(cmd: Extract<FleetCommand, { kind: "usage" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void>;
}

/** `sessionLifecycle` (session-lifecycle-commands.ts, item 7) takes `postFleetConfirm`/
 * `executeFleetActionDirect` as injected callbacks at its own construction time - but
 * `executeFleetActionDirect`/`executeFleetConfirm`/`handleUsageCommand` here genuinely need
 * `sessionLifecycle.killSessionRow`/`removeSessionRow`/`resolveTargetSlug` in return, a real
 * two-way dependency the composition root breaks by constructing `sessionLifecycle` first with
 * `postFleetConfirm`/`executeFleetActionDirect` wrapped in closures over a `let` this module's
 * value is assigned to immediately after - the same "forward reference resolved before it's ever
 * actually called" shape hoisted function declarations gave every pre-split function in `index.ts`
 * for free; explicit here only because a `const` factory result can't itself be hoisted. */
export function createFleetConfirmFlow(opts: FleetConfirmFlowOptions): FleetConfirmFlow {
  const { controlBot, routing, sessionStore, confirmCards, fleetConfirmRegistry, sessionLifecycle, confirmSessionCommand, usageWaiters, orphanTopicNote, supergroupChatId, log } = opts;

  /** Posts the Yes/No confirm card for `/kill --all`/`/rm --all` and registers it in
   * `fleetConfirmRegistry` - shared since the two commands differ only in wording and which
   * teardown function eventually runs. Returns without posting if there's nothing to act on. */
  async function postFleetConfirm(kind: "kill" | "rm", topicId: number | undefined, targets: readonly SessionRow[], promptText: string): Promise<void> {
    if (targets.length === 0) {
      confirmSessionCommand(topicId, kind === "kill" ? "No live sessions to kill." : "No sessions to remove.");
      return;
    }
    const id = randomUUID().slice(0, 8);
    const slugs = targets.map((r) => r.slug);
    try {
      const sent = await controlBot.sendMessage(supergroupChatId, topicId, `${promptText}\n${slugs.join(", ")}`, {
        inline_keyboard: buildFleetConfirmKeyboard(kind, id),
      });
      fleetConfirmRegistry.add({ id, kind, slugs, topicId, messageId: sent.message_id });
    } catch (err) {
      log("WARN", `failed to post /${kind} --all confirmation: ${(err as Error).message}`);
    }
  }

  /** Runs after a `/kill --all`/`/rm --all` confirm tap - re-looks-up rows by slug rather than
   * trusting a snapshot from when the confirm card was posted, since a session can die or get
   * removed independently in the minutes between posting and the tap. */
  async function executeFleetConfirm(pending: PendingFleetConfirm): Promise<void> {
    // §4.5.2's `rm-topic` variant has no session row at all - it acts on `pending.topicId`
    // directly, which is the only reason it was postable in the first place (no DB lookup).
    if (pending.kind === "rm-topic") {
      if (pending.topicId === undefined) {
        await confirmCards.finalizeFleetConfirmMessage(pending, "Nothing left to act on.");
        return;
      }
      try {
        await controlBot.deleteForumTopic(supergroupChatId, pending.topicId);
        await confirmCards.finalizeFleetConfirmMessage(pending, "Topic deleted.");
      } catch (err) {
        log("WARN", `deleteForumTopic failed for orphan topic ${pending.topicId}: ${(err as Error).message}`);
        await confirmCards.finalizeFleetConfirmMessage(pending, "Telegram would not delete this topic - it may need to be removed by hand (topic menu -> Delete Topic).");
      }
      return;
    }

    const rows = pending.slugs.map((s) => sessionStore.get(s)).filter((r): r is SessionRow => r !== undefined);
    let allTopicsDeleted = true;
    for (const row of rows) {
      if (pending.kind === "kill") {
        await sessionLifecycle.killSessionRow(row);
      } else if (!(await sessionLifecycle.removeSessionRow(row))) {
        allTopicsDeleted = false;
      }
    }
    const verb = pending.kind === "kill" ? "Killed" : "Removed";
    const note = pending.kind === "rm" && !allTopicsDeleted ? orphanTopicNote : "";
    await confirmCards.finalizeFleetConfirmMessage(pending, rows.length === 0 ? "Nothing left to act on." : `${verb} ${rows.length} session${rows.length === 1 ? "" : "s"}: ${rows.map((r) => r.slug).join(", ")}${note}`);
  }

  /** `/kill --all --force`/`/rm --all --force` (operator-requested 2026-08-08): the same teardown
   * `executeFleetConfirm` runs after a button tap, just triggered on the same message instead of
   * behind a posted Yes/No card - the operator has already decided and doesn't want to round-trip a
   * tap. Posts the same summary text a tapped card would have finalized to, just as a plain reply
   * since there's no card here to finalize. */
  async function executeFleetActionDirect(kind: "kill" | "rm", topicId: number | undefined, targets: readonly SessionRow[]): Promise<void> {
    if (targets.length === 0) {
      confirmSessionCommand(topicId, kind === "kill" ? "No live sessions to kill." : "No sessions to remove.");
      return;
    }
    let allTopicsDeleted = true;
    for (const row of targets) {
      if (kind === "kill") {
        await sessionLifecycle.killSessionRow(row);
      } else if (!(await sessionLifecycle.removeSessionRow(row))) {
        allTopicsDeleted = false;
      }
    }
    const verb = kind === "kill" ? "Killed" : "Removed";
    const note = kind === "rm" && !allTopicsDeleted ? orphanTopicNote : "";
    confirmSessionCommand(topicId, `${verb} ${targets.length} session${targets.length === 1 ? "" : "s"}: ${targets.map((r) => r.slug).join(", ")}${note}`);
  }

  /** Writes `/usage` into `slug`'s own PTY (a local TUI overlay - never reaches the model, so it
   * can't pollute the conversation) and resolves once Claude Code's async "scanning local sessions"
   * refresh has settled (the "d to day · w to week" hint is the last thing that overlay renders -
   * confirmed live 2026-08-04, see `usage-panel.ts`). Falls back to whatever's been captured so far
   * on timeout rather than discarding it - the first frame alone already has real numbers, same
   * "best-effort" convention `/attach`'s ring buffer already uses. Always closes the overlay with
   * Esc before resolving, so the session isn't left showing it over the normal prompt. */
  function requestUsagePanel(slug: string, timeoutMs = 10_000): Promise<string> {
    return new Promise((resolve) => {
      const write = routing.getPtyWrite(slug);
      if (!write) {
        resolve(`No live PTY for "${slug}" to query.`);
        return;
      }
      if (usageWaiters.has(slug)) {
        resolve(`A /usage capture for "${slug}" is already in flight - the reply to that one is on its way.`);
        return;
      }
      const finish = (state: { buffer: string }) => {
        clearTimeout(timeout);
        usageWaiters.delete(slug);
        write("\x1b");
        resolve(formatUsagePanel(stripAnsi(state.buffer)));
      };
      const timeout = setTimeout(() => {
        const state = usageWaiters.get(slug);
        if (state) finish(state);
      }, timeoutMs);
      usageWaiters.set(slug, {
        buffer: "",
        check() {
          if (/d to day/i.test(stripAnsi(this.buffer))) finish(this);
        },
      });
      write("/usage\r");
    });
  }

  /** `/usage` (§4.2, added 2026-08-04): asks `slug`'s own session to open Claude Code's own `/usage`
   * overlay (account-level Anthropic usage, distinct from anything Bridge tracks itself) and relays
   * the parsed Session/Weekly/Weekly-Fable percentages back into Telegram. */
  async function handleUsageCommand(cmd: Extract<FleetCommand, { kind: "usage" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    const resolved = sessionLifecycle.resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const summary = await requestUsagePanel(resolved.slug);
    confirmSessionCommand(topicId, summary);
  }

  return { postFleetConfirm, executeFleetConfirm, executeFleetActionDirect, requestUsagePanel, handleUsageCommand };
}
