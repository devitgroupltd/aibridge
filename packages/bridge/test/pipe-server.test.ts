import { afterEach, describe, expect, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { encodeMessage, NdjsonDecoder, PROTOCOL_VERSION } from "@aibridge/protocol";
import type { HelloFromChannel, HookAskMessage, Message, PermissionRequestMessage, ReplyMessage } from "@aibridge/protocol";
import { ensureOutboxDir } from "../src/outbox.ts";
import { startPipeServer } from "../src/pipe-server.ts";
import { RateGovernor } from "../src/rate-governor.ts";
import { Routing } from "../src/routing.ts";
import { createThinkingPlaceholder } from "../src/thinking-placeholder.ts";
import type { SendMessageSource } from "../src/telegram.ts";

function pipePath(): string {
  return `\\\\.\\pipe\\aibridge-test-${crypto.randomUUID()}`;
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

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
});

function connectClient(path: string): { socket: net.Socket; received: Message[] } {
  const decoder = new NdjsonDecoder();
  const received: Message[] = [];
  const socket = net.connect(path);
  socket.on("data", (chunk) => received.push(...decoder.push(chunk)));
  sockets.push(socket);
  return { socket, received };
}

const noopControlBot: SendMessageSource = { sendMessage: async () => ({ message_id: 1 }) };

describe("startPipeServer", () => {
  test("hello gets an ack carrying the routed topic_id", async () => {
    const path = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "c:\\data\\worktrees\\test-session" });

    const handle = startPipeServer({ pipePath: path, routing, controlBot: noopControlBot, chatId: "-1004470540564" });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket, received } = connectClient(path);
    const hello: HelloFromChannel = { v: PROTOCOL_VERSION, type: "hello", role: "channel", slug: "test-session", pid: 123 };
    await waitFor(() => socket.readyState === "open");
    socket.write(encodeMessage(hello));

    await waitFor(() => received.length >= 1);
    expect(received[0]).toMatchObject({ type: "hello_ack", topic_id: 3, session_state: "idle" });
  });

  test("hello for an unknown slug still acks, marked unknown", async () => {
    const path = pipePath();
    const routing = new Routing();

    const handle = startPipeServer({ pipePath: path, routing, controlBot: noopControlBot, chatId: "-1" });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket, received } = connectClient(path);
    await waitFor(() => socket.readyState === "open");
    socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "hello", role: "channel", slug: "ghost", pid: 1 } satisfies HelloFromChannel));

    await waitFor(() => received.length >= 1);
    expect(received[0]).toMatchObject({ session_state: "unknown", topic_id: -1 });
  });

  test("onChannelConnected fires with the slug once the channel server's hello arrives", async () => {
    const path = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "c:\\data\\worktrees\\test-session" });

    const connected: string[] = [];
    const handle = startPipeServer({
      pipePath: path,
      routing,
      controlBot: noopControlBot,
      chatId: "-1",
      onChannelConnected: (slug) => connected.push(slug),
    });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path);
    await waitFor(() => socket.readyState === "open");
    socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "hello", role: "channel", slug: "test-session", pid: 123 } satisfies HelloFromChannel));

    await waitFor(() => connected.length >= 1);
    expect(connected).toEqual(["test-session"]);
  });

  test("reply is forwarded to the control bot in the session's chat/topic", async () => {
    const path = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const calls: Array<{ chatId: string | number; threadId?: number; text: string }> = [];
    const controlBot: SendMessageSource = {
      sendMessage: async (chatId, threadId, text) => {
        calls.push({ chatId, threadId, text });
        return { message_id: 1 };
      },
    };

    const handle = startPipeServer({ pipePath: path, routing, controlBot, chatId: "-1004470540564" });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path);
    await waitFor(() => socket.readyState === "open");
    const reply: ReplyMessage = { v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "hi from claude" };
    socket.write(encodeMessage(reply));

    await waitFor(() => calls.length >= 1);
    expect(calls[0]).toEqual({ chatId: "-1004470540564", threadId: 3, text: "hi from claude" });
  });

  test("two multi-chunk replies for the same slug never interleave their chunks, even when the first is slow (§9, found live 2026-08-09)", async () => {
    const path = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const calls: string[] = [];
    let sendCount = 0;
    let resolveFirst: (() => void) | undefined;
    const firstSendBlocked = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const controlBot: SendMessageSource = {
      sendMessage: async (_chatId, _threadId, text) => {
        sendCount += 1;
        // Only the very first send (reply A's first chunk) blocks - simulates a slow Telegram round
        // trip on the send that started first. Without per-slug serialization, reply B's own chunks
        // (dispatched right after, on a separate connection-less call) would race ahead of it and
        // land before A's first chunk ever completes.
        if (sendCount === 1) await firstSendBlocked;
        calls.push(text);
        return { message_id: sendCount };
      },
    };

    const handle = startPipeServer({ pipePath: path, routing, controlBot, chatId: "-1004470540564" });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path);
    await waitFor(() => socket.readyState === "open");

    // Two lines, each comfortably under Telegram's chunk limit on its own but combined over it -
    // `splitForTelegram` keeps line boundaries where it can, so this reliably yields exactly two
    // chunks per reply (one per line) rather than a mid-line hard split.
    const replyA: ReplyMessage = {
      v: PROTOCOL_VERSION,
      type: "reply",
      slug: "test-session",
      topic_id: "3",
      text: `${"A".repeat(3000)}\n${"a".repeat(3000)}`,
    };
    const replyB: ReplyMessage = {
      v: PROTOCOL_VERSION,
      type: "reply",
      slug: "test-session",
      topic_id: "3",
      text: `${"B".repeat(3000)}\n${"b".repeat(3000)}`,
    };
    socket.write(encodeMessage(replyA));
    await waitFor(() => sendCount >= 1); // A's first chunk has started (and is now blocked)
    socket.write(encodeMessage(replyB));
    // Give reply B's own handling plenty of time to run, if nothing were serializing it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    resolveFirst?.();

    await waitFor(() => calls.length >= 4);
    // Grouped per reply - A's two chunks land together, then B's two chunks - never interleaved
    // (e.g. never A0, B0, B1, A1).
    expect(calls[0]?.startsWith("A")).toBe(true);
    expect(calls[1]?.startsWith("a")).toBe(true);
    expect(calls[2]?.startsWith("B")).toBe(true);
    expect(calls[3]?.startsWith("b")).toBe(true);
  });

  test("onReplySent fires with the topic_id after a successful reply, and not on a failed one", async () => {
    const path = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const fired: string[] = [];
    const controlBot: SendMessageSource = { sendMessage: async () => ({ message_id: 1 }) };

    const handle = startPipeServer({
      pipePath: path,
      routing,
      controlBot,
      chatId: "-1",
      onReplySent: (topicId) => fired.push(topicId),
    });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path);
    await waitFor(() => socket.readyState === "open");
    socket.write(
      encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "hi" } satisfies ReplyMessage),
    );

    await waitFor(() => fired.length >= 1);
    expect(fired).toEqual(["3"]);
  });

  test("onReplySent does not fire when the send itself fails", async () => {
    const path = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const fired: string[] = [];
    const errors: string[] = [];
    const controlBot: SendMessageSource = {
      sendMessage: async () => {
        throw new Error("network blip");
      },
    };

    const handle = startPipeServer({
      pipePath: path,
      routing,
      controlBot,
      chatId: "-1",
      onReplySent: (topicId) => fired.push(topicId),
      log: (level, message) => {
        if (level === "ERROR") errors.push(message);
      },
    });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path);
    await waitFor(() => socket.readyState === "open");
    socket.write(
      encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "hi" } satisfies ReplyMessage),
    );

    await waitFor(() => errors.length >= 1);
    expect(fired).toEqual([]);
  });

  // The 2026-08-07 reply-vs-feed-card ordering fix: onBeforeReply must fire with the slug (not the
  // topic_id - the caller needs it to key FeedCoalescer.reset) and, critically, before the reply's
  // own send goes out, not after (unlike onReplySent).
  test("onBeforeReply fires with the slug before the reply is actually sent", async () => {
    const path = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const order: string[] = [];
    const controlBot: SendMessageSource = {
      sendMessage: async () => {
        order.push("sent");
        return { message_id: 1 };
      },
    };

    const handle = startPipeServer({
      pipePath: path,
      routing,
      controlBot,
      chatId: "-1",
      onBeforeReply: (slug) => { order.push(`before:${slug}`); },
    });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path);
    await waitFor(() => socket.readyState === "open");
    socket.write(
      encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "hi" } satisfies ReplyMessage),
    );

    await waitFor(() => order.length >= 2);
    expect(order).toEqual(["before:test-session", "sent"]);
  });

  // 0.97.0: the fix above only proved onBeforeReply is *invoked* first - not that the reply
  // actually waits for it. An async onBeforeReply that resolves after its own send completes is
  // the case that matters: without the await added in this version, "sent" could still land before
  // "flushed" below, since firing a call and awaiting its completion are different things.
  test("an async onBeforeReply is awaited - the reply cannot be sent until it resolves", async () => {
    const path = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const order: string[] = [];
    const controlBot: SendMessageSource = {
      sendMessage: async () => {
        order.push("sent");
        return { message_id: 1 };
      },
    };

    const handle = startPipeServer({
      pipePath: path,
      routing,
      controlBot,
      chatId: "-1",
      onBeforeReply: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("flushed");
      },
    });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path);
    await waitFor(() => socket.readyState === "open");
    socket.write(
      encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "hi" } satisfies ReplyMessage),
    );

    await waitFor(() => order.length >= 2);
    expect(order).toEqual(["flushed", "sent"]);
  });

  // The bounded half of the same fix: a wedged/rate-limited feed send must never hang a reply
  // forever. onBeforeReplyTimeoutMs caps the wait, so the reply still goes out - just without the
  // ordering guarantee for that one turn, which is the documented, accepted trade-off.
  test("a never-resolving onBeforeReply does not block the reply past its timeout", async () => {
    const path = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const sent: string[] = [];
    const controlBot: SendMessageSource = {
      sendMessage: async (_chatId, _threadId, text) => {
        sent.push(text);
        return { message_id: 1 };
      },
    };

    const handle = startPipeServer({
      pipePath: path,
      routing,
      controlBot,
      chatId: "-1",
      onBeforeReply: () => new Promise(() => {}), // never settles
      onBeforeReplyTimeoutMs: 30,
    });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path);
    await waitFor(() => socket.readyState === "open");
    socket.write(
      encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "hi" } satisfies ReplyMessage),
    );

    // A short waitFor budget: this only passes if the reply proceeds once the much shorter
    // onBeforeReplyTimeoutMs elapses, rather than staying stuck behind a barrier that never settles.
    await waitFor(() => sent.length >= 1, 500);
    expect(sent).toEqual(["hi"]);
  });

  // The gap the two tests above don't cover: what if onBeforeReply itself *rejects*? Without an
  // explicit catch, that rejection propagates through handleReply's own try/catch and skips
  // sending the reply entirely - an unrelated ordering-barrier failure silently dropping the
  // operator's actual answer. Today's real wiring can't reject (RateGovernor.schedule/
  // scheduleP2Async never do), but this is a defensive backstop, not a currently-reachable path.
  test("a rejecting onBeforeReply logs a warning but still lets the reply through", async () => {
    const path = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const sent: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const controlBot: SendMessageSource = {
      sendMessage: async (_chatId, _threadId, text) => {
        sent.push(text);
        return { message_id: 1 };
      },
    };

    const handle = startPipeServer({
      pipePath: path,
      routing,
      controlBot,
      chatId: "-1",
      onBeforeReply: async () => {
        throw new Error("feed flush blew up");
      },
      log: (level, message) => {
        if (level === "WARN") warnings.push(message);
        if (level === "ERROR") errors.push(message);
      },
    });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path);
    await waitFor(() => socket.readyState === "open");
    socket.write(
      encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "hi" } satisfies ReplyMessage),
    );

    await waitFor(() => sent.length >= 1);
    expect(sent).toEqual(["hi"]); // the reply still went out despite the barrier failing
    expect(warnings.some((w) => w.includes("feed flush blew up"))).toBe(true);
    expect(errors).toEqual([]); // not swallowed into the generic ERROR path - it's a known, named failure mode
  });

  describe("thinking placeholder", () => {
    // 0.104.0: this used to assert the opposite - that a reply *edited* the placeholder in place
    // rather than sending a second message. Editing pinned the reply's visible position to
    // wherever "🤔 Thinking..." first landed (turn-start), which a real Bridge restart's worth of
    // ordering fixes (0.97.0, 0.101.0) could never fix, since neither touches *where* an edited
    // message sits - only *when* independent sends complete. The reply now always sends fresh, and
    // the placeholder is deleted afterward instead of reused.
    test("a reply sends fresh and deletes the pending placeholder, rather than editing it in place", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const sent: Array<{ text: string }> = [];
      const deleted: number[] = [];
      const controlBot: SendMessageSource = {
        sendMessage: async (_chatId, _threadId, text) => {
          sent.push({ text });
          return { message_id: 99 };
        },
        editMessageText: async () => {
          throw new Error("should not be called - the reply must send fresh, not edit the placeholder");
        },
        deleteMessage: async (_chatId, messageId) => {
          deleted.push(messageId);
        },
      };
      const thinkingPlaceholder = createThinkingPlaceholder({ send: async () => 55 });
      thinkingPlaceholder.start("3");

      const handle = startPipeServer({ pipePath: path, routing, controlBot, chatId: "-1", thinkingPlaceholder });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket } = connectClient(path);
      await waitFor(() => socket.readyState === "open");
      socket.write(
        encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "the answer" } satisfies ReplyMessage),
      );

      await waitFor(() => sent.length >= 1 && deleted.length >= 1);
      expect(sent).toEqual([{ text: "the answer" }]);
      expect(deleted).toEqual([55]);
    });

    test("still sends fine (no delete attempted) when no placeholder is pending for that topic", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const sent: Array<{ text: string }> = [];
      const controlBot: SendMessageSource = {
        sendMessage: async (_chatId, _threadId, text) => {
          sent.push({ text });
          return { message_id: 1 };
        },
        deleteMessage: async () => {
          throw new Error("should not be called - nothing pending");
        },
      };
      const thinkingPlaceholder = createThinkingPlaceholder({ send: async () => 1 });
      // No .start() call - nothing pending for topic "3".

      const handle = startPipeServer({ pipePath: path, routing, controlBot, chatId: "-1", thinkingPlaceholder });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket } = connectClient(path);
      await waitFor(() => socket.readyState === "open");
      socket.write(
        encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "hi" } satisfies ReplyMessage),
      );

      await waitFor(() => sent.length >= 1);
      expect(sent).toEqual([{ text: "hi" }]);
    });

    test("a reply that scrubs down to empty still consumes and deletes the pending placeholder", async () => {
      // 2026-08-09, live-observed as a "Thinking..." bubble that only disappeared several messages
      // later than expected: the old code `return`ed on an empty-after-scrub reply *before* ever
      // reaching the consume/delete call below it, so the placeholder from that turn sat there,
      // unrelated to anything currently running, until some later reply happened to consume it.
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const sent: Array<{ text: string }> = [];
      const deleted: number[] = [];
      const warnings: string[] = [];
      const controlBot: SendMessageSource = {
        sendMessage: async (_chatId, _threadId, text) => {
          sent.push({ text });
          return { message_id: 1 };
        },
        deleteMessage: async (_chatId, messageId) => {
          deleted.push(messageId);
        },
      };
      const thinkingPlaceholder = createThinkingPlaceholder({ send: async () => 55 });
      thinkingPlaceholder.start("3");

      const handle = startPipeServer({
        pipePath: path,
        routing,
        controlBot,
        chatId: "-1",
        thinkingPlaceholder,
        log: (level, message) => {
          if (level === "WARN") warnings.push(message);
        },
      });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket } = connectClient(path);
      await waitFor(() => socket.readyState === "open");
      // Whitespace-only scrubs down to nothing via `splitForTelegram` - nothing to send, but the
      // placeholder must still clear.
      socket.write(
        encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "   " } satisfies ReplyMessage),
      );

      await waitFor(() => deleted.length >= 1);
      expect(deleted).toEqual([55]);
      expect(sent).toEqual([]);
      expect(warnings.some((w) => w.includes("empty after scrubbing"))).toBe(true);
    });

    test("a deleteMessage failure is logged but never blocks or fails the reply", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const sent: Array<{ text: string }> = [];
      const warnings: string[] = [];
      const controlBot: SendMessageSource = {
        sendMessage: async (_chatId, _threadId, text) => {
          sent.push({ text });
          return { message_id: 1 };
        },
        deleteMessage: async () => {
          throw new Error("Telegram deleteMessage failed: Bad Request: message to delete not found");
        },
      };
      const thinkingPlaceholder = createThinkingPlaceholder({ send: async () => 55 });
      thinkingPlaceholder.start("3");

      const handle = startPipeServer({
        pipePath: path,
        routing,
        controlBot,
        chatId: "-1",
        thinkingPlaceholder,
        log: (level, message) => {
          if (level === "WARN") warnings.push(message);
        },
      });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket } = connectClient(path);
      await waitFor(() => socket.readyState === "open");
      socket.write(
        encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "hi" } satisfies ReplyMessage),
      );

      await waitFor(() => sent.length >= 1);
      expect(sent).toEqual([{ text: "hi" }]); // the reply itself is unaffected by the delete failing
      await waitFor(() => warnings.some((w) => w.includes("failed to delete the thinking placeholder")));
    });
  });

  // §9 scenario 34: an unrecognised message type is logged and ignored, not a reason to drop the connection.
  test("an unrecognised message type does not break the connection", async () => {
    const path = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const calls: string[] = [];
    const controlBot: SendMessageSource = {
      sendMessage: async (_chatId, _threadId, text) => {
        calls.push(text);
        return { message_id: 1 };
      },
    };
    const warnings: string[] = [];

    const handle = startPipeServer({
      pipePath: path,
      routing,
      controlBot,
      chatId: "-1",
      log: (level, message) => {
        if (level === "WARN") warnings.push(message);
      },
    });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path);
    await waitFor(() => socket.readyState === "open");
    socket.write(JSON.stringify({ v: 2, type: "some_future_type", slug: "test-session" }) + "\n");
    const reply: ReplyMessage = { v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "still works" };
    socket.write(encodeMessage(reply));

    await waitFor(() => calls.length >= 1);
    expect(calls).toEqual(["still works"]);
    await waitFor(() => warnings.length >= 1);
    expect(warnings[0]).toMatch(/some_future_type/);
  });

  // §5.4: when a governor is supplied, permission/ask cards and their resolutions go through its
  // P0 lane and replies through P1 - not a behaviour change from the caller's point of view (same
  // eventual sendMessage call, same message_id back), just routed through the budget instead of
  // calling controlBot directly.
  describe("governor wiring (§5.4)", () => {
    test("a permission_request card is sent via the governor's P0 lane", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const lanes: string[] = [];
      const governor = new RateGovernor({ log: () => {} });
      const originalSchedule = governor.scheduleAsync.bind(governor);
      governor.scheduleAsync = ((lane, fn) => {
        lanes.push(lane);
        return originalSchedule(lane, fn);
      }) as typeof governor.scheduleAsync;
      const controlBot: SendMessageSource = { sendMessage: async () => ({ message_id: 7 }) };

      const handle = startPipeServer({ pipePath: path, routing, controlBot, governor, chatId: "-1" });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket } = connectClient(path);
      await waitFor(() => socket.readyState === "open");
      socket.write(
        encodeMessage({
          v: PROTOCOL_VERSION,
          type: "permission_request",
          slug: "test-session",
          request_id: "abcde",
          tool_name: "Bash",
          description: "run a command",
          input_preview: "echo hi",
        } satisfies PermissionRequestMessage),
      );

      await waitFor(() => lanes.length >= 1);
      expect(lanes).toEqual(["P0"]);
      expect(handle.permissionRegistry.get("abcde")?.messageId).toBe(7);
    });

    test("an ask card is sent via the governor's P0 lane", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const lanes: string[] = [];
      const governor = new RateGovernor({ log: () => {} });
      const originalSchedule = governor.scheduleAsync.bind(governor);
      governor.scheduleAsync = ((lane, fn) => {
        lanes.push(lane);
        return originalSchedule(lane, fn);
      }) as typeof governor.scheduleAsync;
      const controlBot: SendMessageSource = { sendMessage: async () => ({ message_id: 8 }) };

      const handle = startPipeServer({ pipePath: path, routing, controlBot, governor, chatId: "-1" });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket } = connectClient(path);
      await waitFor(() => socket.readyState === "open");
      socket.write(
        encodeMessage({
          v: PROTOCOL_VERSION,
          type: "ask",
          slug: "test-session",
          request_id: "req-1",
          questions: [{ question: "Which approach?", options: [{ label: "A" }, { label: "B" }] }],
        } satisfies HookAskMessage),
      );

      await waitFor(() => lanes.length >= 1);
      expect(lanes).toEqual(["P0"]);
    });

    test("a reply is sent via the governor's P1 lane", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const lanes: string[] = [];
      const governor = new RateGovernor({ log: () => {} });
      const originalSchedule = governor.scheduleAsync.bind(governor);
      governor.scheduleAsync = ((lane, fn) => {
        lanes.push(lane);
        return originalSchedule(lane, fn);
      }) as typeof governor.scheduleAsync;
      const controlBot: SendMessageSource = { sendMessage: async () => ({ message_id: 1 }) };

      const handle = startPipeServer({ pipePath: path, routing, controlBot, governor, chatId: "-1" });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket } = connectClient(path);
      await waitFor(() => socket.readyState === "open");
      socket.write(
        encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "hi" } satisfies ReplyMessage),
      );

      await waitFor(() => lanes.length >= 1);
      expect(lanes).toEqual(["P1"]);
    });

    test("with no governor supplied, sends still go straight to controlBot (pre-governor behaviour, unchanged)", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const calls: string[] = [];
      const controlBot: SendMessageSource = {
        sendMessage: async (_chatId, _threadId, text) => {
          calls.push(text);
          return { message_id: 1 };
        },
      };

      const handle = startPipeServer({ pipePath: path, routing, controlBot, chatId: "-1" });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket } = connectClient(path);
      await waitFor(() => socket.readyState === "open");
      socket.write(
        encodeMessage({ v: PROTOCOL_VERSION, type: "reply", slug: "test-session", topic_id: "3", text: "hi" } satisfies ReplyMessage),
      );

      await waitFor(() => calls.length >= 1);
      expect(calls).toEqual(["hi"]);
    });
  });

  // `/auto permission` / `/auto answer` (bypass-and-autoanswer-plan.md §1.1/§2.2): the Bridge
  // resolves the escalation itself instead of posting a card, and leaves a plain-text trace.
  describe("auto-resolve toggles", () => {
    async function connectedSession(routing: Routing, controlBot: SendMessageSource) {
      const path_ = pipePath();
      const handle = startPipeServer({ pipePath: path_, routing, controlBot, chatId: "-1" });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);
      const { socket, received } = connectClient(path_);
      await waitFor(() => socket.readyState === "open");
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "hello", role: "channel", slug: "test-session", pid: 1 } satisfies HelloFromChannel));
      await waitFor(() => received.some((m) => m.type === "hello_ack"));
      return { socket, received };
    }

    const permissionRequest = (requestId: string): PermissionRequestMessage => ({
      v: PROTOCOL_VERSION,
      type: "permission_request",
      slug: "test-session",
      request_id: requestId,
      tool_name: "Bash",
      description: "run a command",
      input_preview: JSON.stringify({ command: "git push origin main" }),
    });

    const ask = (requestId: string, questions: HookAskMessage["questions"]): HookAskMessage => ({
      v: PROTOCOL_VERSION,
      type: "ask",
      slug: "test-session",
      request_id: requestId,
      questions,
    });

    test("bypass on auto-allows with no card, and posts a plain-text notice naming the call", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      routing.setBypass("test-session", true);
      const sent: string[] = [];
      const { socket, received } = await connectedSession(routing, {
        sendMessage: async (_c, _t, text) => {
          sent.push(text);
          return { message_id: 1 };
        },
      });

      socket.write(encodeMessage(permissionRequest("req-bypass")));

      await waitFor(() => received.some((m) => m.type === "verdict"));
      expect(received.find((m) => m.type === "verdict")).toMatchObject({ request_id: "req-bypass", behavior: "allow" });
      await waitFor(() => sent.length >= 1);
      expect(sent[0]).toContain("🔓 auto-approved (auto permission)");
      // The command itself, not the JSON envelope it arrives in - `Bash({ "command": "git push…",…)`
      // crowds out the one thing the operator is reading the line for.
      expect(sent[0]).toContain("Bash(git push origin main)");
      // Plain text, not the card's HTML - postAutoApprovedNote sends with no parse_mode, so reusing
      // renderPermissionCard's helpers would print literal tags.
      expect(sent[0]).not.toContain("<b>");
    });

    // The whole point of the feature is that the verdict is decided instantly and locally. Awaiting
    // the notice would gate it on a rate-governor token (~one per 3s once the bucket drains), so a
    // tool-heavy turn would freeze for minutes. A sendMessage that resolves immediately passes
    // whether the await is there or not - this one never resolves.
    test("the verdict does not wait for the notice's sendMessage to settle", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      routing.setBypass("test-session", true);
      const { socket, received } = await connectedSession(routing, { sendMessage: () => new Promise(() => {}) });

      socket.write(encodeMessage(permissionRequest("req-slow-note")));

      await waitFor(() => received.some((m) => m.type === "verdict"));
      expect(received.find((m) => m.type === "verdict")).toMatchObject({ request_id: "req-slow-note", behavior: "allow" });
    });

    test("a rejecting notice send still delivers the verdict", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      routing.setBypass("test-session", true);
      const { socket, received } = await connectedSession(routing, { sendMessage: async () => Promise.reject(new Error("telegram down")) });

      socket.write(encodeMessage(permissionRequest("req-failed-note")));

      await waitFor(() => received.some((m) => m.type === "verdict"));
      expect(received.find((m) => m.type === "verdict")).toMatchObject({ behavior: "allow" });
    });

    test("bypass off posts the real card and sends no verdict", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const sent: string[] = [];
      const { socket, received } = await connectedSession(routing, {
        sendMessage: async (_c, _t, text) => {
          sent.push(text);
          return { message_id: 1 };
        },
      });

      socket.write(encodeMessage(permissionRequest("req-normal")));

      await waitFor(() => sent.length >= 1);
      expect(sent[0]).toContain("<b>");
      expect(received.some((m) => m.type === "verdict")).toBe(false);
    });

    // The assertion that matters: a "no card posted" check alone passes in the exact failure mode
    // where the answer is built but never written, leaving the hook client blocked forever.
    test("auto-answer picks every recommended option and writes the answer to the waiting socket", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      routing.setAutoAnswer("test-session", true);
      const sent: string[] = [];
      const { socket, received } = await connectedSession(routing, {
        sendMessage: async (_c, _t, text) => {
          sent.push(text);
          return { message_id: 1 };
        },
      });

      socket.write(
        encodeMessage(
          ask("ask-auto", [
            { question: "Which database?", header: "DB", options: [{ label: "Postgres (Recommended)" }, { label: "MySQL" }], multiSelect: false },
            { question: "Run migrations?", header: "Migrate", options: [{ label: "No" }, { label: "Yes (Recommended)" }], multiSelect: false },
          ]),
        ),
      );

      await waitFor(() => received.some((m) => m.type === "answer"));
      expect(received.find((m) => m.type === "answer")).toMatchObject({
        answers: { "Which database?": "Postgres (Recommended)", "Run migrations?": "Yes (Recommended)" },
      });
      // The label goes back verbatim - a real button tap sends `option.label` unchanged, so
      // stripping it here would be a different answer than the operator could have given. Only the
      // notice strips the suffix, for readability.
      await waitFor(() => sent.length >= 2);
      expect(sent[0]).toContain('"Postgres"');
      expect(sent[0]).not.toContain("(Recommended)");
    });

    test("one question without exactly one recommendation posts the whole card, never a partial answer", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      routing.setAutoAnswer("test-session", true);
      const sent: string[] = [];
      const { socket, received } = await connectedSession(routing, {
        sendMessage: async (_c, _t, text) => {
          sent.push(text);
          return { message_id: 1 };
        },
      });

      socket.write(
        encodeMessage(
          ask("ask-mixed", [
            { question: "Which database?", header: "DB", options: [{ label: "Postgres (Recommended)" }, { label: "MySQL" }], multiSelect: false },
            { question: "Which cache?", header: "Cache", options: [{ label: "Redis" }, { label: "Memcached" }], multiSelect: false },
          ]),
        ),
      );

      await waitFor(() => sent.length >= 2);
      expect(received.some((m) => m.type === "answer")).toBe(false);
    });

    // Operator-requested 2026-08-11. Every fixture below is a verbatim option set from a real
    // AskUserQuestion call in this machine's own Claude Code transcripts - the same 715-question
    // corpus the veto's ~11% firing rate was measured against.
    test("an investigate-first option alongside the recommendation posts the real card instead", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      routing.setAutoAnswer("test-session", true);
      const sent: string[] = [];
      const { socket, received } = await connectedSession(routing, {
        sendMessage: async (_c, _t, text) => {
          sent.push(text);
          return { message_id: 1 };
        },
      });

      socket.write(
        encodeMessage(
          ask("ask-investigate", [
            {
              question: "Given auto mode is already on fleet-wide, how should this be handled?",
              header: "Approach",
              options: [
                { label: "Bridge-side decomposition only (Recommended)" },
                { label: "Verify against a real VS Code auto-mode session first" },
                { label: "Widen what counts as 'safe to auto-approve'" },
              ],
              multiSelect: false,
            },
          ]),
        ),
      );

      await waitFor(() => sent.length >= 1);
      expect(received.some((m) => m.type === "answer")).toBe(false);
      expect(sent[0]).toContain("Given auto mode is already on fleet-wide");
    });

    test.each([
      ["Hold off, review the plan changes first", "Yes, implement now (Recommended)"],
      ["Not yet", "Yes, launch it now (Recommended)"],
      ["Need something else first", "Re-running now (Recommended)"],
    ])("real-corpus defer option %p vetoes the auto-answer", async (deferLabel, recLabel) => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      routing.setAutoAnswer("test-session", true);
      const sent: string[] = [];
      const { socket, received } = await connectedSession(routing, {
        sendMessage: async (_c, _t, text) => {
          sent.push(text);
          return { message_id: 1 };
        },
      });

      socket.write(encodeMessage(ask("ask-defer", [{ question: "Proceed?", header: "Go", options: [{ label: recLabel }, { label: deferLabel }], multiSelect: false }])));

      await waitFor(() => sent.length >= 1);
      expect(received.some((m) => m.type === "answer")).toBe(false);
    });

    // The veto must not swallow the ordinary case it shares a corpus with - a plain two-way choice
    // with no defer option still auto-answers, or the feature is off in all but name.
    test.each([
      ["Keep topic title English always (Recommended)", "Let the topic title follow the reply's language"],
      ["Add a bulk command (Recommended)", "Future sessions only"],
      ["Session-only (Recommended)", "Also control-topic, repo-scoped"],
    ])("real-corpus non-defer pair %p still auto-answers", async (recLabel, otherLabel) => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      routing.setAutoAnswer("test-session", true);
      const { socket, received } = await connectedSession(routing, noopControlBot);

      socket.write(encodeMessage(ask("ask-plain", [{ question: "Pick", header: "P", options: [{ label: recLabel }, { label: otherLabel }], multiSelect: false }])));

      await waitFor(() => received.some((m) => m.type === "answer"));
      expect(received.find((m) => m.type === "answer")).toMatchObject({ answers: { Pick: recLabel } });
    });

    // The measured inversion that made "select the investigate option" unshippable: a selection
    // heuristic matching "confirm" inside "no confirmation" would have answered away the very
    // safety confirmation the question existed to enable. Two things keep that impossible here -
    // the veto never *picks* anything, and DEFER_OPTION_RE deliberately omits "confirm" (far too
    // common outside defer contexts to be a signal). Note the recommended label itself contains
    // "first"; the veto only ever inspects the *other* options, or every well-written
    // "do the safe thing first (Recommended)" would veto itself.
    test("the 'no confirmation' inversion case answers the recommended (safe) option, never the other one", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      routing.setAutoAnswer("test-session", true);
      const { socket, received } = await connectedSession(routing, noopControlBot);

      const question = "What should happen after a voice message is transcribed?";
      socket.write(
        encodeMessage(
          ask("ask-inversion", [
            {
              question,
              header: "Voice",
              options: [{ label: "Always show a confirm card first (Recommended)" }, { label: "Auto-send immediately, no confirmation" }],
              multiSelect: false,
            },
          ]),
        ),
      );

      await waitFor(() => received.some((m) => m.type === "answer"));
      expect(received.find((m) => m.type === "answer")).toMatchObject({ answers: { [question]: "Always show a confirm card first (Recommended)" } });
    });

    test("two recommended options in one question is treated as no recommendation", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      routing.setAutoAnswer("test-session", true);
      const sent: string[] = [];
      const { socket, received } = await connectedSession(routing, {
        sendMessage: async (_c, _t, text) => {
          sent.push(text);
          return { message_id: 1 };
        },
      });

      socket.write(
        encodeMessage(ask("ask-two", [{ question: "Pick", header: "P", options: [{ label: "A (Recommended)" }, { label: "B (Recommended)" }], multiSelect: false }])),
      );

      await waitFor(() => sent.length >= 1);
      expect(received.some((m) => m.type === "answer")).toBe(false);
    });

    // `[]` is non-null, so a `findAutoAnswer` without its length guard would take the auto-answer
    // path here and write an empty answers map to a client that then unblocks having answered nothing.
    test("an ask carrying zero questions is not auto-answered", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      routing.setAutoAnswer("test-session", true);
      const { socket, received } = await connectedSession(routing, noopControlBot);

      socket.write(encodeMessage(ask("ask-empty", [])));

      await new Promise((r) => setTimeout(r, 100));
      expect(received.some((m) => m.type === "answer")).toBe(false);
    });

    test("auto-answer off posts the card regardless of recommendations", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const sent: string[] = [];
      const { socket, received } = await connectedSession(routing, {
        sendMessage: async (_c, _t, text) => {
          sent.push(text);
          return { message_id: 1 };
        },
      });

      socket.write(encodeMessage(ask("ask-off", [{ question: "Pick", header: "P", options: [{ label: "A (Recommended)" }, { label: "B" }], multiSelect: false }])));

      await waitFor(() => sent.length >= 1);
      expect(received.some((m) => m.type === "answer")).toBe(false);
    });

    // Placement guard: a re-sent ask for an entry still pending from before the toggle went on must
    // keep rebinding its socket, not be answered out from under a card the operator is looking at.
    test("an ask whose request_id is already registered rebinds instead of being auto-answered", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const sent: string[] = [];
      const { socket, received } = await connectedSession(routing, {
        sendMessage: async (_c, _t, text) => {
          sent.push(text);
          return { message_id: 1 };
        },
      });

      const questions: HookAskMessage["questions"] = [{ question: "Pick", header: "P", options: [{ label: "A (Recommended)" }, { label: "B" }], multiSelect: false }];
      socket.write(encodeMessage(ask("ask-rebind", questions)));
      await waitFor(() => sent.length >= 1);

      routing.setAutoAnswer("test-session", true);
      socket.write(encodeMessage(ask("ask-rebind", questions)));

      await new Promise((r) => setTimeout(r, 100));
      expect(received.some((m) => m.type === "answer")).toBe(false);
      expect(sent.length).toBe(1);
    });

    test("an ask for an unknown slug is still WARN-and-dropped, not auto-answered", async () => {
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const { socket, received } = await connectedSession(routing, noopControlBot);

      socket.write(
        encodeMessage({
          v: PROTOCOL_VERSION,
          type: "ask",
          slug: "ghost",
          request_id: "ask-ghost",
          questions: [{ question: "Pick", header: "P", options: [{ label: "A (Recommended)" }], multiSelect: false }],
        } satisfies HookAskMessage),
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(received.some((m) => m.type === "answer")).toBe(false);
    });
  });

  // compound-permission.ts (2026-08-10): a Bash `permission_request` built entirely out of pieces
  // this session's own generated settings.json already allows individually gets auto-approved -
  // a `verdict` sent straight back over the pipe - instead of ever posting a Telegram card.
  describe("compound Bash auto-approval (compound-permission.ts)", () => {
    async function setupWithSettings(stateDir: string, slug: string, extraAllow: string[] = []) {
      const { writeSettingsFile, generateSettings } = await import("../src/settings.ts");
      const settings = generateSettings();
      writeSettingsFile(stateDir, slug, { ...settings, permissions: { ...settings.permissions, allow: [...settings.permissions.allow, ...extraAllow] } });
    }

    test("a chain of already-allowed pieces is auto-approved - no card posted, a verdict comes back instead", async () => {
      const path_ = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const stateDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "aibridge-pipe-settings-"));
      await setupWithSettings(stateDir, "test-session");
      const sendMessageCalls: string[] = [];
      const controlBot: SendMessageSource = {
        sendMessage: async (_chatId, _threadId, text) => {
          sendMessageCalls.push(text);
          return { message_id: 1 };
        },
      };

      const handle = startPipeServer({ pipePath: path_, routing, controlBot, chatId: "-1", stateDir });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket, received } = connectClient(path_);
      await waitFor(() => socket.readyState === "open");
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "hello", role: "channel", slug: "test-session", pid: 1 } satisfies HelloFromChannel));
      await waitFor(() => received.some((m) => m.type === "hello_ack"));

      socket.write(
        encodeMessage({
          v: PROTOCOL_VERSION,
          type: "permission_request",
          slug: "test-session",
          request_id: "req-compound",
          tool_name: "Bash",
          description: "run a command",
          input_preview: JSON.stringify({ command: `git status && cat README.md; rg TODO` }),
        } satisfies PermissionRequestMessage),
      );

      await waitFor(() => received.some((m) => m.type === "verdict"));
      expect(received.find((m) => m.type === "verdict")).toMatchObject({ request_id: "req-compound", behavior: "allow" });
      // No *card* - but this shortcut does now post a plain one-line notice, brought up to the same
      // observability standard as /auto permission (it was server-log-only before 2026-08-11, with
      // no Telegram-visible trace of what the Bridge approved on the operator's behalf).
      expect(sendMessageCalls.length).toBe(1);
      expect(sendMessageCalls[0]).toContain("auto-approved");
      expect(sendMessageCalls[0]).toContain("every sub-command already allowed");
    });

    test("sed -i chained with already-allowed pieces is auto-approved via the widened prefix, but a lone sed -i is not", async () => {
      const path_ = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const stateDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "aibridge-pipe-settings-"));
      await setupWithSettings(stateDir, "test-session");
      const controlBot: SendMessageSource = { sendMessage: async () => ({ message_id: 1 }) };

      const handle = startPipeServer({ pipePath: path_, routing, controlBot, chatId: "-1", stateDir });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket, received } = connectClient(path_);
      await waitFor(() => socket.readyState === "open");
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "hello", role: "channel", slug: "test-session", pid: 1 } satisfies HelloFromChannel));
      await waitFor(() => received.some((m) => m.type === "hello_ack"));

      socket.write(
        encodeMessage({
          v: PROTOCOL_VERSION,
          type: "permission_request",
          slug: "test-session",
          request_id: "req-sed-chain",
          tool_name: "Bash",
          description: "run a command",
          input_preview: JSON.stringify({ command: `sed -i 's#/deploy#/merge#g' plan.md && grep -c "/deploy" plan.md; grep -c "/merge" plan.md` }),
        } satisfies PermissionRequestMessage),
      );

      await waitFor(() => received.some((m) => m.type === "verdict"));
      expect(received.find((m) => m.type === "verdict")).toMatchObject({ request_id: "req-sed-chain", behavior: "allow" });
    });

    test("a sensitive path anywhere in the chain still posts a normal card, never auto-approved", async () => {
      const path_ = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const stateDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "aibridge-pipe-settings-"));
      await setupWithSettings(stateDir, "test-session");
      const sendMessageCalls: string[] = [];
      const controlBot: SendMessageSource = {
        sendMessage: async (_chatId, _threadId, text) => {
          sendMessageCalls.push(text);
          return { message_id: 1 };
        },
      };

      const handle = startPipeServer({ pipePath: path_, routing, controlBot, chatId: "-1", stateDir });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket, received } = connectClient(path_);
      await waitFor(() => socket.readyState === "open");
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "hello", role: "channel", slug: "test-session", pid: 1 } satisfies HelloFromChannel));
      await waitFor(() => received.some((m) => m.type === "hello_ack"));

      socket.write(
        encodeMessage({
          v: PROTOCOL_VERSION,
          type: "permission_request",
          slug: "test-session",
          request_id: "req-secret",
          tool_name: "Bash",
          description: "run a command",
          input_preview: JSON.stringify({ command: `cat README.md && sed -i 's#a#b#g' .env` }),
        } satisfies PermissionRequestMessage),
      );

      await waitFor(() => sendMessageCalls.length >= 1);
      expect(received.some((m) => m.type === "verdict")).toBe(false);
    });

    test("with no stateDir configured, compound requests fall through to a normal card unchanged", async () => {
      const path_ = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const sendMessageCalls: string[] = [];
      const controlBot: SendMessageSource = {
        sendMessage: async (_chatId, _threadId, text) => {
          sendMessageCalls.push(text);
          return { message_id: 1 };
        },
      };

      const handle = startPipeServer({ pipePath: path_, routing, controlBot, chatId: "-1" });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket, received } = connectClient(path_);
      await waitFor(() => socket.readyState === "open");
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "hello", role: "channel", slug: "test-session", pid: 1 } satisfies HelloFromChannel));
      await waitFor(() => received.some((m) => m.type === "hello_ack"));

      socket.write(
        encodeMessage({
          v: PROTOCOL_VERSION,
          type: "permission_request",
          slug: "test-session",
          request_id: "req-no-statedir",
          tool_name: "Bash",
          description: "run a command",
          input_preview: JSON.stringify({ command: "git status && cat README.md" }),
        } satisfies PermissionRequestMessage),
      );

      await waitFor(() => sendMessageCalls.length >= 1);
      expect(received.some((m) => m.type === "verdict")).toBe(false);
    });
  });

  // codebase-hardening-plan.md P0-7, the non-Bash half of the same shortcut. Measured live
  // 2026-08-12: a running session does not act on a rule appended to its `--settings` file
  // mid-conversation, so an `♾️ Always` tap on a `Write` card wrote the rule and then raised a fresh
  // card on the very next `Write`. `Bash` never showed the bug only because the compound path above
  // re-reads that file per request; this branch gives every other tool the same treatment.
  describe("bare tool-name auto-approval (P0-7)", () => {
    async function runPermissionRequest(opts: { extraAllow?: string[]; toolName: string; inputPreview: string; withStateDir?: boolean }) {
      const { writeSettingsFile, generateSettings } = await import("../src/settings.ts");
      const path_ = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const stateDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "aibridge-pipe-bare-"));
      const settings = generateSettings();
      writeSettingsFile(stateDir, "test-session", {
        ...settings,
        permissions: { ...settings.permissions, allow: [...settings.permissions.allow, ...(opts.extraAllow ?? [])] },
      });
      const sendMessageCalls: string[] = [];
      const controlBot: SendMessageSource = {
        sendMessage: async (_chatId, _threadId, text) => {
          sendMessageCalls.push(text);
          return { message_id: 1 };
        },
      };

      const handle = startPipeServer({
        pipePath: path_,
        routing,
        controlBot,
        chatId: "-1",
        ...(opts.withStateDir === false ? {} : { stateDir }),
      });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket, received } = connectClient(path_);
      await waitFor(() => socket.readyState === "open");
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "hello", role: "channel", slug: "test-session", pid: 1 } satisfies HelloFromChannel));
      await waitFor(() => received.some((m) => m.type === "hello_ack"));

      socket.write(
        encodeMessage({
          v: PROTOCOL_VERSION,
          type: "permission_request",
          slug: "test-session",
          request_id: "req-bare",
          tool_name: opts.toolName,
          description: "do a thing",
          input_preview: opts.inputPreview,
        } satisfies PermissionRequestMessage),
      );

      await waitFor(() => received.some((m) => m.type === "verdict") || sendMessageCalls.length >= 1);
      return { received, sendMessageCalls };
    }

    test("a Write already allow-listed for this session is auto-approved - a verdict, not a second card", async () => {
      const { received, sendMessageCalls } = await runPermissionRequest({
        extraAllow: ["Write"],
        toolName: "Write",
        inputPreview: JSON.stringify({ file_path: "c:\\data\\worktrees\\x\\notes.txt", content: "hi" }),
      });

      expect(received.find((m) => m.type === "verdict")).toMatchObject({ request_id: "req-bare", behavior: "allow" });
      // Same observability contract as the two shortcuts above: no card, but a visible one-liner
      // recording what the Bridge approved on the operator's behalf.
      expect(sendMessageCalls.length).toBe(1);
      expect(sendMessageCalls[0]).toContain("auto-approved");
      expect(sendMessageCalls[0]).toContain("already allowed for this session");
    });

    test("a Write that was never allow-listed still posts a normal card", async () => {
      const { received, sendMessageCalls } = await runPermissionRequest({
        toolName: "Write",
        inputPreview: JSON.stringify({ file_path: "c:\\data\\worktrees\\x\\notes.txt" }),
      });

      expect(received.some((m) => m.type === "verdict")).toBe(false);
      expect(sendMessageCalls.length).toBe(1);
      expect(sendMessageCalls[0]).toContain("wants to run");
    });

    test("an Edit still posts a card even once allow-listed - the baseline's scoped Edit deny rules win", async () => {
      const { received } = await runPermissionRequest({
        extraAllow: ["Edit"],
        toolName: "Edit",
        inputPreview: JSON.stringify({ file_path: "c:\\data\\worktrees\\x\\src\\a.ts" }),
      });

      expect(received.some((m) => m.type === "verdict")).toBe(false);
    });

    test("a sensitive path is never auto-approved, even for an allow-listed tool", async () => {
      const { received } = await runPermissionRequest({
        extraAllow: ["Write"],
        toolName: "Write",
        inputPreview: JSON.stringify({ file_path: "~/.ssh/authorized_keys" }),
      });

      expect(received.some((m) => m.type === "verdict")).toBe(false);
    });

    test("with no stateDir configured it falls through to a normal card, same as the Bash shortcut", async () => {
      const { received } = await runPermissionRequest({
        extraAllow: ["Write"],
        toolName: "Write",
        inputPreview: JSON.stringify({ file_path: "c:\\data\\worktrees\\x\\notes.txt" }),
        withStateDir: false,
      });

      expect(received.some((m) => m.type === "verdict")).toBe(false);
    });
  });

  // §13 check 4, found live 2026-08-06: the §6.5 terminal-answer heuristic can call
  // finalizePermissionMessage under a second after the card's own sendMessage, and the real
  // Telegram Bot API intermittently 400s that fast an edit with "message to edit not found"
  // (reproduced 2/2 live runs) - the same class of fresh-object flakiness §4.5.2/0.69.0 already
  // document for topics. finalizePermissionMessage retries on that specific error rather than
  // giving up on the first loss.
  describe("finalizePermissionMessage retry (§13 check 4)", () => {
    test("retries past a transient 'message to edit not found' and succeeds", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      let attempts = 0;
      const controlBot: SendMessageSource = {
        sendMessage: async () => ({ message_id: 9 }),
        editMessageText: async () => {
          attempts++;
          if (attempts < 3) throw new Error("Telegram editMessageText failed: Bad Request: message to edit not found");
        },
      };

      const handle = startPipeServer({ pipePath: path, routing, controlBot, chatId: "-1" });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      await handle.finalizePermissionMessage(9, "✅ Allowed: Write (answered at terminal)");
      expect(attempts).toBe(3);
    });

    test("gives up and rethrows a non-transient editMessageText error immediately", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      let attempts = 0;
      const controlBot: SendMessageSource = {
        sendMessage: async () => ({ message_id: 9 }),
        editMessageText: async () => {
          attempts++;
          throw new Error("Telegram editMessageText failed: Bad Request: chat not found");
        },
      };

      const handle = startPipeServer({ pipePath: path, routing, controlBot, chatId: "-1" });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      await expect(handle.finalizePermissionMessage(9, "text")).rejects.toThrow(/chat not found/);
      expect(attempts).toBe(1);
    });
  });

  describe("sendInbound", () => {
    test("delivers to the connected channel server for that slug", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });

      const handle = startPipeServer({ pipePath: path, routing, controlBot: noopControlBot, chatId: "-1" });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const { socket, received } = connectClient(path);
      await waitFor(() => socket.readyState === "open");
      socket.write(
        encodeMessage({ v: PROTOCOL_VERSION, type: "hello", role: "channel", slug: "test-session", pid: 1 } satisfies HelloFromChannel),
      );
      await waitFor(() => received.length >= 1); // hello_ack

      const ok = handle.sendInbound("test-session", "hello from telegram", {
        topic_id: "3",
        msg_id: "42",
        from: "oleg",
        seq: 1,
      });
      expect(ok).toBe(true);

      await waitFor(() => received.length >= 2);
      expect(received[1]).toMatchObject({
        type: "inbound",
        content: "hello from telegram",
        meta: { topic_id: "3", msg_id: "42", from: "oleg", seq: 1 },
      });
    });

    test("returns false and drops the message when no channel server is connected for that slug", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });

      const handle = startPipeServer({ pipePath: path, routing, controlBot: noopControlBot, chatId: "-1" });
      servers.push(handle.server);
      await waitFor(() => handle.server.listening);

      const ok = handle.sendInbound("test-session", "nobody home", { topic_id: "3", msg_id: "1", from: "x", seq: 1 });
      expect(ok).toBe(false);
    });
  });
});

describe("send_file", () => {
  function makeControlBot() {
    const photoCalls: Array<{ chatId: string | number; threadId?: number; filename: string; bytes: Uint8Array; caption?: string }> = [];
    const documentCalls: Array<{ chatId: string | number; threadId?: number; filename: string; bytes: Uint8Array; caption?: string }> = [];
    const controlBot: SendMessageSource = {
      sendMessage: async () => ({ message_id: 1 }),
      sendPhotoFile: async (chatId, threadId, filename, bytes, caption) => {
        photoCalls.push({ chatId, threadId, filename, bytes, caption });
        return { message_id: 2 };
      },
      sendDocumentFile: async (chatId, threadId, filename, bytes, caption) => {
        documentCalls.push({ chatId, threadId, filename, bytes, caption });
        return { message_id: 3 };
      },
    };
    return { controlBot, photoCalls, documentCalls };
  }

  test("a path inside the session's outbox is sent as a photo (image extension)", async () => {
    const path_ = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const { controlBot, photoCalls } = makeControlBot();
    const stateDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "aibridge-pipe-outbox-"));
    const outbox = ensureOutboxDir(stateDir, "test-session");
    const filePath = path.join(outbox, "shot.png");
    await fsPromises.writeFile(filePath, Buffer.from([1, 2, 3]));

    const handle = startPipeServer({ pipePath: path_, routing, controlBot, chatId: "-1", stateDir });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path_);
    await waitFor(() => socket.readyState === "open");
    socket.write(
      encodeMessage({
        v: PROTOCOL_VERSION,
        type: "send_file",
        slug: "test-session",
        topic_id: "3",
        path: filePath,
        caption: "what does this look like?",
      }),
    );

    await waitFor(() => photoCalls.length >= 1);
    expect(photoCalls[0]).toMatchObject({ chatId: "-1", threadId: 3, filename: "shot.png", caption: "what does this look like?" });
  });

  test("a non-image extension is sent as a document instead", async () => {
    const path_ = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const { controlBot, documentCalls } = makeControlBot();
    const stateDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "aibridge-pipe-outbox-"));
    const outbox = ensureOutboxDir(stateDir, "test-session");
    const filePath = path.join(outbox, "report.pdf");
    await fsPromises.writeFile(filePath, Buffer.from([9]));

    const handle = startPipeServer({ pipePath: path_, routing, controlBot, chatId: "-1", stateDir });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path_);
    await waitFor(() => socket.readyState === "open");
    socket.write(
      encodeMessage({ v: PROTOCOL_VERSION, type: "send_file", slug: "test-session", topic_id: "3", path: filePath }),
    );

    await waitFor(() => documentCalls.length >= 1);
    expect(documentCalls[0]).toMatchObject({ filename: "report.pdf" });
  });

  test("a path outside the session's outbox is silently dropped, never read or sent", async () => {
    const path_ = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const { controlBot, photoCalls, documentCalls } = makeControlBot();
    const stateDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "aibridge-pipe-outbox-"));

    const handle = startPipeServer({ pipePath: path_, routing, controlBot, chatId: "-1", stateDir });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path_);
    await waitFor(() => socket.readyState === "open");
    socket.write(
      encodeMessage({
        v: PROTOCOL_VERSION,
        type: "send_file",
        slug: "test-session",
        topic_id: "3",
        path: "C:\\Users\\operator\\.ssh\\id_rsa",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(photoCalls.length).toBe(0);
    expect(documentCalls.length).toBe(0);
  });

  test("send_file with no stateDir configured is dropped, not thrown", async () => {
    const path_ = pipePath();
    const routing = new Routing();
    routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
    const { controlBot, photoCalls, documentCalls } = makeControlBot();

    const handle = startPipeServer({ pipePath: path_, routing, controlBot, chatId: "-1" });
    servers.push(handle.server);
    await waitFor(() => handle.server.listening);

    const { socket } = connectClient(path_);
    await waitFor(() => socket.readyState === "open");
    socket.write(
      encodeMessage({ v: PROTOCOL_VERSION, type: "send_file", slug: "test-session", topic_id: "3", path: "C:\\anything.png" }),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(photoCalls.length).toBe(0);
    expect(documentCalls.length).toBe(0);
  });
});
