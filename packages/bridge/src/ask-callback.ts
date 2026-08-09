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
