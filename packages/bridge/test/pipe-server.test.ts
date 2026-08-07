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
    test("a reply edits the pending placeholder instead of sending a second message", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const sent: Array<{ text: string }> = [];
      const edited: Array<{ messageId: number; text: string }> = [];
      const controlBot: SendMessageSource = {
        sendMessage: async (_chatId, _threadId, text) => {
          sent.push({ text });
          return { message_id: 99 };
        },
        editMessageText: async (_chatId, messageId, text) => {
          edited.push({ messageId, text });
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

      await waitFor(() => edited.length >= 1);
      expect(edited).toEqual([{ messageId: 55, text: "the answer" }]);
      expect(sent).toEqual([]); // no second, separate message
    });

    test("falls back to sendMessage when no placeholder is pending for that topic", async () => {
      const path = pipePath();
      const routing = new Routing();
      routing.add({ slug: "test-session", topicId: 3, worktreePath: "x" });
      const sent: Array<{ text: string }> = [];
      const controlBot: SendMessageSource = {
        sendMessage: async (_chatId, _threadId, text) => {
          sent.push({ text });
          return { message_id: 1 };
        },
        editMessageText: async () => {
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
