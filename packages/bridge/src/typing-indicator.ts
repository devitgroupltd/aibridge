/**
 * Telegram's `sendChatAction` "typing" status expires after ~5s server-side, so a single call at
 * inject time isn't enough to cover a turn that takes longer than that - it has to be resent on
 * an interval for as long as Claude is still working. The natural stop signal is "a reply for this
 * topic was actually sent" (§4.2's per-topic model means topic_id is the right key), not a guess at
 * when the PTY looks idle - see `index.ts`'s wiring via `pipe-server`'s `onReplySent`.
 *
 * Mobile clients render this indicator fine inside an open topic; Telegram Desktop has a known bug
 * (tdesktop#30452) that only shows it in the topics overview list, not inside the open topic - see
 * `thinking-placeholder.ts` for the message-based indicator that covers that gap. Kept side by side
 * rather than replaced: this one is free and correct on the clients where it works.
 *
 * `maxTicks` is a safety net, not a real expectation: if a turn runs long enough to hit it, letting
 * the typing indicator lapse is harmless (it just goes quiet, exactly like a real chat client after
 * a while) - the alternative, an indicator that nags Telegram forever because a reply never arrived
 * for some unrelated reason, is the actual silent-wrong risk this guards against.
 */
export interface TypingIndicatorOptions {
  send: (topicId: string) => Promise<void>;
  intervalMs?: number;
  maxTicks?: number;
  log?: (level: "WARN", message: string) => void;
}

export interface TypingIndicator {
  start(topicId: string): void;
  stop(topicId: string): void;
}

export function createTypingIndicator(opts: TypingIndicatorOptions): TypingIndicator {
  const intervalMs = opts.intervalMs ?? 4000;
  // 450 ticks * 4s = 30 minutes - covers a long multi-tool-call turn; onReplySent is the real stop
  // signal, this is only the backstop for "a reply never arrives at all" (see doc comment above).
  const maxTicks = opts.maxTicks ?? 450;
  const log = opts.log ?? (() => {});
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  function send(topicId: string): void {
    opts.send(topicId).catch((err: unknown) => {
      log("WARN", `sendChatAction(typing) failed for topic "${topicId}": ${(err as Error).message}`);
    });
  }

  function stop(topicId: string): void {
    const handle = timers.get(topicId);
    if (handle) {
      clearInterval(handle);
      timers.delete(topicId);
    }
  }

  function start(topicId: string): void {
    stop(topicId); // restart cleanly if a previous turn's indicator for this topic is still running
    send(topicId);
    let ticks = 1;
    const handle = setInterval(() => {
      ticks++;
      if (ticks > maxTicks) {
        stop(topicId);
        return;
      }
      send(topicId);
    }, intervalMs);
    timers.set(topicId, handle);
  }

  return { start, stop };
}
