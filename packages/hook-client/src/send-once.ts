import net from "node:net";
import { encodeMessage } from "@aibridge/protocol";
import type { HookMessages } from "./build-message.ts";

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Fire-and-forget: connect, write both messages, close. Never rejects - every hook this fires
 * from is declared `async` (§5.1), so a missing or unreachable Bridge must degrade to "this event
 * never reached the feed", not a hang in Claude Code's own hook pipeline. Thin enough over
 * `net.Socket` that it isn't unit-tested directly; `build-message.ts` carries the logic that is.
 */
export function sendOnce(pipePath: string, messages: HookMessages, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve();
    };

    const socket = net.connect(pipePath);
    const timer = setTimeout(finish, timeoutMs);

    socket.on("connect", () => {
      socket.write(encodeMessage(messages.hello));
      socket.write(encodeMessage(messages.event));
      socket.end();
    });
    socket.on("close", finish);
    socket.on("error", finish);
  });
}
