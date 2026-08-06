import { RateLimitedError } from "./rate-governor.ts";

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  message_thread_id?: number;
  text?: string;
  from?: { id: number; username?: string; first_name?: string };
  /** Unix seconds (UTC), set by Telegram's servers when the message was sent - always present on
   * a real message, per the Bot API. §7.4's stale-inbound check (`stale-inbound.ts`) is the only
   * consumer so far. */
  date: number;
  /** Present on a voice note (recorded in Telegram's mic UI); a forwarded/uploaded audio file
   * arrives as `message.audio` instead - see below, now handled via attachment-inbox.ts rather
   * than transcription. */
  voice?: { file_id: string; duration: number };
  /** One entry per resolution Telegram generated for an inbound photo, smallest to largest - the
   * largest is what attachment-inbox.ts downloads. The caption (if any) travels on the message
   * itself, not per-size. */
  photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
  /** An inbound document (PDF, docx, ...) - forwarded/uploaded as a file rather than rendered as
   * a photo or played inline. */
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  /** A forwarded/uploaded video file (not a photo, not the round "video note" bubble below). */
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  /** A forwarded/uploaded audio file - distinct from `voice` (recorded in-app, transcribed). */
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  /** Telegram's round "video message" bubble - never carries a filename or mime type. */
  video_note?: { file_id: string; file_size?: number };
  /** §5.6: the one caption Telegram allows alongside a photo/document/video/audio in the same
   * message - never present alongside plain `text` or `voice`. */
  caption?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_thread_id?: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface UpdatesSource {
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
}

export interface GetMeSource {
  getMe(): Promise<{ id: number; username: string }>;
}

export interface SendMessageSource {
  sendMessage(
    chatId: string | number,
    messageThreadId: number | undefined,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    /** §5.3: only the feed card passes this - it renders `<code>`/`<b>` for the turn card, which
     * is exactly why feed-escape.ts's HTML-entity escaping is load-bearing there rather than
     * cosmetic. Every existing caller omits it and stays plain text, unaffected. */
    parseMode?: "HTML",
  ): Promise<{ message_id: number }>;
  /**
   * Optional: only needed by callers that edit a previously-sent message (the thinking
   * placeholder, the permission relay stripping a resolved request's keyboard, and the feed card).
   * Telegram only replaces/removes the existing keyboard when `reply_markup` is explicitly passed
   * on the edit - omitting it leaves whatever keyboard the message already had.
   */
  editMessageText?(
    chatId: string | number,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    parseMode?: "HTML",
  ): Promise<void>;
  /** Optional, same reason `editMessageText` is - nl-router.ts's "🤔 Thinking..." placeholder for
   * the router's own latency gap is removed outright rather than edited into a final state, since
   * there's no single "final text" that fits every outcome (a command's own reply, a confirm card,
   * or a forwarded turn's own fresh placeholder all follow as separate messages). */
  deleteMessage?(chatId: string | number, messageId: number): Promise<void>;
  /** §5.8: renders inline in the topic, unlike `sendDocumentFile` below. Optional for the same
   * reason `editMessageText` is - existing stub/test doubles that never exercise `send_file` stay
   * unaffected. */
  sendPhotoFile?(
    chatId: string | number,
    messageThreadId: number | undefined,
    filename: string,
    bytes: Uint8Array,
    caption?: string,
  ): Promise<{ message_id: number }>;
  /** §5.8: the `sendDocument` fallback for a file `sendPhotoFile` wouldn't render inline (anything
   * outside Telegram's own photo-format allowlist - see `outbox.ts`'s `isImagePath`). */
  sendDocumentFile?(
    chatId: string | number,
    messageThreadId: number | undefined,
    filename: string,
    bytes: Uint8Array,
    caption?: string,
  ): Promise<{ message_id: number }>;
}

export interface SendChatActionSource {
  sendChatAction(chatId: string | number, messageThreadId: number | undefined, action: string): Promise<void>;
}

export interface BotCommand {
  command: string;
  description: string;
}

/** `setMyCommands` - drives Telegram's own native "/" autocomplete popup. Scoped via `BotCommandScopeChat`
 * (a plain `chat_id`, no `message_thread_id`) because the Bot API has no forum-topic-level command
 * scope at all - registering here surfaces the full fleet+session list in every topic alike. */
export interface SetMyCommandsSource {
  setMyCommands(chatId: string | number, commands: readonly BotCommand[]): Promise<void>;
}

/** §4.4/§7.5's topic lifecycle: create at `/new`, rename once on the first real title, close on
 * `/kill`/`/pause`, delete on `/rm`. */
export interface ForumTopicSource {
  createForumTopic(chatId: string | number, name: string): Promise<{ message_thread_id: number }>;
  editForumTopic(chatId: string | number, messageThreadId: number, name: string): Promise<void>;
  closeForumTopic(chatId: string | number, messageThreadId: number): Promise<void>;
  deleteForumTopic(chatId: string | number, messageThreadId: number): Promise<void>;
}

async function parseTelegramResponse<T>(res: Response, method: string): Promise<T> {
  const body = (await res.json()) as {
    ok: boolean;
    result?: T;
    description?: string;
    parameters?: { retry_after?: number };
  };
  if (!body.ok) {
    // §5.4: "honour `retry_after` from the response body exactly" - a real 429 carries it under
    // `parameters.retry_after` seconds. `RateGovernor` is the only thing that knows what to do
    // with a `RateLimitedError`; every other failure (network, timeout, 5xx, a non-429 4xx) stays
    // a plain `Error` and falls into the governor's fixed 1s/2s/4s retry policy instead.
    if (res.status === 429) {
      throw new RateLimitedError(body.parameters?.retry_after ?? 1);
    }
    throw new Error(`Telegram ${method} failed: ${body.description ?? JSON.stringify(body)}`);
  }
  return body.result as T;
}

/**
 * Minimal Bot API client for one token. §12 P-2: the Bridge validates both tokens with `getMe`
 * at startup, before the poller registers or any session launches - see `validateTokens` below.
 */
export class TelegramClient implements UpdatesSource {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl = "https://api.telegram.org") {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  private url(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  async getMe(): Promise<{ id: number; username: string }> {
    const res = await fetch(this.url("getMe"));
    return parseTelegramResponse(res, "getMe");
  }

  async getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    const res = await fetch(this.url("getUpdates"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset, timeout: timeoutSec }),
    });
    return parseTelegramResponse(res, "getUpdates");
  }

  async sendMessage(
    chatId: string | number,
    messageThreadId: number | undefined,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    parseMode?: "HTML",
  ): Promise<{ message_id: number }> {
    const res = await fetch(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_thread_id: messageThreadId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
    });
    return parseTelegramResponse(res, "sendMessage");
  }

  /** Must be called for every `callback_query` update, or the tapped button spins forever on mobile. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const res = await fetch(this.url("answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
    });
    await parseTelegramResponse(res, "answerCallbackQuery");
  }

  async sendChatAction(
    chatId: string | number,
    messageThreadId: number | undefined,
    action: string,
  ): Promise<void> {
    const res = await fetch(this.url("sendChatAction"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId, action }),
    });
    await parseTelegramResponse(res, "sendChatAction");
  }

  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    parseMode?: "HTML",
  ): Promise<void> {
    const res = await fetch(this.url("editMessageText"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
    });
    await parseTelegramResponse(res, "editMessageText");
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<void> {
    const res = await fetch(this.url("deleteMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    await parseTelegramResponse(res, "deleteMessage");
  }

  /** §5.5: a `details` payload over Telegram's 4096-character message limit goes as a document
   * instead ("Diffs always go as documents; a diff rendered into a chat bubble on a phone is
   * unreadable and burns budget" - the same reasoning applies to an oversized activity log).
   * Multipart, unlike every other method here, since `sendDocument` takes a file rather than a
   * JSON body - plain `FormData`/`Blob` from the global `fetch` implementation, no extra dependency. */
  async sendDocument(
    chatId: string | number,
    messageThreadId: number | undefined,
    filename: string,
    content: string,
  ): Promise<{ message_id: number }> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (messageThreadId !== undefined) form.append("message_thread_id", String(messageThreadId));
    form.append("document", new Blob([content], { type: "text/plain" }), filename);
    const res = await fetch(this.url("sendDocument"), { method: "POST", body: form });
    return parseTelegramResponse(res, "sendDocument");
  }

  /** §5.8: an outbound screenshot/image, rendered inline in the topic - same multipart shape as
   * `sendDocument` above, just a different field name and endpoint. */
  async sendPhotoFile(
    chatId: string | number,
    messageThreadId: number | undefined,
    filename: string,
    bytes: Uint8Array,
    caption?: string,
  ): Promise<{ message_id: number }> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (messageThreadId !== undefined) form.append("message_thread_id", String(messageThreadId));
    if (caption) form.append("caption", caption);
    form.append("photo", new Blob([bytes]), filename);
    const res = await fetch(this.url("sendPhoto"), { method: "POST", body: form });
    return parseTelegramResponse(res, "sendPhoto");
  }

  /** §5.8: an outbound non-image file (or an image in a format Telegram's `sendPhoto` won't take) -
   * a raw-bytes sibling of `sendDocument`'s text-content overload above. */
  async sendDocumentFile(
    chatId: string | number,
    messageThreadId: number | undefined,
    filename: string,
    bytes: Uint8Array,
    caption?: string,
  ): Promise<{ message_id: number }> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (messageThreadId !== undefined) form.append("message_thread_id", String(messageThreadId));
    if (caption) form.append("caption", caption);
    form.append("document", new Blob([bytes]), filename);
    const res = await fetch(this.url("sendDocument"), { method: "POST", body: form });
    return parseTelegramResponse(res, "sendDocument");
  }

  /** Resolves a `file_id` (e.g. a voice note's) to a `file_path` for use with `downloadFile`. */
  async getFile(fileId: string): Promise<{ file_path: string }> {
    const res = await fetch(this.url("getFile"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    return parseTelegramResponse(res, "getFile");
  }

  /** Downloads the raw bytes from Telegram's file CDN - a plain GET against `/file/bot<token>/...`,
   * not one of the `/bot<token>/<method>` JSON RPC calls, so it does not go through
   * `parseTelegramResponse`. */
  async downloadFile(filePath: string): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/file/bot${this.token}/${filePath}`);
    if (!res.ok) {
      throw new Error(`Telegram file download failed: ${res.status} ${res.statusText}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async setMyCommands(chatId: string | number, commands: readonly BotCommand[]): Promise<void> {
    const res = await fetch(this.url("setMyCommands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands, scope: { type: "chat", chat_id: chatId } }),
    });
    await parseTelegramResponse(res, "setMyCommands");
  }

  async createForumTopic(chatId: string | number, name: string): Promise<{ message_thread_id: number }> {
    const res = await fetch(this.url("createForumTopic"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, name }),
    });
    return parseTelegramResponse(res, "createForumTopic");
  }

  async editForumTopic(chatId: string | number, messageThreadId: number, name: string): Promise<void> {
    const res = await fetch(this.url("editForumTopic"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId, name }),
    });
    await parseTelegramResponse(res, "editForumTopic");
  }

  async closeForumTopic(chatId: string | number, messageThreadId: number): Promise<void> {
    const res = await fetch(this.url("closeForumTopic"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId }),
    });
    await parseTelegramResponse(res, "closeForumTopic");
  }

  async deleteForumTopic(chatId: string | number, messageThreadId: number): Promise<void> {
    const res = await fetch(this.url("deleteForumTopic"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId }),
    });
    await parseTelegramResponse(res, "deleteForumTopic");
  }
}

/**
 * Refuses to start with a named error identifying which token failed, rather than surfacing a
 * bad token for the first time deep inside a live sendMessage (§12 P-2).
 */
export async function validateTokens(control: GetMeSource, feed: GetMeSource): Promise<void> {
  const [controlResult, feedResult] = await Promise.allSettled([control.getMe(), feed.getMe()]);
  if (controlResult.status === "rejected") {
    throw new Error(`CONTROL_BOT_TOKEN is invalid: ${controlResult.reason}`);
  }
  if (feedResult.status === "rejected") {
    throw new Error(`FEED_BOT_TOKEN is invalid: ${feedResult.reason}`);
  }
}

export interface PollLoopOptions {
  /** Telegram long-poll timeout in seconds. */
  timeoutSec?: number;
  /** Delay before retrying after a failed getUpdates call. */
  retryDelayMs?: number;
  /** Resume from a persisted offset instead of 0 (§4.5.1/§9). Telegram only forgets an update once
   * a *later* `getUpdates` call passes a higher offset - the offset bump on receipt only takes
   * effect on the *next* call, so a process that dies (crash or `/restart`) right after handling an
   * update, before making that next call, never actually told Telegram it was seen. Starting a
   * successor at 0 replays every update since the last clean round-trip - confirmed live
   * 2026-08-03: `/restart` reprocessed itself once immediately after its own successor booted,
   * posting a duplicate confirmation. Defaults to 0 - only a caller that persists the offset (via
   * `onOffsetChange`) has anything meaningful to resume from.
   */
  initialOffset?: number;
  /** Fires synchronously with the new offset the instant it's known - before `onUpdate` runs, not
   * after - so a caller that persists it (e.g. to disk) can do so ahead of any restart/exit that
   * update's own handling might trigger. Without this, the persistence race above isn't actually
   * closed even if a caller does pass `initialOffset`. */
  onOffsetChange?: (offset: number) => void;
  onUpdate: (update: TelegramUpdate) => void;
  onError?: (err: unknown) => void;
}

/** Starts the single `getUpdates` long-poll loop (§2, §12 Phase 1). Returns a stop function. */
export function startPolling(source: UpdatesSource, opts: PollLoopOptions): () => void {
  let stopped = false;
  let offset = opts.initialOffset ?? 0;
  const timeoutSec = opts.timeoutSec ?? 25;
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  const loop = async () => {
    while (!stopped) {
      try {
        const updates = await source.getUpdates(offset, timeoutSec);
        for (const update of updates) {
          offset = update.update_id + 1;
          opts.onOffsetChange?.(offset);
          opts.onUpdate(update);
        }
      } catch (err) {
        opts.onError?.(err);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  };
  void loop();

  return () => {
    stopped = true;
  };
}
