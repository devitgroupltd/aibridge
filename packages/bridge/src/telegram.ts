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
  // `message_id` added for browse-nav.ts's folder/find navigation: every other callback flow edits a
  // message via an id it stored itself in its own registry (fleet-confirm.ts, permission-registry.ts,
  // ...), but a `/browse` tap edits *whichever* message the tap came from - there's no registry entry
  // per rendered message to look it up in, since one id is minted per row, not per message. Reading
  // it straight off the callback avoids threading a messageId through every registry entry just for
  // this one feature.
  message?: { chat: { id: number }; message_thread_id?: number; message_id?: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  // Exactly one of these two per Telegram's own API contract. `url` added for browse-nav.ts's
  // best-effort GitHub link button - a real "opens in browser" button needs no round-trip through
  // the Bridge at all, unlike every other button here, which is why it's the one case that doesn't
  // need a callback_data namespace of its own.
  callback_data?: string;
  url?: string;
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

/** Plain JSON RPC calls (sendMessage, closeForumTopic, ...) get this; `getUpdates`'s long-poll and
 * the multipart file methods use their own, longer budgets below. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Multipart uploads/downloads (`sendDocument`, `sendPhotoFile`, `downloadFile`, ...) can
 * legitimately take longer than a plain JSON call over a slow connection. */
const FILE_TIMEOUT_MS = 60_000;

/**
 * Found live 2026-08-06 during a rate-storm exercise: every call below used a bare `fetch` with no
 * client-side timeout at all - `getUpdates`'s own `timeout` param only tells Telegram's server how
 * long to hold the long-poll open, it does nothing if the underlying connection itself stalls. Node/
 * Bun's `fetch` pools connections per origin, and every method here (both bot tokens) hits the same
 * origin (`api.telegram.org`) - one indefinitely-stalled request with no timeout exhausts that pool
 * and silently wedges every *other* outbound call to Telegram too, including `getUpdates` itself and
 * a plain `/ls` reply, with the Bridge process staying alive and "Responding" throughout (blocked on
 * network I/O, not compute) - confirmed live: the control bot and feed bot both went completely
 * silent at once, with no crash and no log line, and only cleared once the process was killed.
 * `AbortController` here turns that into a loud, bounded, retriable failure instead.
 *
 * Found again during the `/deep-check` sweep: the first version cleared the timer as soon as
 * `fetch()` resolved - i.e. once *headers* arrive - not once the body has actually been read. Every
 * caller here goes on to await `res.json()`/`.text()`/`.arrayBuffer()` (`parseTelegramResponse`,
 * `downloadFile`) *after* this function returns, so a connection that stalls mid-body (headers land,
 * then nothing) reproduced the exact unbounded hang this function exists to prevent - the timeout
 * would already be disarmed by the time the stall happened. Fixed by leaving the timer armed and
 * instead wrapping the response's own body-reading methods so the same bound covers both phases,
 * clearing the timer only once the body genuinely settles (success or failure) either way.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Some callers (downloadFile's `!res.ok` branch) legitimately never read the body at all, so the
  // timer can outlive the request it was guarding by design - `unref` (Node/Bun; absent under other
  // runtimes, hence the guard) just keeps that from holding the process/test runner open, since a
  // late no-op abort() against an already-finished request is harmless either way.
  (timer as unknown as { unref?: () => void }).unref?.();
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new Error(`Telegram request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  }
  // Deliberately NOT cleared here - see the comment above. `guard` re-arms the same bound around
  // whichever body-reading method the caller actually uses, and is the only place the timer gets
  // cleared, on every path (success or failure).
  const guard = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`Telegram request timed out after ${timeoutMs}ms while reading the response body: ${url}`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };
  return Object.assign(res, {
    json: guard(res.json.bind(res)),
    text: guard(res.text.bind(res)),
    arrayBuffer: guard(res.arrayBuffer.bind(res)),
  });
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
/**
 * Telegram 400s that mean "this specific message can never be edited again", as distinct from a
 * transient failure worth retrying. Matched on the message text because the Bot API returns all of
 * them as a plain 400 with no machine-readable code.
 *
 * §9's silent-wrong bar squarely: the feed card's flush uses this to decide whether to *invalidate*
 * its cached `message_id`. Classifying a permanent failure as transient leaves the feed for that
 * session silently dead for the life of the process (the P2 lane swallows rejections); classifying a
 * transient one as permanent posts a duplicate card. Neither crashes, so only a test catches it.
 */
export function isPermanentEditFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /message to edit not found|message can't be edited|MESSAGE_ID_INVALID|message thread not found/i.test(message);
}

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
    const res = await fetchWithTimeout(this.url("getMe"), {}, DEFAULT_TIMEOUT_MS);
    return parseTelegramResponse(res, "getMe");
  }

  async getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    // The client-side budget must comfortably outlast Telegram's own server-side long-poll
    // (`timeoutSec`) - 10s of slack for the round trip itself, not a race against it.
    const res = await fetchWithTimeout(
      this.url("getUpdates"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offset, timeout: timeoutSec }),
      },
      (timeoutSec + 10) * 1000,
    );
    return parseTelegramResponse(res, "getUpdates");
  }

  async sendMessage(
    chatId: string | number,
    messageThreadId: number | undefined,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    parseMode?: "HTML",
  ): Promise<{ message_id: number }> {
    const res = await fetchWithTimeout(
      this.url("sendMessage"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_thread_id: messageThreadId,
          text,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...(parseMode ? { parse_mode: parseMode } : {}),
        }),
      },
      DEFAULT_TIMEOUT_MS,
    );
    return parseTelegramResponse(res, "sendMessage");
  }

  /** Must be called for every `callback_query` update, or the tapped button spins forever on mobile. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const res = await fetchWithTimeout(
      this.url("answerCallbackQuery"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
      },
      DEFAULT_TIMEOUT_MS,
    );
    await parseTelegramResponse(res, "answerCallbackQuery");
  }

  async sendChatAction(
    chatId: string | number,
    messageThreadId: number | undefined,
    action: string,
  ): Promise<void> {
    const res = await fetchWithTimeout(
      this.url("sendChatAction"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId, action }),
      },
      DEFAULT_TIMEOUT_MS,
    );
    await parseTelegramResponse(res, "sendChatAction");
  }

  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    parseMode?: "HTML",
  ): Promise<void> {
    const res = await fetchWithTimeout(
      this.url("editMessageText"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...(parseMode ? { parse_mode: parseMode } : {}),
        }),
      },
      DEFAULT_TIMEOUT_MS,
    );
    await parseTelegramResponse(res, "editMessageText");
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<void> {
    const res = await fetchWithTimeout(
      this.url("deleteMessage"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      },
      DEFAULT_TIMEOUT_MS,
    );
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
    const res = await fetchWithTimeout(this.url("sendDocument"), { method: "POST", body: form }, FILE_TIMEOUT_MS);
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
    const res = await fetchWithTimeout(this.url("sendPhoto"), { method: "POST", body: form }, FILE_TIMEOUT_MS);
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
    const res = await fetchWithTimeout(this.url("sendDocument"), { method: "POST", body: form }, FILE_TIMEOUT_MS);
    return parseTelegramResponse(res, "sendDocument");
  }

  /** Resolves a `file_id` (e.g. a voice note's) to a `file_path` for use with `downloadFile`. */
  async getFile(fileId: string): Promise<{ file_path: string }> {
    const res = await fetchWithTimeout(
      this.url("getFile"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
      },
      DEFAULT_TIMEOUT_MS,
    );
    return parseTelegramResponse(res, "getFile");
  }

  /** Downloads the raw bytes from Telegram's file CDN - a plain GET against `/file/bot<token>/...`,
   * not one of the `/bot<token>/<method>` JSON RPC calls, so it does not go through
   * `parseTelegramResponse`. */
  async downloadFile(filePath: string): Promise<Uint8Array> {
    const res = await fetchWithTimeout(`${this.baseUrl}/file/bot${this.token}/${filePath}`, {}, FILE_TIMEOUT_MS);
    if (!res.ok) {
      throw new Error(`Telegram file download failed: ${res.status} ${res.statusText}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async setMyCommands(chatId: string | number, commands: readonly BotCommand[]): Promise<void> {
    const res = await fetchWithTimeout(
      this.url("setMyCommands"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands, scope: { type: "chat", chat_id: chatId } }),
      },
      DEFAULT_TIMEOUT_MS,
    );
    await parseTelegramResponse(res, "setMyCommands");
  }

  async createForumTopic(chatId: string | number, name: string): Promise<{ message_thread_id: number }> {
    const res = await fetchWithTimeout(
      this.url("createForumTopic"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, name }),
      },
      DEFAULT_TIMEOUT_MS,
    );
    return parseTelegramResponse(res, "createForumTopic");
  }

  async editForumTopic(chatId: string | number, messageThreadId: number, name: string): Promise<void> {
    const res = await fetchWithTimeout(
      this.url("editForumTopic"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId, name }),
      },
      DEFAULT_TIMEOUT_MS,
    );
    await parseTelegramResponse(res, "editForumTopic");
  }

  async closeForumTopic(chatId: string | number, messageThreadId: number): Promise<void> {
    const res = await fetchWithTimeout(
      this.url("closeForumTopic"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId }),
      },
      DEFAULT_TIMEOUT_MS,
    );
    await parseTelegramResponse(res, "closeForumTopic");
  }

  async deleteForumTopic(chatId: string | number, messageThreadId: number): Promise<void> {
    const res = await fetchWithTimeout(
      this.url("deleteForumTopic"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId }),
      },
      DEFAULT_TIMEOUT_MS,
    );
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
