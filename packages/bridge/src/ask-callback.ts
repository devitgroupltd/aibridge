import type { AskQuestionOption } from "@aibridge/protocol";
import type { InlineKeyboardButton } from "./telegram.ts";

export interface AskCallback {
  id: string;
  questionIndex: number;
  optionIndex: number;
}

/**
 * §6.4's encoding: `ask:<tool_use_id>:<question index>:<option index>`. `tool_use_id` runs to
 * ~30 characters in practice (`toolu_` plus 24 alphanumerics, per the live capture) - bounded
 * generously here rather than hard-coded to that exact length, same defensive stance as
 * `permission-callback.ts`'s `resolvePermCallback`. Comfortably under Telegram's 64-byte
 * `callback_data` cap even at the bound.
 */
export function resolveAskCallback(data: string): AskCallback | null {
  const match = data.match(/^ask:([A-Za-z0-9_-]{1,40}):(\d{1,2}):(\d{1,2})$/);
  if (!match) return null;
  return { id: match[1] ?? "", questionIndex: Number(match[2]), optionIndex: Number(match[3]) };
}

export function buildAskKeyboard(id: string, questionIndex: number, options: AskQuestionOption[]): InlineKeyboardButton[][] {
  return options.map((option, optionIndex) => [{ text: option.label, callback_data: `ask:${id}:${questionIndex}:${optionIndex}` }]);
}

/** §6.4: "posts each question as its own message" - one card per question, not one card for the
 * whole ask, so a multi-question `AskUserQuestion` call renders as one message per question. */
export function renderAskCard(slug: string, question: string, header?: string): string {
  return `❓ ${slug} asks${header ? ` (${header})` : ""}:\n\n${question}`;
}

export function renderAskAnsweredCard(slug: string, question: string, header: string | undefined, label: string): string {
  return `${renderAskCard(slug, question, header)}\n\n✅ ${label}`;
}

export function renderAskCancelledCard(slug: string, question: string, header: string | undefined): string {
  return `${renderAskCard(slug, question, header)}\n\n⌛ no answer in an hour - cancelled`;
}

/** `/stop`'s card-edit counterpart to `renderAskCancelledCard` above - same "don't leave a
 * tappable-looking button that silently does nothing" principle (§6.5), triggered by an operator
 * interrupt instead of the 3540s ceiling, so the wording says what actually happened rather than
 * reusing the TTL card's "no answer in an hour" text verbatim. */
export function renderAskInterruptedCard(slug: string, question: string, header: string | undefined): string {
  return `${renderAskCard(slug, question, header)}\n\n🛑 interrupted - session was stopped before this was answered`;
}

/** The subset of `AskRegistry` this sweep needs - narrowed so a test can drive it with an array
 * instead of a real registry, same reason `sweepExpiredPermissions` takes its registry by interface. */
export interface ExpiringAskRegistry {
  expired(): readonly { id: string; slug: string; questions: readonly { question: string; header?: string; messageId: number; answerLabel?: string }[] }[];
}

/**
 * §6.4's 3540s ceiling sweep, lifted out of `index.ts`'s 60s interval so its `onResolved` contract
 * is testable at all. Cancels rather than letting the hook client's own 3600s backstop expire
 * silently: the operator sees an explicit "cancelled" card, and Claude sees a `deny` it can recover
 * from instead of a wrong answer auto-picked on its behalf.
 *
 * `onResolved` is the half this originally missed. `cancelAsk` unblocks the hook, so the session is
 * *working* again the instant this runs - but the row still says `awaiting_input`, because the only
 * place that moved it back was the button-tap path in `callback-query-router.ts`. Found live
 * 2026-08-13 (a row frozen at `awaiting_input` with an hour-stale `last_event_utc` while the session
 * ran normally): `/ls` misreported it, `sendFollowUpNudgeIfStillIdle` skipped its nudge believing a
 * fresh permission card was up, and `resumeSession`'s `hadLostPrompt` would have posted a spurious
 * "the pending question was lost" notice.
 */
export function sweepExpiredAsks(
  registry: ExpiringAskRegistry,
  cancelAsk: (id: string) => void,
  finalizeMessage: (messageId: number, text: string) => Promise<void>,
  onResolved: (slug: string) => void,
  onFinalizeError: (err: Error) => void,
): void {
  for (const entry of registry.expired()) {
    cancelAsk(entry.id);
    onResolved(entry.slug);
    for (const q of entry.questions) {
      if (q.answerLabel !== undefined) continue;
      finalizeMessage(q.messageId, renderAskCancelledCard(entry.slug, q.question, q.header)).catch(onFinalizeError);
    }
  }
}
