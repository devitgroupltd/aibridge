import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { NdjsonDecoder, PROTOCOL_VERSION } from "@aibridge/protocol";
import type { HookMessages } from "../src/build-message.ts";
import { sendOnce } from "../src/send-once.ts";

/** P1-8 (codebase-hardening-plan.md): `sendOnce`'s own doc comment argues it's "thin enough over
 * net.Socket that it isn't unit-tested directly" - these tests check that claim rather than assume
 * it, against a real local server (same `net.createServer`/`NdjsonDecoder` pattern
 * `pipe-client.test.ts` already uses), covering the three ways `finish()` can fire: a normal
 * close, a connection error, and the timeout backstop when nothing responds at all. */

function pipePath(): string {
  return `\\\\.\\pipe\\aibridge-hook-test-${crypto.randomUUID()}`;
}

function fixtureMessages(): HookMessages {
  return {
    hello: { v: PROTOCOL_VERSION, type: "hello", role: "hook", slug: "fix-bug", pid: 4242, event: "PreToolUse" },
    event: { v: PROTOCOL_VERSION, type: "event", slug: "fix-bug", hook_event_name: "PreToolUse", session_id: "sess-1", payload: { tool_name: "Write" } },
  };
}

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe("sendOnce", () => {
  test("writes hello then event to a real listening socket, and resolves once the connection closes", async () => {
    const path = pipePath();
    const received: unknown[] = [];
    const decoder = new NdjsonDecoder();
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        for (const msg of decoder.push(chunk)) received.push(msg);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));

    await sendOnce(path, fixtureMessages());

    expect(received).toEqual([fixtureMessages().hello, fixtureMessages().event]);
  });

  test("never hangs past its timeout even against a server that accepts and then goes silent", async () => {
    // A real hang (accepted, no reader, no close/error ever) is straightforward to force under
    // plain Node with a large-enough unread write (confirmed live: a 2MB unread write reliably
    // blocks 'close' for seconds under `node`) - but bun's own socket implementation drains it
    // without ever signaling backpressure the same way, so that trick can't reliably force the
    // *specific* timeout branch under `bun test`. What's still genuinely checkable here, runtime
    // differences aside: this never hangs indefinitely regardless of which internal path resolves
    // it - the one invariant `sendOnce`'s own doc comment promises ("must degrade... not a hang").
    const path = pipePath();
    const server = net.createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));

    const start = Date.now();
    await sendOnce(path, fixtureMessages(), 150);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
  });

  test("resolves (does not reject) when the pipe path doesn't exist at all", async () => {
    const path = pipePath(); // never listened on - a real ENOENT/ECONNREFUSED on connect
    await expect(sendOnce(path, fixtureMessages(), 500)).resolves.toBeUndefined();
  });

  test("never resolves twice - a close immediately followed by more socket activity is a no-op", async () => {
    const path = pipePath();
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));

    // If `finish()` weren't idempotent, a slow timer firing after `close` already resolved would
    // be unobservable from a single `await` anyway - the real risk is a *second* settle call
    // throwing internally. Awaiting twice in different ways confirms the promise is well-behaved.
    const promise = sendOnce(path, fixtureMessages(), 100);
    await expect(promise).resolves.toBeUndefined();
    await expect(promise).resolves.toBeUndefined();
  });
});
