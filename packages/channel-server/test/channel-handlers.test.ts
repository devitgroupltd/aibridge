import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@aibridge/protocol";
import type { InboundMessage, Message, VerdictMessage } from "@aibridge/protocol";
import { createChannelHandlers } from "../src/channel-handlers.ts";

/** P1-8 (codebase-hardening-plan.md): `index.ts` itself is an entry-point script (throws on
 * import without env vars, connects a real MCP stdio transport and a real named-pipe client as
 * side effects) - untestable as-is. `channel-handlers.ts` was extracted specifically to make this
 * possible without changing behavior: these tests exercise the exact same request/notification
 * handling `index.ts` used to run inline, against fake `pipe`/`server`. */

function fakePipe() {
  const sent: Message[] = [];
  return { send: (msg: Message) => sent.push(msg), sent };
}

function fakeServer() {
  const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    notification: async (n: { method: string; params?: Record<string, unknown> }) => {
      notifications.push(n);
    },
    notifications,
  };
}

function setup() {
  const pipe = fakePipe();
  const server = fakeServer();
  const logs: Array<{ level: string; message: string }> = [];
  const handlers = createChannelHandlers({
    slug: "fix-bug",
    pipe,
    server,
    log: (level, message) => logs.push({ level, message }),
  });
  return { handlers, pipe, server, logs };
}

describe("createChannelHandlers", () => {
  describe("callTool", () => {
    test("reply sends a well-formed ReplyMessage over the pipe and confirms", async () => {
      const { handlers, pipe } = setup();
      const result = await handlers.callTool({ params: { name: "reply", arguments: { topic_id: "5", text: "hi" } } });
      expect(pipe.sent).toEqual([{ v: PROTOCOL_VERSION, type: "reply", slug: "fix-bug", topic_id: "5", text: "hi" }]);
      expect(result).toEqual({ content: [{ type: "text", text: "sent" }] });
    });

    test("reply with a missing field throws instead of sending a malformed message", async () => {
      const { handlers, pipe } = setup();
      await expect(handlers.callTool({ params: { name: "reply", arguments: { topic_id: "5" } } })).rejects.toThrow(
        /reply requires/,
      );
      expect(pipe.sent).toEqual([]);
    });

    test("send_file sends a well-formed SendFileMessage, caption included when given", async () => {
      const { handlers, pipe } = setup();
      await handlers.callTool({ params: { name: "send_file", arguments: { topic_id: "5", path: "/outbox/shot.png", caption: "screenshot" } } });
      expect(pipe.sent).toEqual([
        { v: PROTOCOL_VERSION, type: "send_file", slug: "fix-bug", topic_id: "5", path: "/outbox/shot.png", caption: "screenshot" },
      ]);
    });

    test("send_file omits caption entirely (not undefined) when none is given", async () => {
      const { handlers, pipe } = setup();
      await handlers.callTool({ params: { name: "send_file", arguments: { topic_id: "5", path: "/outbox/shot.png" } } });
      expect(pipe.sent[0]).not.toHaveProperty("caption");
    });

    test("send_file with a non-string caption throws", async () => {
      const { handlers } = setup();
      await expect(
        handlers.callTool({ params: { name: "send_file", arguments: { topic_id: "5", path: "/outbox/x", caption: 42 } } }),
      ).rejects.toThrow(/caption.*must be a string/);
    });

    test("an unknown tool name throws rather than silently no-oping", async () => {
      const { handlers } = setup();
      await expect(handlers.callTool({ params: { name: "bogus", arguments: {} } })).rejects.toThrow(/unknown tool "bogus"/);
    });
  });

  describe("forwardInbound", () => {
    test("notifies the server with the inbound content and its meta fields", async () => {
      const { handlers, server } = setup();
      const msg: InboundMessage = {
        v: PROTOCOL_VERSION,
        type: "inbound",
        slug: "fix-bug",
        content: "hello from the operator",
        meta: { topic_id: "5", msg_id: "1", from: "operator", seq: 1 },
      };
      await handlers.forwardInbound(msg);
      expect(server.notifications).toEqual([
        {
          method: "notifications/claude/channel",
          params: { content: "hello from the operator", meta: { topic_id: "5", msg_id: "1", from: "operator", seq: 1 } },
        },
      ]);
    });
  });

  describe("sendVerdictToClaude", () => {
    test("notifies the server with request_id and behavior for a valid verdict", async () => {
      const { handlers, server } = setup();
      const msg: VerdictMessage = { v: PROTOCOL_VERSION, type: "verdict", slug: "fix-bug", request_id: "req-1", behavior: "allow" };
      await handlers.sendVerdictToClaude(msg);
      expect(server.notifications).toEqual([
        { method: "notifications/claude/channel/permission", params: { request_id: "req-1", behavior: "allow" } },
      ]);
    });

    test("throws on an invalid behavior instead of forwarding it as-is (§9 scenario 4)", async () => {
      const { handlers, server } = setup();
      const msg = { v: PROTOCOL_VERSION, type: "verdict", slug: "fix-bug", request_id: "req-1", behavior: "maybe" } as unknown as VerdictMessage;
      await expect(handlers.sendVerdictToClaude(msg)).rejects.toThrow(/invalid verdict behavior/);
      expect(server.notifications).toEqual([]);
    });
  });

  describe("handleFromBridge", () => {
    test("routes an inbound message to forwardInbound", async () => {
      const { handlers, server } = setup();
      const msg: InboundMessage = {
        v: PROTOCOL_VERSION,
        type: "inbound",
        slug: "fix-bug",
        content: "hi",
        meta: { topic_id: "5", msg_id: "1", from: "operator", seq: 1 },
      };
      handlers.handleFromBridge(msg);
      await Promise.resolve();
      await Promise.resolve();
      expect(server.notifications.length).toBe(1);
    });

    test("routes a verdict message to sendVerdictToClaude", async () => {
      const { handlers, server } = setup();
      const msg: VerdictMessage = { v: PROTOCOL_VERSION, type: "verdict", slug: "fix-bug", request_id: "req-1", behavior: "deny" };
      handlers.handleFromBridge(msg);
      await Promise.resolve();
      await Promise.resolve();
      expect(server.notifications.length).toBe(1);
    });

    test("a hello_ack/ack message is a no-op - nothing thrown, nothing notified", () => {
      const { handlers, server } = setup();
      expect(() => handlers.handleFromBridge({ v: PROTOCOL_VERSION, type: "ack", slug: "fix-bug" })).not.toThrow();
      expect(server.notifications).toEqual([]);
    });

    test("a rejected forwardInbound is caught and logged, not thrown out of handleFromBridge", async () => {
      const pipe = fakePipe();
      const logs: Array<{ level: string; message: string }> = [];
      const handlers = createChannelHandlers({
        slug: "fix-bug",
        pipe,
        server: {
          notification: async () => {
            throw new Error("stdio pipe broke");
          },
        },
        log: (level, message) => logs.push({ level, message }),
      });
      const msg: InboundMessage = {
        v: PROTOCOL_VERSION,
        type: "inbound",
        slug: "fix-bug",
        content: "hi",
        meta: { topic_id: "5", msg_id: "1", from: "operator", seq: 1 },
      };
      expect(() => handlers.handleFromBridge(msg)).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      expect(logs.some((l) => l.level === "ERROR" && l.message.includes("stdio pipe broke"))).toBe(true);
    });
  });

  describe("handlePermissionRequestNotification", () => {
    test("a well-formed permission_request is forwarded to the Bridge over the pipe", async () => {
      const { handlers, pipe } = setup();
      await handlers.handlePermissionRequestNotification({
        method: "notifications/claude/channel/permission_request",
        params: { request_id: "req-1", tool_name: "Write", description: "Write to file.ts", input_preview: "..." },
      });
      expect(pipe.sent).toEqual([
        {
          v: PROTOCOL_VERSION,
          type: "permission_request",
          slug: "fix-bug",
          request_id: "req-1",
          tool_name: "Write",
          description: "Write to file.ts",
          input_preview: "...",
        },
      ]);
    });

    test("an unrecognised notification method logs a WARN and forwards nothing", async () => {
      const { handlers, pipe, logs } = setup();
      await handlers.handlePermissionRequestNotification({ method: "notifications/something/else" });
      expect(pipe.sent).toEqual([]);
      expect(logs.some((l) => l.level === "WARN")).toBe(true);
    });

    test("a malformed permission_request (missing field) logs an ERROR and forwards nothing", async () => {
      const { handlers, pipe, logs } = setup();
      await handlers.handlePermissionRequestNotification({
        method: "notifications/claude/channel/permission_request",
        params: { request_id: "req-1", tool_name: "Write" /* missing description/input_preview */ },
      });
      expect(pipe.sent).toEqual([]);
      expect(logs.some((l) => l.level === "ERROR")).toBe(true);
    });
  });
});
