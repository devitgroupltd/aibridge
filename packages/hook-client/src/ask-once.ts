import net from "node:net";
import { encodeMessage, NdjsonDecoder } from "@aibridge/protocol";
import type { HelloFromHook, HookAnswerMessage, HookAskMessage, Message } from "@aibridge/protocol";

export type AskResolution = { kind: "answered"; answers: Record<string, string> } | { kind: "cancelled" } | { kind: "timeout" };

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5000;

/**
 * Blocks until the Bridge pushes back an `answer` for this ask, or `hardTimeoutMs` elapses with
 * the Bridge never reachable at all. That local ceiling is a backstop behind the Bridge's own
 * 3540s cancel-and-post (§6.4) - in the normal case the Bridge's `answer` arrives first and this
 * timer never fires. Reconnects with capped exponential backoff rather than failing on a dropped
 * socket (§2.5: "a blocked hook that loses the socket keeps waiting"), re-sending `hello`+`ask` on
 * every attempt - the Bridge dedupes by `request_id` (the tool's own `tool_use_id`, stable across
 * reconnects) instead of reposting the question.
 */
export function askOnce(pipePath: string, hello: HelloFromHook, ask: HookAskMessage, hardTimeoutMs: number): Promise<AskResolution> {
  return new Promise((resolve) => {
    let done = false;
    let attempt = 0;
    let socket: net.Socket | undefined;
    let reconnectTimer: NodeJS.Timeout | undefined;

    const finish = (result: AskResolution) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.removeAllListeners();
      socket?.destroy();
      resolve(result);
    };

    const hardTimer = setTimeout(() => finish({ kind: "timeout" }), hardTimeoutMs);

    const scheduleReconnect = () => {
      if (done) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };

    function connect(): void {
      if (done) return;
      const decoder = new NdjsonDecoder();
      socket = net.connect(pipePath);

      socket.on("connect", () => {
        attempt = 0;
        socket!.write(encodeMessage(hello));
        socket!.write(encodeMessage(ask));
      });

      socket.on("data", (chunk) => {
        let messages: Message[];
        try {
          messages = decoder.push(chunk);
        } catch {
          return;
        }
        for (const msg of messages) {
          if (msg.type !== "answer") continue;
          const answer = msg as HookAnswerMessage;
          if (answer.cancel) {
            finish({ kind: "cancelled" });
          } else {
            finish({ kind: "answered", answers: answer.answers ?? {} });
          }
        }
      });

      socket.on("error", scheduleReconnect);
      socket.on("close", scheduleReconnect);
    }

    connect();
  });
}
