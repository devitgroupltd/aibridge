export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  message_thread_id?: number;
  text?: string;
  from?: { id: number; username?: string; first_name?: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
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
  ): Promise<{ message_id: number }>;
  /** Optional: only needed by callers that edit a previously-sent message (the thinking placeholder). */
  editMessageText?(chatId: string | number, messageId: number, text: string): Promise<void>;
}

export interface SendChatActionSource {
  sendChatAction(chatId: string | number, messageThreadId: number | undefined, action: string): Promise<void>;
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
  ): Promise<{ message_id: number }> {
    const res = await fetch(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId, text }),
    });
    return parseTelegramResponse(res, "sendMessage");
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

  async editMessageText(chatId: string | number, messageId: number, text: string): Promise<void> {
    const res = await fetch(this.url("editMessageText"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
    });
    await parseTelegramResponse(res, "editMessageText");
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
