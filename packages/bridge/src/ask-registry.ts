import type { AskQuestionOption } from "@aibridge/protocol";

export interface AskQuestionEntry {
  question: string;
  header?: string;
  options: AskQuestionOption[];
  topicId: number;
  messageId: number;
  answerLabel?: string;
}

export interface PendingAsk {
  id: string;
  slug: string;
  questions: AskQuestionEntry[];
  createdAt: number;
}

/** §6.4: the Bridge's own cancel point, one minute inside the hook's own 3600s configured
 * ceiling so the operator sees "no answer in an hour" before the hook client's local backstop
 * would ever fire. */
const CANCEL_AT_MS = 3540 * 1000;

export interface AskRegistryOptions {
  cancelAtMs?: number;
  /** Clock injection, same pattern as `PermissionRegistry` - never `Date.now()` directly in the class body. */
  now?: () => number;
}

/**
 * The Bridge's own pending-question registry (§6.4), parallel to `PermissionRegistry` but keyed
 * by the tool's own `tool_use_id` (stable across the hook client's reconnects, §2.5) rather than
 * a Bridge-invented id, and tracking possibly-multiple questions per ask rather than one entry
 * per request. No persistence, same as permissions: a Bridge restart mid-question is declared
 * lost, not silently reconstructed.
 */
export class AskRegistry {
  private readonly pending = new Map<string, PendingAsk>();
  private readonly cancelAtMs: number;
  private readonly now: () => number;

  constructor(opts: AskRegistryOptions = {}) {
    this.cancelAtMs = opts.cancelAtMs ?? CANCEL_AT_MS;
    this.now = opts.now ?? Date.now;
  }

  add(entry: Omit<PendingAsk, "createdAt">): void {
    this.pending.set(entry.id, { ...entry, createdAt: this.now() });
  }

  get(id: string): PendingAsk | undefined {
    return this.pending.get(id);
  }

  remove(id: string): void {
    this.pending.delete(id);
  }

  /**
   * Records the tapped option's label for one question in a (possibly multi-question) ask.
   * Returns `null` for an unknown id/question index or a question already answered - a stale or
   * duplicate tap is an expected race (same discipline as `PermissionRegistry.resolve`), not an
   * error. `allAnswered` tells the caller whether every question in this ask now has an answer
   * and it's time to send the full `answers` map back to the blocked hook.
   */
  answer(id: string, questionIndex: number, optionIndex: number): { entry: PendingAsk; label: string; allAnswered: boolean } | null {
    const entry = this.pending.get(id);
    if (!entry) return null;
    const q = entry.questions[questionIndex];
    if (!q || q.answerLabel !== undefined) return null;
    const option = q.options[optionIndex];
    if (!option) return null;
    q.answerLabel = option.label;
    const allAnswered = entry.questions.every((question) => question.answerLabel !== undefined);
    return { entry, label: option.label, allAnswered };
  }

  /** Builds the `{ question text -> chosen label }` map §6.4's `updatedInput.answers` expects,
   * from whatever labels have been recorded so far - only meaningful once `allAnswered`. */
  buildAnswers(entry: PendingAsk): Record<string, string> {
    const answers: Record<string, string> = {};
    for (const q of entry.questions) {
      answers[q.question] = q.answerLabel ?? "";
    }
    return answers;
  }

  /** All entries past the cancel ceiling, for the periodic sweep (§6.4: cancel, strip the
   * keyboard, mark the transcript so it shows what was asked and that nobody answered). */
  expired(): PendingAsk[] {
    const nowMs = this.now();
    return [...this.pending.values()].filter((entry) => nowMs - entry.createdAt > this.cancelAtMs);
  }
}
