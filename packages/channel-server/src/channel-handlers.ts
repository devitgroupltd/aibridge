import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { assertValidBehavior, buildMeta, PROTOCOL_VERSION } from "@aibridge/protocol";
import type { InboundMessage, Message, PermissionRequestMessage, ReplyMessage, SendFileMessage, VerdictMessage } from "@aibridge/protocol";

/**
 * P1-8 (codebase-hardening-plan.md): extracted from `index.ts` so this module's request/notification
 * handling is unit-testable at all - `index.ts` itself is a top-level entry-point script (throws on
 * import if its slug env var is missing, connects a real MCP stdio transport and a real named-pipe
 * client as side effects of being imported), which is exactly what made it untestable before this
 * split. Behavior-identical to what `index.ts` used to do inline; only the construction is different
 * (`pipe`/`server`/`log` injected here instead of module-level singletons).
 */

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

/** The only two `pipe-client.ts`/MCP-SDK `Server` members this module actually calls - narrowed to
 * exactly that surface (Interface Segregation) so tests can fake both without pulling in a real
 * socket connection or a real stdio transport. */
export interface OutboundPipe {
  send(msg: Message): void;
}
export interface NotifyingServer {
  notification(n: { method: string; params?: Record<string, unknown> }): Promise<void>;
}

export interface ChannelHandlersOptions {
  slug: string;
  pipe: OutboundPipe;
  server: NotifyingServer;
  log: LogFn;
}

export interface ToolCallRequest {
  params: { name: string; arguments?: Record<string, unknown> };
}

export interface ChannelHandlers {
  /** `reply`/`send_file` - Claude Code calling a tool. Throws on a malformed argument shape (the
   * MCP SDK surfaces a thrown error back to the caller as a tool-call failure); never throws for
   * an unrelated reason (delivery itself is fire-and-forget via `pipe.send`, same as `index.ts`
   * always did). */
  callTool(request: ToolCallRequest): Promise<CallToolResult>;
  /** §3.3: forwards a Bridge-originated inbound turn to Claude Code as a notification. */
  forwardInbound(msg: InboundMessage): Promise<void>;
  /** §6.3's send-side: relays a Bridge verdict back to Claude Code, closing the local permission
   * dialog. Throws if `msg.behavior` isn't a recognised value (§9 scenario 4) - a typo or a future
   * third state must fail loudly here rather than get forwarded as-is. */
  sendVerdictToClaude(msg: VerdictMessage): Promise<void>;
  /** Routes a message received from the Bridge over the pipe to the right handler above. Never
   * throws synchronously - `forwardInbound`/`sendVerdictToClaude` failures are caught and logged,
   * not propagated, since there is no caller on this side to hand a rejection to. */
  handleFromBridge(msg: Message): void;
  /** §6.3's receive-side: Claude Code emits this notification (not a request) when a gated tool
   * call raises a local permission prompt. Forwarded to the Bridge verbatim; logs and returns
   * (does not throw) on an unrecognised method or a malformed payload, since this is the MCP SDK's
   * fallback notification handler - there is no request to fail. */
  handlePermissionRequestNotification(notification: { method: string; params?: unknown }): Promise<void>;
}

export function createChannelHandlers(opts: ChannelHandlersOptions): ChannelHandlers {
  const { slug, pipe, server, log } = opts;

  async function callTool(request: ToolCallRequest): Promise<CallToolResult> {
    const args = request.params.arguments;

    if (request.params.name === "reply") {
      if (typeof args?.topic_id !== "string" || typeof args?.text !== "string") {
        throw new Error("reply requires { topic_id: string, text: string }");
      }
      // §3.3: forwarding to the Bridge is independent of the pipe's own connection state - if
      // disconnected, PipeClient queues it (reply is priority) rather than dropping it.
      const msg: ReplyMessage = {
        v: PROTOCOL_VERSION,
        type: "reply",
        slug,
        topic_id: args.topic_id,
        text: args.text,
      };
      pipe.send(msg);
      return { content: [{ type: "text", text: "sent" }] };
    }

    if (request.params.name === "send_file") {
      if (typeof args?.topic_id !== "string" || typeof args?.path !== "string") {
        throw new Error("send_file requires { topic_id: string, path: string, caption?: string }");
      }
      if (args.caption !== undefined && typeof args.caption !== "string") {
        throw new Error("send_file's caption, if given, must be a string");
      }
      // §5.8: the Bridge re-validates `path` against this session's own outbox - the channel server
      // never decides that on its own, it only forwards what Claude asked for.
      const msg: SendFileMessage = {
        v: PROTOCOL_VERSION,
        type: "send_file",
        slug,
        topic_id: args.topic_id,
        path: args.path,
        ...(args.caption !== undefined ? { caption: args.caption as string } : {}),
      };
      pipe.send(msg);
      return { content: [{ type: "text", text: "sent" }] };
    }

    throw new Error(`unknown tool "${request.params.name}"`);
  }

  async function forwardInbound(msg: InboundMessage): Promise<void> {
    const meta = buildMeta(msg.meta);
    log("INFO", `forwarding inbound to Claude via notification: content=${JSON.stringify(msg.content)} meta=${JSON.stringify(meta)}`);
    await server.notification({
      method: "notifications/claude/channel",
      params: { content: msg.content, meta },
    });
    log("INFO", "server.notification() resolved without error");
  }

  async function sendVerdictToClaude(msg: VerdictMessage): Promise<void> {
    assertValidBehavior(msg.behavior);
    await server.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id: msg.request_id, behavior: msg.behavior },
    });
    log("INFO", `sent verdict for request_id=${msg.request_id}: ${msg.behavior}`);
  }

  function handleFromBridge(msg: Message): void {
    log("INFO", `received from Bridge: type=${msg.type}`);
    if (msg.type === "inbound") {
      forwardInbound(msg).catch((err) => {
        log("ERROR", `failed to deliver inbound notification: ${(err as Error).message}`);
      });
    } else if (msg.type === "verdict") {
      sendVerdictToClaude(msg).catch((err) => {
        log("ERROR", `failed to deliver verdict: ${(err as Error).message}`);
      });
    }
    // hello_ack / ack: nothing to do with these.
  }

  async function handlePermissionRequestNotification(notification: { method: string; params?: unknown }): Promise<void> {
    if (notification.method !== "notifications/claude/channel/permission_request") {
      log("WARN", `unhandled notification from Claude Code: ${notification.method}`);
      return;
    }
    const params = notification.params as
      | { request_id?: unknown; tool_name?: unknown; description?: unknown; input_preview?: unknown }
      | undefined;
    if (
      typeof params?.request_id !== "string" ||
      typeof params.tool_name !== "string" ||
      typeof params.description !== "string" ||
      typeof params.input_preview !== "string"
    ) {
      log("ERROR", `malformed permission_request notification: ${JSON.stringify(notification)}`);
      return;
    }
    const msg: PermissionRequestMessage = {
      v: PROTOCOL_VERSION,
      type: "permission_request",
      slug,
      request_id: params.request_id,
      tool_name: params.tool_name,
      description: params.description,
      input_preview: params.input_preview,
    };
    log("INFO", `forwarding permission_request ${params.request_id} (${params.tool_name}) to Bridge`);
    pipe.send(msg);
  }

  return { callTool, forwardInbound, sendVerdictToClaude, handleFromBridge, handlePermissionRequestNotification };
}
