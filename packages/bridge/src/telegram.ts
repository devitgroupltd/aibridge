export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  message_thread_id?: number;
  text?: string;
  from?: { id: number; username?: string; first_name?: string };
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
}

export interface SendChatActionSource {
  sendChatAction(chatId: string | number, messageThreadId: number | undefined, action: string): Promise<void>;
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
  const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) {
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
  onUpdate: (update: TelegramUpdate) => void;
  onError?: (err: unknown) => void;
}

/** Starts the single `getUpdates` long-poll loop (§2, §12 Phase 1). Returns a stop function. */
export function startPolling(source: UpdatesSource, opts: PollLoopOptions): () => void {
  let stopped = false;
  let offset = 0;
  const timeoutSec = opts.timeoutSec ?? 25;
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  const loop = async () => {
    while (!stopped) {
      try {
        const updates = await source.getUpdates(offset, timeoutSec);
        for (const update of updates) {
          offset = update.update_id + 1;
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
