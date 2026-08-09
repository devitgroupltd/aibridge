import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { encodeMessage, NdjsonDecoder, PROTOCOL_VERSION } from "@aibridge/protocol";
import type { HelloFromHook, HookAskMessage, Message } from "@aibridge/protocol";
import { askOnce } from "../src/ask-once.ts";

/**
 * §2.5's blocking-ask reconnect protocol: "a blocked hook that loses the socket keeps waiting,"
 * re-sending `hello`+`ask` on every reconnect attempt so the Bridge can rebind rather than repost
 * the question (`pipe-server.ts`'s own `handleAsk` dedupes by `request_id` for exactly this case).
 * This is precisely the kind of protocol contract another component branches on that §9 asks to be
 * tested directly, and it had no coverage at all - the Bridge side of the same handshake
 * (`pipe-server.test.ts`) is tested, but nothing exercised this side of it.
 */

function pipePath(): string {
  return `\\\\.\\pipe\\aibridge-ask-once-test-${crypto.randomUUID()}`;
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const HELLO: HelloFromHook = { v: PROTOCOL_VERSION, type: "hello", role: "hook", slug: "test-session", pid: 4242, event: "PreToolUse" };
const ASK: HookAskMessage = {
  v: PROTOCOL_VERSION,
  type: "ask",
  slug: "test-session",
  request_id: "toolu_abc123",
  questions: [{ question: "Pick a color", options: [{ label: "Red" }, { label: "Blue" }] }],
};

describe("askOnce", () => {
  test("resolves 'answered' with the answers map once the Bridge sends one back", async () => {
    const path = pipePath();
    const received: Message[] = [];
    const server = net.createServer((socket) => {
      const decoder = new NdjsonDecoder();
      socket.on("data", (chunk) => {
        for (const msg of decoder.push(chunk)) {
          received.push(msg);
          if (msg.type === "ask") {
            socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "answer", slug: "test-session", answers: { "Pick a color": "Red" } }));
          }
        }
      });
    });
    servers.push(server);
    server.listen(path);
    await waitFor(() => server.listening);

    const result = await askOnce(path, HELLO, ASK, 5000);

    expect(result).toEqual({ kind: "answered", answers: { "Pick a color": "Red" } });
    // Both hello and ask actually went out, in that order, before the answer was ever sent back.
    expect(received.map((m) => m.type)).toEqual(["hello", "ask"]);
  });

  test("resolves 'cancelled' when the Bridge sends { cancel: true } (§6.4's 3540s ceiling)", async () => {
    const path = pipePath();
    const server = net.createServer((socket) => {
      const decoder = new NdjsonDecoder();
      socket.on("data", (chunk) => {
        for (const msg of decoder.push(chunk)) {
          if (msg.type === "ask") {
            socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "answer", slug: "test-session", cancel: true }));
          }
        }
      });
    });
    servers.push(server);
    server.listen(path);
    await waitFor(() => server.listening);

    const result = await askOnce(path, HELLO, ASK, 5000);

    expect(result).toEqual({ kind: "cancelled" });
  });

  test("reconnects and re-sends hello+ask (dedupe-by-request_id on the Bridge side) after the first connection drops before answering", async () => {
    const path = pipePath();
    let connectionCount = 0;
    const helloAsksByConnection: string[][] = [];
    const server = net.createServer((socket) => {
      connectionCount += 1;
      const thisConnection = connectionCount;
      helloAsksByConnection[thisConnection - 1] = [];
      const decoder = new NdjsonDecoder();
      socket.on("data", (chunk) => {
        for (const msg of decoder.push(chunk)) {
          helloAsksByConnection[thisConnection - 1]!.push(msg.type);
          if (msg.type === "ask") {
            if (thisConnection === 1) {
              // Simulate a dropped connection (Bridge restart, network blip) before ever answering -
              // the hook client must reconnect and re-send hello+ask on its own, not give up.
              socket.destroy();
              return;
            }
            socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "answer", slug: "test-session", answers: { "Pick a color": "Blue" } }));
          }
        }
      });
    });
    servers.push(server);
    server.listen(path);
    await waitFor(() => server.listening);

    const result = await askOnce(path, HELLO, ASK, 5000);

    expect(result).toEqual({ kind: "answered", answers: { "Pick a color": "Blue" } });
    expect(connectionCount).toBeGreaterThanOrEqual(2);
    // The reconnect re-sent both hello and ask - the Bridge dedupes by request_id rather than
    // treating this as a fresh, second question.
    expect(helloAsksByConnection[0]).toEqual(["hello", "ask"]);
    expect(helloAsksByConnection[1]).toEqual(["hello", "ask"]);
  });

  test("resolves 'timeout' if the Bridge is never reachable at all, honouring hardTimeoutMs as a backstop behind §6.4's own 3540s ceiling", async () => {
    // No server listening at this path at all - every connection attempt fails, forcing the
    // reconnect loop to keep retrying until the hard timeout backstop fires.
    const path = pipePath();

    const result = await askOnce(path, HELLO, ASK, 300);

    expect(result).toEqual({ kind: "timeout" });
  });
});
