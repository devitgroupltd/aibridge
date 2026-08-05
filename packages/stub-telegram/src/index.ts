/**
 * A local HTTP stub of the Telegram Bot API surface aibridge needs: `getUpdates`, `sendMessage`,
 * `editMessageText`, `createForumTopic`, `answerCallbackQuery`, keyed by `/bot<token>/<method>`
 * with independent per-token state (mirrors Telegram's real per-token isolation - §5.4). Building
 * this is explicit Phase 1 work (§9): "everything after this depends on being testable."
 *
 * `getUpdates` genuinely long-polls (blocks up to the requested `timeout`, or returns early the
 * moment an update is pushed) rather than resolving instantly when empty - a stub that resolves
 * empty instantly turns a real polling loop into a microtask busy-spin, which starves Node's
 * timer phase (observed first-hand writing this package's own tests).
 */

export interface StubMessage {
  message_id: number;
  chat: { id: number };
  message_thread_id?: number;
  text?: string;
  from?: { id: number; username?: string; first_name?: string };
  /** Unix seconds - mirrors the real Bot API field aibridge's §7.4 stale-inbound check reads. */
  date: number;
}

export interface StubCallbackQuery {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_thread_id?: number };
}

export interface StubUpdate {
  update_id: number;
  message?: StubMessage;
  callback_query?: StubCallbackQuery;
}

export interface SentMessage {
  method: "sendMessage" | "editMessageText" | "sendDocument";
  chat_id: number;
  message_thread_id?: number;
  text: string;
  message_id: number;
  reply_markup?: unknown;
  /** Only set for `sendDocument` (§5.5's oversized-`details` path) - the uploaded file's own name. */
  filename?: string;
}

export interface PushUpdateInput {
  chatId: number;
  text: string;
  messageThreadId?: number;
  from?: { id: number; username?: string; first_name?: string };
  /** Unix seconds - defaults to "now", override to simulate a backlog message that arrived while
   * the Bridge was offline (§7.4's stale-inbound path). */
  date?: number;
}

export interface PushCallbackQueryInput {
  chatId: number;
  data: string;
  messageThreadId?: number;
}

interface StubTopic {
  name: string;
  closed: boolean;
  deleted: boolean;
}

interface TokenState {
  pendingUpdates: StubUpdate[];
  nextUpdateId: number;
  nextMessageId: number;
  nextTopicId: number;
  nextCallbackQueryId: number;
  sent: SentMessage[];
  answeredCallbackQueries: string[];
  waiters: Array<() => void>;
  topics: Map<number, StubTopic>;
  myCommands: unknown[];
  /** §5.4's 429 path (`force429`) - one-shot per queued entry, keyed by method, consumed in
   * FIFO order so a test can script "fail once, then succeed" without any real rate limiting. */
  forced429: Map<string, number[]>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class StubTelegramServer {
  private readonly tokens = new Map<string, TokenState>();
  private server?: ReturnType<typeof Bun.serve>;

  private stateFor(token: string): TokenState {
    let state = this.tokens.get(token);
    if (!state) {
      state = {
        pendingUpdates: [],
        nextUpdateId: 1,
        nextMessageId: 1,
        nextTopicId: 2,
        nextCallbackQueryId: 1,
        sent: [],
        answeredCallbackQueries: [],
        waiters: [],
        topics: new Map(),
        myCommands: [],
        forced429: new Map(),
      };
      this.tokens.set(token, state);
    }
    return state;
  }

  /** Simulates an inbound Telegram message arriving for `token`'s bot. */
  pushUpdate(token: string, input: PushUpdateInput): void {
    const state = this.stateFor(token);
    const update: StubUpdate = {
      update_id: state.nextUpdateId++,
      message: {
        message_id: state.nextMessageId++,
        chat: { id: input.chatId },
        message_thread_id: input.messageThreadId,
        text: input.text,
        from: input.from,
        date: input.date ?? Math.floor(Date.now() / 1000),
      },
    };
    state.pendingUpdates.push(update);
    const waiters = state.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  /** Simulates an operator tapping an inline-keyboard button for `token`'s bot. */
  pushCallbackQuery(token: string, input: PushCallbackQueryInput): void {
    const state = this.stateFor(token);
    const update: StubUpdate = {
      update_id: state.nextUpdateId++,
      callback_query: {
        id: String(state.nextCallbackQueryId++),
        data: input.data,
        message: { chat: { id: input.chatId }, message_thread_id: input.messageThreadId },
      },
    };
    state.pendingUpdates.push(update);
    const waiters = state.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  /** Everything sent via sendMessage/editMessageText for `token`, in call order. */
  getSent(token: string): SentMessage[] {
    return [...this.stateFor(token).sent];
  }

  /** `callback_query_id`s answered so far for `token`, in call order. */
  getAnsweredCallbackQueries(token: string): string[] {
    return [...this.stateFor(token).answeredCallbackQueries];
  }

  /** Current state of a forum topic (name, closed, deleted) for `token`'s bot - undefined if
   * `createForumTopic` was never called for that id. */
  getTopic(token: string, messageThreadId: number): StubTopic | undefined {
    return this.stateFor(token).topics.get(messageThreadId);
  }

  /** The most recent `setMyCommands` call's command list for `token`'s bot - empty if never called. */
  getMyCommands(token: string): unknown[] {
    return [...this.stateFor(token).myCommands];
  }

  /** Queues a one-shot 429 (`retry_after: retryAfterSec`) for the next call to `method` on
   * `token`'s bot - §5.4's "honour `retry_after` exactly" path, exercised without a real rate
   * limit. Queue, not a flag: calling this twice fails the next two calls, not just one. */
  force429(token: string, method: string, retryAfterSec: number): void {
    const state = this.stateFor(token);
    const queue = state.forced429.get(method) ?? [];
    queue.push(retryAfterSec);
    state.forced429.set(method, queue);
  }

  private async handleGetUpdates(state: TokenState, body: Record<string, unknown>): Promise<Response> {
    const offset = Number(body.offset ?? 0);
    const timeoutSec = Number(body.timeout ?? 0);

    state.pendingUpdates = state.pendingUpdates.filter((u) => u.update_id >= offset);
    if (state.pendingUpdates.length > 0 || timeoutSec <= 0) {
      return jsonResponse({ ok: true, result: state.pendingUpdates });
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutSec * 1000);
      state.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    state.pendingUpdates = state.pendingUpdates.filter((u) => u.update_id >= offset);
    return jsonResponse({ ok: true, result: state.pendingUpdates });
  }

  private handleSendMessage(state: TokenState, body: Record<string, unknown>): Response {
    const messageId = state.nextMessageId++;
    state.sent.push({
      method: "sendMessage",
      chat_id: Number(body.chat_id),
      message_thread_id: body.message_thread_id === undefined ? undefined : Number(body.message_thread_id),
      text: String(body.text ?? ""),
      message_id: messageId,
      reply_markup: body.reply_markup,
    });
    return jsonResponse({ ok: true, result: { message_id: messageId, chat: { id: Number(body.chat_id) }, text: body.text } });
  }

  private handleEditMessageText(state: TokenState, body: Record<string, unknown>): Response {
    const messageId = Number(body.message_id ?? 0);
    state.sent.push({
      method: "editMessageText",
      chat_id: Number(body.chat_id),
      message_thread_id: body.message_thread_id === undefined ? undefined : Number(body.message_thread_id),
      text: String(body.text ?? ""),
      message_id: messageId,
      reply_markup: body.reply_markup,
    });
    return jsonResponse({ ok: true, result: { message_id: messageId, chat: { id: Number(body.chat_id) }, text: body.text } });
  }

  /** §5.5: `sendDocument` is multipart, not JSON, so it's parsed via `req.formData()` in
   * `handleRequest` before this ever sees a `body` object - the shape here mirrors the other
   * handlers' `Record<string, unknown>` just enough to stay a plain function. */
  private async handleSendDocument(state: TokenState, req: Request): Promise<Response> {
    const form = await req.formData();
    const chatId = Number(form.get("chat_id") ?? 0);
    const threadRaw = form.get("message_thread_id");
    const messageThreadId = threadRaw === null ? undefined : Number(threadRaw);
    const file = form.get("document");
    const text = file instanceof Blob ? await file.text() : "";
    const filename = file instanceof File ? file.name : undefined;
    const messageId = state.nextMessageId++;
    state.sent.push({ method: "sendDocument", chat_id: chatId, message_thread_id: messageThreadId, text, message_id: messageId, filename });
    return jsonResponse({ ok: true, result: { message_id: messageId, chat: { id: chatId }, text } });
  }

  private handleCreateForumTopic(state: TokenState, body: Record<string, unknown>): Response {
    const messageThreadId = state.nextTopicId++;
    state.topics.set(messageThreadId, { name: String(body.name ?? ""), closed: false, deleted: false });
    return jsonResponse({ ok: true, result: { message_thread_id: messageThreadId, name: String(body.name ?? "") } });
  }

  private handleEditForumTopic(state: TokenState, body: Record<string, unknown>): Response {
    const messageThreadId = Number(body.message_thread_id ?? 0);
    const topic = state.topics.get(messageThreadId);
    if (topic) topic.name = String(body.name ?? topic.name);
    return jsonResponse({ ok: true, result: true });
  }

  private handleCloseForumTopic(state: TokenState, body: Record<string, unknown>): Response {
    const messageThreadId = Number(body.message_thread_id ?? 0);
    const topic = state.topics.get(messageThreadId);
    if (topic) topic.closed = true;
    return jsonResponse({ ok: true, result: true });
  }

  private handleDeleteForumTopic(state: TokenState, body: Record<string, unknown>): Response {
    const messageThreadId = Number(body.message_thread_id ?? 0);
    const topic = state.topics.get(messageThreadId);
    if (topic) topic.deleted = true;
    return jsonResponse({ ok: true, result: true });
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
    if (!match) return jsonResponse({ ok: false, description: "not found" }, 404);

    const [, token, method] = match as [string, string, string];
    const state = this.stateFor(token);

    const forcedQueue = state.forced429.get(method);
    const forcedRetryAfter = forcedQueue?.shift();
    if (forcedRetryAfter !== undefined) {
      return jsonResponse(
        { ok: false, error_code: 429, description: `Too Many Requests: retry after ${forcedRetryAfter}`, parameters: { retry_after: forcedRetryAfter } },
        429,
      );
    }

    // Multipart, not JSON - must branch before the generic `req.json()` parse below, which would
    // otherwise consume the request body stream trying (and failing) to parse it as JSON first.
    if (method === "sendDocument") {
      return this.handleSendDocument(state, req);
    }

    const body =
      req.method === "POST"
        ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
        : {};

    switch (method) {
      case "getMe":
        return jsonResponse({ ok: true, result: { id: 1, username: "stub_bot", is_bot: true } });
      case "getUpdates":
        return this.handleGetUpdates(state, body);
      case "sendMessage":
        return this.handleSendMessage(state, body);
      case "editMessageText":
        return this.handleEditMessageText(state, body);
      case "createForumTopic":
        return this.handleCreateForumTopic(state, body);
      case "editForumTopic":
        return this.handleEditForumTopic(state, body);
      case "closeForumTopic":
        return this.handleCloseForumTopic(state, body);
      case "deleteForumTopic":
        return this.handleDeleteForumTopic(state, body);
      case "answerCallbackQuery":
        state.answeredCallbackQueries.push(String(body.callback_query_id ?? ""));
        return jsonResponse({ ok: true, result: true });
      case "setMyCommands":
        state.myCommands = Array.isArray(body.commands) ? body.commands : [];
        return jsonResponse({ ok: true, result: true });
      default:
        return jsonResponse({ ok: false, description: `unknown method ${method}` }, 404);
    }
  }

  start(port = 0): { port: number; baseUrl: string } {
    this.server = Bun.serve({
      port,
      fetch: (req) => this.handleRequest(req),
    });
    const boundPort = this.server.port ?? port;
    return { port: boundPort, baseUrl: `http://127.0.0.1:${boundPort}` };
  }

  stop(): void {
    this.server?.stop(true);
  }
}
