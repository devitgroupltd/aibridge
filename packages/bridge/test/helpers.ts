import { RuntimeSettings, type NlRouterBackend, type SettingsStorePort } from "../src/runtime-settings.ts";
import type { Effort, Mode } from "../src/session-commands.ts";

/**
 * Test doubles shared across this suite.
 *
 * There was no shared helper module here at all until now: 94 test files, 23k lines, and fifteen
 * separate hand-rolled control-bot doubles - nine of which contained the byte-identical
 * `sent.push({ topicId, text, keyboard: replyMarkup })` line. Each was individually fine; the cost
 * was that a change to what the double must record (a new `sendMessage` parameter, say) meant
 * finding all fifteen.
 *
 * Everything here is deliberately a plain object with public recording arrays rather than a mock
 * framework: a test asserts against `bot.sent` directly, exactly as it did against its own local
 * copy. A file needing a method this base doesn't have spreads it in - `{ ...fakeControlBot(),
 * createForumTopic: async () => ({ message_thread_id: 7 }) }` - and the recording arrays come along
 * by reference, so assertions on `sent`/`edited` keep working through the spread.
 */

export interface FakeSentMessage {
  topicId: number | undefined;
  text: string;
  keyboard?: unknown;
}

export interface FakeEditedMessage {
  messageId: number;
  text: string;
  keyboard?: unknown;
}

export interface FakeControlBot {
  sendMessage(chatId: unknown, topicId: number | undefined, text: string, replyMarkup?: unknown, parseMode?: unknown): Promise<{ message_id: number }>;
  editMessageText(chatId: unknown, messageId: number, text: string, replyMarkup?: unknown, parseMode?: unknown): Promise<void>;
  deleteMessage(chatId: unknown, messageId: number): Promise<void>;
  answerCallbackQuery(callbackQueryId: string): Promise<void>;
  /** Every `sendMessage`, in order. `message_id` is `sent.length` at the time of the call, so the
   * first message sent is id 1 - the convention every hand-rolled copy of this already used, and
   * one several tests assert against directly. */
  readonly sent: FakeSentMessage[];
  readonly edited: FakeEditedMessage[];
  readonly deleted: number[];
  readonly answered: string[];
}

export function fakeControlBot(): FakeControlBot {
  const sent: FakeSentMessage[] = [];
  const edited: FakeEditedMessage[] = [];
  const deleted: number[] = [];
  const answered: string[] = [];
  return {
    sendMessage: async (_chatId, topicId, text, replyMarkup) => {
      sent.push({ topicId, text, keyboard: replyMarkup });
      return { message_id: sent.length };
    },
    editMessageText: async (_chatId, messageId, text, replyMarkup) => {
      edited.push({ messageId, text, keyboard: replyMarkup });
    },
    deleteMessage: async (_chatId, messageId) => {
      deleted.push(messageId);
    },
    answerCallbackQuery: async (callbackQueryId) => {
      answered.push(callbackQueryId);
    },
    sent,
    edited,
    deleted,
    answered,
  };
}

/** A `SettingsStorePort` backed by a `Map`, with every write recorded - so a test can assert both
 * the resulting value and the fact that a write happened at all (which is what the old
 * `settingsStoreCalls` arrays were checking, back when persisting was a separate call the caller
 * had to remember). */
export interface RecordingSettingsStore extends SettingsStorePort {
  readonly writes: Array<{ key: string; value: string }>;
}

export function recordingSettingsStore(initial: Record<string, string> = {}): RecordingSettingsStore {
  const values = new Map(Object.entries(initial));
  const writes: Array<{ key: string; value: string }> = [];
  return {
    get: (key, fallback) => values.get(key) ?? fallback,
    set: (key, value) => {
      values.set(key, value);
      writes.push({ key, value });
    },
    writes,
  };
}

export interface TestRuntimeSettingsOverrides {
  assistEnabled?: boolean;
  voiceConfirmEnabled?: boolean;
  defaultSessionMode?: Mode;
  defaultSessionEffort?: Effort;
  defaultBypassEnabled?: boolean;
  defaultAutoAnswerEnabled?: boolean;
  nlRouterBackend?: NlRouterBackend;
}

/**
 * A `RuntimeSettings` on an in-memory store, seeded through its own setters so the store contents
 * match what a real run would have written. The `store` is returned alongside it because a test
 * asserting that a command *persisted* something needs to look at the store - the setter and the
 * write are the same call now, so there is no separate spy to hang that assertion on.
 */
export function testRuntimeSettings(overrides: TestRuntimeSettingsOverrides = {}): { settings: RuntimeSettings; store: RecordingSettingsStore } {
  const store = recordingSettingsStore();
  const settings = new RuntimeSettings(store, overrides.nlRouterBackend ?? "cli");
  if (overrides.assistEnabled !== undefined) settings.setAssistEnabled(overrides.assistEnabled);
  if (overrides.voiceConfirmEnabled !== undefined) settings.setVoiceConfirmEnabled(overrides.voiceConfirmEnabled);
  if (overrides.defaultSessionMode !== undefined) settings.setDefaultSessionMode(overrides.defaultSessionMode);
  if (overrides.defaultSessionEffort !== undefined) settings.setDefaultSessionEffort(overrides.defaultSessionEffort);
  if (overrides.defaultBypassEnabled !== undefined) settings.setDefaultBypassEnabled(overrides.defaultBypassEnabled);
  if (overrides.defaultAutoAnswerEnabled !== undefined) settings.setDefaultAutoAnswerEnabled(overrides.defaultAutoAnswerEnabled);
  // Seeding writes to the store too, which would otherwise show up as writes the test never made.
  store.writes.length = 0;
  return { settings, store };
}
