/**
 * Bounded message-exchange buffer for the control topic only (`plans/control-topic-nl-dialogue-
 * plan.md` §6-7) - gives both the classifier call and the new Q&A call (`nl-router.ts`'s `routeText`
 * and `answerControlTopicQuestion`) a short window of recent conversation so a one-line follow-up
 * ("да, делай", "а если конфликт?") reads naturally, without the model actually retaining state
 * between separate `claude -p` processes - the history is re-sent as plain text on every call, not
 * true session memory.
 *
 * Deliberately NOT a general per-topic history: there is exactly one control topic per Bridge
 * instance, so this is a single buffer, not keyed by topic id. Scope (per the plan): only plain text
 * exchanges - operator message text and the bot's own reply text (Q&A answers, NL-confirm prompts).
 * Never feed-bot tool-activity narration ("Grep/Read/Edit/Bash" step lines) or permission-ask cards -
 * both are session-topic-only concepts this buffer never sees in the first place, since only a
 * PTY/session runs tools or needs permission.
 */

export interface HistoryEntry {
  role: "operator" | "bot";
  text: string;
}

export interface ControlTopicHistory {
  recordOperator(text: string): void;
  recordBot(text: string): void;
  /** The last `maxPairs` operator/bot pairs (up to `maxPairs * 2` entries), oldest first.
   * `maxPairs <= 0` returns an empty array - the caller's "history window disabled" path - read
   * fresh on every call so a config change (`nlRouter.historyTurns`) takes effect immediately, no
   * restart needed. */
  recent(maxPairs: number): HistoryEntry[];
  clear(): void;
}

/** Hard ceiling on rows retained regardless of the configured window, so a very large
 * `historyTurns` (or one left at a stale high value) can't grow this unboundedly - the buffer lives
 * in memory for the life of the Bridge process. */
const RETENTION_CAP = 200;

export function createControlTopicHistory(): ControlTopicHistory {
  const entries: HistoryEntry[] = [];

  function push(entry: HistoryEntry): void {
    entries.push(entry);
    if (entries.length > RETENTION_CAP) entries.splice(0, entries.length - RETENTION_CAP);
  }

  return {
    recordOperator: (text) => push({ role: "operator", text }),
    recordBot: (text) => push({ role: "bot", text }),
    recent: (maxPairs) => (maxPairs > 0 ? entries.slice(-maxPairs * 2) : []),
    clear: () => {
      entries.length = 0;
    },
  };
}

/** Renders `recent()`'s entries as the plain-text block both `claude -p` calls prepend to their
 * prompt - empty string (not a dangling "Recent conversation:" header with nothing under it) when
 * there's nothing to show. */
export function formatHistoryForPrompt(entries: HistoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => `${e.role === "operator" ? "Operator" : "Bot"}: ${e.text}`);
  return `Recent conversation:\n${lines.join("\n")}\n\n`;
}
