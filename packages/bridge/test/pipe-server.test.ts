import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { encodeMessage, NdjsonDecoder, PROTOCOL_VERSION } from "@aibridge/protocol";
import type { HelloFromChannel, Message, ReplyMessage } from "@aibridge/protocol";
import { startPipeServer } from "../src/pipe-server.ts";
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
