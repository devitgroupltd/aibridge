import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { NdjsonDecoder } from "@aibridge/protocol";
import type { Message, ReplyMessage, VerdictMessage } from "@aibridge/protocol";
import { PipeClient } from "../src/pipe-client.ts";

function pipePath(): string {
  return `\\\\.\\pipe\\aibridge-test-${crypto.randomUUID()}`;
}

function startStubServer(path: string, received: Message[]) {
  const decoder = new NdjsonDecoder();
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      for (const msg of decoder.push(chunk)) received.push(msg);
    });
  });
  return new Promise<net.Server>((resolve) => {
    server.listen(path, () => resolve(server));
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const clients: PipeClient[] = [];
const servers: net.Server[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) s.close();
});

describe("PipeClient", () => {
  test("sends hello immediately on connect", async () => {
    const path = pipePath();
    const received: Message[] = [];
    servers.push(await startStubServer(path, received));

    const client = new PipeClient({ slug: "test-session", pipePath: path, onMessage: () => {} });
    clients.push(client);
    client.start();

    await waitFor(() => received.length >= 1);
    expect(received[0]).toMatchObject({ type: "hello", role: "channel", slug: "test-session" });
  });

  // §9 scenario 33: a channel server queues a `reply` while disconnected and delivers it on reconnect.
  test("queues a reply while disconnected and flushes it once connected", async () => {
    const path = pipePath();
    const received: Message[] = [];

    const client = new PipeClient({ slug: "test-session", pipePath: path, onMessage: () => {} });
    clients.push(client);
    client.start(); // no server listening yet - this will fail and retry with backoff

    const reply: ReplyMessage = { v: 1, type: "reply", slug: "test-session", topic_id: "3", text: "hi" };
    client.send(reply);

    servers.push(await startStubServer(path, received));

    await waitFor(() => received.length >= 2, 5000);
    expect(received[0]?.type).toBe("hello");
    expect(received[1]).toMatchObject(reply);
  });

  // §2.5: bounded at 100, and a priority message (reply) is never dropped to make room for a
  // non-priority one. `verdict` is only ever Bridge->channel in the real protocol; it stands in
  // here purely as a synthetic non-priority payload to exercise the drop-preference branch, since
  // Phase 1 has no real non-priority outbound message type yet (that arrives with the feed, Phase 3).
  test("drops queued non-priority messages before a priority reply", async () => {
    const path = pipePath();
    const received: Message[] = [];

    const client = new PipeClient({ slug: "test-session", pipePath: path, onMessage: () => {} });
    clients.push(client);
    client.start();

    const reply: ReplyMessage = { v: 1, type: "reply", slug: "test-session", topic_id: "3", text: "keep-me" };
    client.send(reply);
    for (let i = 0; i < 105; i++) {
      const filler: VerdictMessage = {
        v: 1,
        type: "verdict",
        slug: "test-session",
        request_id: `filler-${i}`,
        behavior: "allow",
      };
      client.send(filler);
    }

    servers.push(await startStubServer(path, received));
    await waitFor(() => received.length >= 101, 5000); // hello + 100 queued messages

    const forwarded = received.slice(1);
    expect(forwarded).toHaveLength(100);
    expect(forwarded.some((m) => m.type === "reply")).toBe(true);
  });
});
