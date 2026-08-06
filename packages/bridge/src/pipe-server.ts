import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { DEFAULT_PIPE_PATH, encodeMessage, NdjsonDecoder, PROTOCOL_VERSION } from "@aibridge/protocol";
import type {
  ChannelMetaFields,
  HelloAck,
  HookAskMessage,
  HookEventMessage,
  InboundMessage,
  Message,
  PermissionRequestMessage,
  ReplyMessage,
  SendFileMessage,
  VerdictBehavior,
  VerdictMessage,
} from "@aibridge/protocol";
import { buildAskKeyboard, renderAskCard } from "./ask-callback.ts";
import { AskRegistry, type PendingAsk } from "./ask-registry.ts";
import { isImagePath, resolveOutboxPath } from "./outbox.ts";
import { buildPermissionKeyboard, renderPermissionCard } from "./permission-callback.ts";
import { PermissionRegistry, type PendingPermissionRequest } from "./permission-registry.ts";
import type { RateGovernor } from "./rate-governor.ts";
import { scrubSecrets } from "./secret-scrub.ts";
import type { ThinkingPlaceholder } from "./thinking-placeholder.ts";
import type { Routing } from "./routing.ts";
import type { SendMessageSource } from "./telegram.ts";

export { DEFAULT_PIPE_PATH };

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

export interface PipeServerOptions {
  pipePath?: string;
  routing: Routing;
  controlBot: SendMessageSource;
  /** §5.4's P0 lane: permission/question cards, their resolutions and callback acks - never
   * dropped, never delayed by the feed bot's P2 traffic. Optional so existing stub-server tests
   * that construct `PipeServerOptions` without a governor keep working unchanged (falls back to
   * calling `controlBot` directly, the pre-governor behaviour). */
  governor?: RateGovernor;
  /** The one supergroup chat every session's topics live in (§4.1). */
  chatId: string;
  /** §5.8: root for `outbox.ts`'s `resolveOutboxPath` - every `send_file` path is checked against
   * `<stateDir>/sessions/<slug>/outbox/` before anything is read off disk. Optional so existing
   * tests that never exercise `send_file` don't need to supply one; a `send_file` arriving with no
   * `stateDir` configured is logged and dropped rather than defaulting to something guessed. */
  stateDir?: string;
  /** If a "🤔 Thinking..." placeholder is pending for this topic, the reply edits it in place
   * instead of sending a second message (see `thinking-placeholder.ts`). */
  thinkingPlaceholder?: ThinkingPlaceholder;
  /** Fires after a `reply` is successfully delivered - the typing indicator's stop signal (§5's
   * feed doesn't exist yet, but "a reply landed" is already known here regardless). The reply text
   * is passed through too so a caller can drive §4.4's rename-once off the session's first reply
   * without this module needing to know anything about topics or the routing table. */
  onReplySent?: (topicId: string, text: string) => void;
  /** §5.1: every hook firing forwards one `event` message here. The hook client is a one-shot
   * process (a fresh connection per firing, no persistent registration to track), so this is the
   * only wiring needed on this side - there is no per-hook `hello_ack` to send back. */
  onHookEvent?: (msg: HookEventMessage) => void;
  /** §4.3: a freshly-posted permission/question card moves the session's tracked state to
   * `awaiting_input`. Not fired on an ask reconnect rebind (the question was already pending). */
  onAwaitingInput?: (slug: string) => void;
  /** Fires once the channel server (Claude Code's own MCP client for this session) registers
   * itself via `hello` - the deterministic signal that its MCP handshake has actually completed,
   * used by `index.ts` to know when it's finally safe to write a session's first inbound message
   * without racing that handshake (confirmed live 2026-08-04: a fixed delay guessed at this was
   * unreliable - this event is what replaced it). */
  onChannelConnected?: (slug: string) => void;
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
  /** Edits a permission card in place once resolved, stripping its keyboard (§6.5). Reused
   * verbatim for ask cards too - the edit itself has nothing permission-specific about it. */
  finalizePermissionMessage(messageId: number, text: string): Promise<void>;
  /** The registry itself, exposed for the expiry sweep (§6.5: strip + mark "expired" past 30min). */
  permissionRegistry: PermissionRegistry;
  /** §6.4: records a button tap against a pending question - null for an unknown id/index or a
   * question already answered (a stale or duplicate tap, same discipline as `resolvePermission`). */
  answerAsk(id: string, questionIndex: number, optionIndex: number): { entry: PendingAsk; label: string; allAnswered: boolean } | null;
  /** Sends the full `answers` map back to the blocked hook and forgets this ask. Returns whether
   * a live connection was found to send it on (the hook may have already timed out locally). */
  completeAsk(id: string): boolean;
  /** Sends `{ cancel: true }` back to the blocked hook (§6.4's 3540s ceiling) and forgets this ask. */
  cancelAsk(id: string): boolean;
  askRegistry: AskRegistry;
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
  const askRegistry = new AskRegistry();
  // Keyed by `request_id` (the tool's own `tool_use_id`, §6.4) rather than slug - a blocked ask
  // holds its own connection open for up to an hour, entirely separate from the channel server's
  // connection for the same slug.
  const askSocketsById = new Map<string, net.Socket>();

  // §5.4's two control-bot lanes. Both fall back to calling `controlBot` directly when no
  // governor is supplied (existing stub-server tests), so this is additive rather than a
  // behaviour change for anything that doesn't opt in.
  function p0<T>(fn: () => Promise<T>): Promise<T> {
    return opts.governor ? opts.governor.scheduleAsync("P0", fn) : fn();
  }
  function p1<T>(fn: () => Promise<T>): Promise<T> {
    return opts.governor ? opts.governor.scheduleAsync("P1", fn) : fn();
  }

  async function handleReply(msg: ReplyMessage): Promise<void> {
    try {
      // Last-line-of-defence, not a substitute for §6.2's Read/Edit deny rules: those stop Claude's
      // own tools from opening a secret file, but a subprocess the session wrote can still read one
      // and quote it back here. Every reply passes through this chokepoint regardless of how its
      // text was produced, so it's the one place that actually catches that gap (secret-scrub.ts).
      const { text, triggered } = scrubSecrets(msg.text);
      if (triggered.length > 0) {
        log("WARN", `redacted ${triggered.join(", ")} from a reply for slug "${msg.slug}" before sending to Telegram`);
      }
      const placeholderId = await opts.thinkingPlaceholder?.consume(msg.topic_id);
      if (placeholderId !== undefined && opts.controlBot.editMessageText) {
        await p1(() => opts.controlBot.editMessageText!(opts.chatId, placeholderId, text));
      } else {
        await p1(() => opts.controlBot.sendMessage(opts.chatId, Number(msg.topic_id), text));
      }
      opts.onReplySent?.(msg.topic_id, text);
    } catch (err) {
      log("ERROR", `failed to deliver reply for slug "${msg.slug}": ${(err as Error).message}`);
    }
  }

  /**
   * §5.8: forwards a file Claude saved in its own outbox to Telegram, as a photo if the
   * extension is one `sendPhoto` renders inline, a document otherwise. Every failure mode here
   * (no `stateDir` configured, path outside the outbox, file missing, bot methods unavailable) is
   * logged and dropped rather than thrown - `send_file` has no caller waiting on a result the way
   * a tool call normally would (the MCP response was already returned "sent" by the channel
   * server before the Bridge ever sees this).
   */
  async function handleSendFile(msg: SendFileMessage): Promise<void> {
    if (!opts.stateDir) {
      log("WARN", `send_file for slug "${msg.slug}" dropped - no stateDir configured`);
      return;
    }
    const resolved = resolveOutboxPath(opts.stateDir, msg.slug, msg.path);
    if (!resolved) {
      log("WARN", `send_file for slug "${msg.slug}" rejected - "${msg.path}" is outside its outbox`);
      return;
    }
    if (!existsSync(resolved)) {
      log("WARN", `send_file for slug "${msg.slug}" rejected - "${resolved}" does not exist`);
      return;
    }
    try {
      const bytes = readFileSync(resolved);
      const filename = path.basename(resolved);
      const asPhoto = isImagePath(filename);
      // The caption is free text Claude supplies, same as a reply - scrub it the same way (the
      // file's own bytes are unaffected; this repo has no equivalent scanner for file contents,
      // which is exactly the kind of gap §8.3 already tracks rather than something new).
      let caption = msg.caption;
      if (caption !== undefined) {
        const { text, triggered } = scrubSecrets(caption);
        caption = text;
        if (triggered.length > 0) {
          log("WARN", `redacted ${triggered.join(", ")} from a send_file caption for slug "${msg.slug}" before sending to Telegram`);
        }
      }
      if (asPhoto && opts.controlBot.sendPhotoFile) {
        await p1(() => opts.controlBot.sendPhotoFile!(opts.chatId, Number(msg.topic_id), filename, bytes, caption));
        log("INFO", `sent "${filename}" (${bytes.length} bytes) as a photo for slug "${msg.slug}"`);
      } else if (opts.controlBot.sendDocumentFile) {
        await p1(() => opts.controlBot.sendDocumentFile!(opts.chatId, Number(msg.topic_id), filename, bytes, caption));
        log("INFO", `sent "${filename}" (${bytes.length} bytes) as a document for slug "${msg.slug}"`);
      } else {
        log("WARN", `send_file for slug "${msg.slug}" dropped - control bot has no file-sending method`);
      }
    } catch (err) {
      log("ERROR", `failed to deliver send_file for slug "${msg.slug}": ${(err as Error).message}`);
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
      const sent = await p0(() =>
        opts.controlBot.sendMessage(opts.chatId, route.topicId, text, {
          inline_keyboard: buildPermissionKeyboard(msg.request_id),
        }),
      );
      permissionRegistry.add({
        requestId: msg.request_id,
        slug: msg.slug,
        toolName: msg.tool_name,
        description: msg.description,
        inputPreview: msg.input_preview,
        topicId: route.topicId,
        messageId: sent.message_id,
      });
      opts.onAwaitingInput?.(msg.slug);
    } catch (err) {
      log("ERROR", `failed to post permission request for slug "${msg.slug}": ${(err as Error).message}`);
    }
  }

  /**
   * §6.4: posts one card per question and registers the ask, keyed by `request_id` (the tool's
   * own `tool_use_id`) rather than a Bridge-invented id. A reconnect of the same blocked hook
   * invocation (§2.5 - the hook client re-sends `hello`+`ask` on every reconnect attempt) arrives
   * as a second `ask` with the same `request_id`; that case just rebinds the socket rather than
   * reposting the question, since the operator would otherwise see duplicate cards for one ask.
   */
  async function handleAsk(msg: HookAskMessage, socket: net.Socket): Promise<void> {
    const existing = askRegistry.get(msg.request_id);
    if (existing) {
      askSocketsById.set(msg.request_id, socket);
      return;
    }

    const route = opts.routing.get(msg.slug);
    if (!route) {
      log("WARN", `ask for unknown slug "${msg.slug}" - dropped`);
      return;
    }

    try {
      const questions: PendingAsk["questions"] = [];
      for (const q of msg.questions) {
        const sent = await p0(() =>
          opts.controlBot.sendMessage(opts.chatId, route.topicId, renderAskCard(msg.slug, q.question, q.header), {
            inline_keyboard: buildAskKeyboard(msg.request_id, questions.length, q.options),
          }),
        );
        questions.push({ question: q.question, header: q.header, options: q.options, topicId: route.topicId, messageId: sent.message_id });
      }
      askRegistry.add({ id: msg.request_id, slug: msg.slug, questions });
      askSocketsById.set(msg.request_id, socket);
      opts.onAwaitingInput?.(msg.slug);
    } catch (err) {
      log("ERROR", `failed to post question for slug "${msg.slug}": ${(err as Error).message}`);
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
    opts.onChannelConnected?.(msg.slug);

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
      case "send_file":
        void handleSendFile(msg);
        return;
      case "permission_request":
        void handlePermissionRequest(msg);
        return;
      case "event":
        opts.onHookEvent?.(msg);
        return;
      case "ask":
        void handleAsk(msg, socket);
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
      // Not removed from `askRegistry` here - only the socket goes away. The hook client
      // reconnects and re-sends the same `ask` (§2.5), which rebinds a fresh socket in
      // `handleAsk` above; the pending question itself is only ever cleared by an answer, a
      // cancel, or the expiry sweep.
      for (const [id, s] of askSocketsById) {
        if (s === socket) askSocketsById.delete(id);
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
    await p0(() => opts.controlBot.editMessageText!(opts.chatId, messageId, text, { inline_keyboard: [] }));
  }

  function answerAsk(id: string, questionIndex: number, optionIndex: number): { entry: PendingAsk; label: string; allAnswered: boolean } | null {
    return askRegistry.answer(id, questionIndex, optionIndex);
  }

  function completeAsk(id: string): boolean {
    const entry = askRegistry.get(id);
    if (!entry) return false;
    const answers = askRegistry.buildAnswers(entry);
    const socket = askSocketsById.get(id);
    askRegistry.remove(id);
    askSocketsById.delete(id);
    if (!socket) return false;
    socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "answer", slug: entry.slug, answers }));
    return true;
  }

  function cancelAsk(id: string): boolean {
    const entry = askRegistry.get(id);
    if (!entry) return false;
    const socket = askSocketsById.get(id);
    askRegistry.remove(id);
    askSocketsById.delete(id);
    if (!socket) return false;
    socket.write(encodeMessage({ v: PROTOCOL_VERSION, type: "answer", slug: entry.slug, cancel: true }));
    return true;
  }

  return {
    server,
    sendInbound,
    sendVerdict,
    resolvePermission,
    finalizePermissionMessage,
    permissionRegistry,
    answerAsk,
    completeAsk,
    cancelAsk,
    askRegistry,
  };
}
