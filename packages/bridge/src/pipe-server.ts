import net from "node:net";
import { DEFAULT_PIPE_PATH, encodeMessage, NdjsonDecoder, PROTOCOL_VERSION } from "@aibridge/protocol";
import type {
  ChannelMetaFields,
  HelloAck,
  HookEventMessage,
  InboundMessage,
  Message,
  PermissionRequestMessage,
  ReplyMessage,
  VerdictBehavior,
  VerdictMessage,
} from "@aibridge/protocol";
import { buildPermissionKeyboard, renderPermissionCard } from "./permission-callback.ts";
import { PermissionRegistry, type PendingPermissionRequest } from "./permission-registry.ts";
import type { ThinkingPlaceholder } from "./thinking-placeholder.ts";
import type { Routing } from "./routing.ts";
import type { SendMessageSource } from "./telegram.ts";

export { DEFAULT_PIPE_PATH };

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

export interface PipeServerOptions {
  pipePath?: string;
  routing: Routing;
  controlBot: SendMessageSource;
  /** The one supergroup chat every session's topics live in (§4.1). */
  chatId: string;
  /** If a "🤔 Thinking..." placeholder is pending for this topic, the reply edits it in place
   * instead of sending a second message (see `thinking-placeholder.ts`). */
  thinkingPlaceholder?: ThinkingPlaceholder;
  /** Fires after a `reply` is successfully delivered - the typing indicator's stop signal (§5's
   * feed doesn't exist yet, but "a reply landed" is already known here regardless). */
  onReplySent?: (topicId: string) => void;
  /** §5.1: every hook firing forwards one `event` message here. The hook client is a one-shot
   * process (a fresh connection per firing, no persistent registration to track), so this is the
   * only wiring needed on this side - there is no per-hook `hello_ack` to send back. */
  onHookEvent?: (msg: HookEventMessage) => void;
  log?: LogFn;
}

export interface PipeServerHandle {
  server: net.Server;
  /** Pushes an `inbound` message to the connected channel server for `slug`, if any. Returns
   * whether a connection was found to send it to. */
  sendInbound(slug: string, content: string, meta: ChannelMetaFields): boolean;
  /** Pushes a `verdict` to the connected channel server for `slug`. Returns whether a connection
   * was found to send it to (§6.3's round trip - the channel server relays this on to Claude). */
  sendVerdict(slug: string, requestId: string, behavior: VerdictBehavior): boolean;
  /** Resolves (and removes) a pending permission request by id - undefined for unknown or expired
   * ids (§9 scenarios 6-7), never throws. */
  resolvePermission(requestId: string): PendingPermissionRequest | undefined;
  /** Edits a permission card in place once resolved, stripping its keyboard (§6.5). */
  finalizePermissionMessage(messageId: number, text: string): Promise<void>;
  /** The registry itself, exposed for the expiry sweep (§6.5: strip + mark "expired" past 30min). */
  permissionRegistry: PermissionRegistry;
}

/**
 * Bridge side of the §2.5 socket protocol. Handles `hello` (idempotent re-registration by slug)
 * and `reply` (forward to the control bot in the session's topic); anything else is logged and
 * ignored rather than dropping the connection (§9 scenario 34 - version-skew tolerance).
 */
export function startPipeServer(opts: PipeServerOptions): PipeServerHandle {
  const pipePath = opts.pipePath ?? DEFAULT_PIPE_PATH;
  const log = opts.log ?? (() => {});
  const connectionsBySlug = new Map<string, net.Socket>();
  const permissionRegistry = new PermissionRegistry();

  async function handleReply(msg: ReplyMessage): Promise<void> {
    try {
      const placeholderId = await opts.thinkingPlaceholder?.consume(msg.topic_id);
      if (placeholderId !== undefined && opts.controlBot.editMessageText) {
        await opts.controlBot.editMessageText(opts.chatId, placeholderId, msg.text);
      } else {
        await opts.controlBot.sendMessage(opts.chatId, Number(msg.topic_id), msg.text);
      }
      opts.onReplySent?.(msg.topic_id);
    } catch (err) {
      log("ERROR", `failed to deliver reply for slug "${msg.slug}": ${(err as Error).message}`);
    }
  }

  /**
   * §6.3's relay: post an inline-keyboard card and register it as pending. The card renders from
   * this notification's own fields alone (§6.5 - no join against a hook payload), and a post
   * failure (e.g. Telegram briefly unreachable) leaves nothing registered rather than a pending
   * entry with no way for the operator to ever see or answer it.
   */
  async function handlePermissionRequest(msg: PermissionRequestMessage): Promise<void> {
    const route = opts.routing.get(msg.slug);
    if (!route) {
      log("WARN", `permission_request for unknown slug "${msg.slug}" - dropped`);
      return;
    }
    try {
      const text = renderPermissionCard({
        slug: msg.slug,
        toolName: msg.tool_name,
        description: msg.description,
        inputPreview: msg.input_preview,
      });
      const sent = await opts.controlBot.sendMessage(opts.chatId, route.topicId, text, {
        inline_keyboard: buildPermissionKeyboard(msg.request_id),
      });
      permissionRegistry.add({
        requestId: msg.request_id,
        slug: msg.slug,
        toolName: msg.tool_name,
        description: msg.description,
        inputPreview: msg.input_preview,
        topicId: route.topicId,
        messageId: sent.message_id,
      });
    } catch (err) {
      log("ERROR", `failed to post permission request for slug "${msg.slug}": ${(err as Error).message}`);
    }
  }

  function handleHello(msg: Extract<Message, { type: "hello" }>, socket: net.Socket): void {
    if (msg.role !== "channel") {
      // §5.1: the hook client's hello carries no session_id (only pid + which event it's for),
      // so there is nothing to register here - the event message on the same connection, handled
      // below, is the one that actually carries anything routable.
      log("INFO", `hook client connected for event "${msg.event}" (pid ${msg.pid})`);
      return;
    }
    connectionsBySlug.set(msg.slug, socket);
    log("INFO", `channel server for "${msg.slug}" connected (pid ${msg.pid})`);

    const route = opts.routing.get(msg.slug);
    const ack: HelloAck = {
      v: PROTOCOL_VERSION,
      type: "hello_ack",
      slug: msg.slug,
      re: msg.id,
      topic_id: route?.topicId ?? -1,
      session_state: route ? "idle" : "unknown",
    };
    socket.write(encodeMessage(ack));
  }

  function handleMessage(msg: Message, socket: net.Socket): void {
    switch (msg.type) {
      case "hello":
        handleHello(msg, socket);
        return;
      case "reply":
        void handleReply(msg);
        return;
      case "permission_request":
        void handlePermissionRequest(msg);
        return;
      case "event":
        opts.onHookEvent?.(msg);
        return;
      default:
        log("WARN", `ignoring unrecognised message type "${(msg as { type?: unknown }).type}"`);
    }
  }

  const server = net.createServer((socket) => {
    const decoder = new NdjsonDecoder();

    socket.on("data", (chunk) => {
      let messages: Message[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        log("ERROR", `malformed message on pipe: ${(err as Error).message}`);
        return;
      }
      for (const msg of messages) {
        handleMessage(msg, socket);
      }
    });

    socket.on("error", (err) => {
      log("WARN", `pipe client socket error: ${(err as Error).message}`);
    });

    socket.on("close", () => {
      for (const [slug, s] of connectionsBySlug) {
        if (s === socket) connectionsBySlug.delete(slug);
      }
    });
  });

  server.on("error", (err) => {
    log("ERROR", `pipe server error: ${(err as Error).message}`);
  });

  server.listen(pipePath, () => {
    log("INFO", `pipe server listening on ${pipePath}`);
  });

  function sendInbound(slug: string, content: string, meta: ChannelMetaFields): boolean {
    const socket = connectionsBySlug.get(slug);
    if (!socket) {
      log("WARN", `no connected channel server for slug "${slug}" - inbound message dropped`);
      return false;
    }
    const msg: InboundMessage = { v: PROTOCOL_VERSION, type: "inbound", slug, content, meta };
    socket.write(encodeMessage(msg));
    return true;
  }

  function sendVerdict(slug: string, requestId: string, behavior: VerdictBehavior): boolean {
    const socket = connectionsBySlug.get(slug);
    if (!socket) {
      log("WARN", `no connected channel server for slug "${slug}" - verdict dropped`);
      return false;
    }
    const msg: VerdictMessage = { v: PROTOCOL_VERSION, type: "verdict", slug, request_id: requestId, behavior };
    socket.write(encodeMessage(msg));
    return true;
  }

  function resolvePermission(requestId: string): PendingPermissionRequest | undefined {
    return permissionRegistry.resolve(requestId);
  }

  async function finalizePermissionMessage(messageId: number, text: string): Promise<void> {
    if (!opts.controlBot.editMessageText) return;
    await opts.controlBot.editMessageText(opts.chatId, messageId, text, { inline_keyboard: [] });
  }

  return { server, sendInbound, sendVerdict, resolvePermission, finalizePermissionMessage, permissionRegistry };
}
