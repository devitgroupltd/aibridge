/**
 * `sendChatAction`'s "typing..." status doesn't work as a cross-device solution: Telegram Desktop
 * has a known bug (tdesktop#30452) where the indicator renders in the topics overview list, not
 * inside the open topic itself, so an operator watching the topic they just messaged never sees it.
 * A real message sidesteps this entirely - every client renders messages the same way. So instead
 * of a chat action, this sends a "🤔 Thinking..." placeholder message once a turn starts, and
 * `pipe-server` edits that same message into the final reply text once it lands, rather than
 * sending a second message - keeps the topic from filling up with a throwaway line per turn.
 *
 * `start` is idempotent per topic (found 2026-08-09): `nl-dispatch.ts`'s `routeOrFallback` now
 * starts one to cover its own router-call latency, and a no-match forward then hands the same
 * topic straight to `pty-io.ts`'s `sendChannelText`, which calls `start` again to cover the turn
 * that follows - a topic only ever has one turn in flight at a time, so that second call is
 * covering the *same* wait, not a new one. Without this no-op, it would silently orphan the first
 * message (the map entry gets overwritten, not consumed) - a "🤔 Thinking..." stuck in the topic
 * forever with no reply ever going on to delete it.
 */
export interface ThinkingPlaceholderOptions {
  /** Sends the placeholder message for `topicId`, returning its message_id for later editing. */
  send: (topicId: string) => Promise<number>;
  log?: (level: "WARN", message: string) => void;
}

export interface ThinkingPlaceholder {
  start(topicId: string): void;
  /** Pops and awaits the pending placeholder's message_id for `topicId`, if a turn is in flight. */
  consume(topicId: string): Promise<number | undefined>;
}

export function createThinkingPlaceholder(opts: ThinkingPlaceholderOptions): ThinkingPlaceholder {
  const log = opts.log ?? (() => {});
  const pending = new Map<string, Promise<number | undefined>>();

  function start(topicId: string): void {
    if (pending.has(topicId)) return; // already covering this topic's in-flight turn - see doc comment above
    const promise = opts.send(topicId).catch((err: unknown) => {
      log("WARN", `failed to send thinking placeholder for topic "${topicId}": ${(err as Error).message}`);
      return undefined;
    });
    pending.set(topicId, promise);
  }

  async function consume(topicId: string): Promise<number | undefined> {
    const promise = pending.get(topicId);
    if (!promise) return undefined;
    pending.delete(topicId);
    return promise;
  }

  return { start, consume };
}
