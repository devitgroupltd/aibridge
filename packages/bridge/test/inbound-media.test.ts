import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInboundMedia } from "../src/inbound-media.ts";
import { Routing } from "../src/routing.ts";
import { RateGovernor } from "../src/rate-governor.ts";
import { SessionStore } from "../src/session-store.ts";
import { StaleConfirmRegistry } from "../src/stale-confirm.ts";
import { VoiceConfirmRegistry } from "../src/voice-confirm.ts";
import type { TelegramMessage } from "../src/telegram.ts";

function fakeControlBot() {
  const sent: Array<{ topicId: number | undefined; text: string; keyboard?: unknown }> = [];
  return {
    sendMessage: async (_chatId: unknown, topicId: number | undefined, text: string, replyMarkup?: unknown) => {
      sent.push({ topicId, text, keyboard: replyMarkup });
      return { message_id: sent.length };
    },
    editMessageText: async () => {},
    getFile: async () => ({ file_path: "voice.ogg" }),
    downloadFile: async () => new Uint8Array([1, 2, 3]),
    sent,
  };
}

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: -100 },
    date: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

async function setup(overrides: Partial<Parameters<typeof createInboundMedia>[0]> = {}) {
  const controlBot = fakeControlBot();
  const feedGovernor = new RateGovernor({ log: () => {} });
  const routing = new Routing();
  const sessionStore = new SessionStore(":memory:");
  const staleConfirmRegistry = new StaleConfirmRegistry();
  const voiceConfirmRegistry = new VoiceConfirmRegistry();
  const dispatched: Array<{ messageId: number; rawText: string; threadId: number | undefined }> = [];
  const confirmed: Array<{ topicId: number | undefined; text: string }> = [];
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-inbound-media-test-"));
  const inboundMedia = createInboundMedia({
    controlBot,
    feedGovernor,
    routing,
    sessionStore,
    staleConfirmRegistry,
    voiceConfirmRegistry,
    confirmSessionCommand: (topicId, text) => {
      confirmed.push({ topicId, text });
    },
    dispatchInboundMessage: async (messageId, rawText, threadId) => {
      dispatched.push({ messageId, rawText, threadId });
    },
    isControlTopic: (threadId) => threadId === undefined || threadId === 1,
    voiceConfirmEnabled: () => true,
    voice: { enabled: true, ffmpegPath: "ffmpeg", port: 8123 },
    supergroupChatId: "-100",
    stateDir,
    ...overrides,
  });
  return { inboundMedia, controlBot, routing, sessionStore, staleConfirmRegistry, voiceConfirmRegistry, dispatched, confirmed, stateDir };
}

const ROUTE = { slug: "fix-bug", topicId: 5, worktreePath: "c:\\worktrees\\fix-bug" };

/** `writeAttachmentToInbox` is real `fs/promises` I/O (0.10x.0 - previously synchronous, see that
 * module's own doc comment for why it changed), so waiting out a fixed handful of microtask ticks
 * (`await Promise.resolve()`, enough for everything else in this file, which is all in-memory) is no
 * longer reliable for the attachment-download tests below - a real filesystem write needs real event
 * loop turns, not just queued microtasks. Polls instead of guessing a fixed tick count. */
function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("createInboundMedia", () => {
  describe("routeInboundMessage", () => {
    test("a plain-text update in a routed session topic falls through to dispatchInboundMessage", async () => {
      const { inboundMedia, routing, dispatched } = await setup();
      routing.add(ROUTE);

      inboundMedia.routeInboundMessage(message({ message_thread_id: 5, text: "hello" }));
      await Promise.resolve();

      expect(dispatched).toEqual([{ messageId: 1, rawText: "hello", threadId: 5 }]);
    });

    test("a message in an unrouted, unknown topic with no known command is dropped", async () => {
      const { inboundMedia, dispatched, confirmed } = await setup();

      inboundMedia.routeInboundMessage(message({ message_thread_id: 999, text: "just chatting" }));
      await Promise.resolve();

      expect(dispatched).toEqual([]);
      expect(confirmed).toEqual([]);
    });

    test("a known slash command still dispatches even in an unrouted topic", async () => {
      const { inboundMedia, dispatched } = await setup();

      inboundMedia.routeInboundMessage(message({ message_thread_id: 999, text: "/help" }));
      await Promise.resolve();

      expect(dispatched).toEqual([{ messageId: 1, rawText: "/help", threadId: 999 }]);
    });

    test.each([
      ["photo", { photo: [{ file_id: "p1", width: 10, height: 10 }] }],
      ["document", { document: { file_id: "d1", file_name: "notes.txt" } }],
      ["video", { video: { file_id: "v1" } }],
      ["audio", { audio: { file_id: "a1" } }],
      ["video_note", { video_note: { file_id: "n1" } }],
    ] as Array<[string, Partial<TelegramMessage>]>)("%s routes to handleAttachmentMessage, landing the file in the inbox", async (_kind, fields) => {
      const { inboundMedia, routing, dispatched } = await setup();
      routing.add(ROUTE);

      inboundMedia.routeInboundMessage(message({ message_thread_id: 5, ...fields }));
      await waitFor(() => dispatched.length >= 1);

      expect(dispatched.length).toBe(1);
      expect(dispatched[0]?.rawText).toContain(ROUTE.slug);
    });

    test("a voice update routes to handleVoiceMessage instead of dispatchInboundMessage", async () => {
      const { inboundMedia, routing, dispatched, controlBot } = await setup();
      routing.add(ROUTE);

      inboundMedia.routeInboundMessage(message({ message_thread_id: 5, voice: { file_id: "v1", duration: 3 } }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(dispatched).toEqual([]);
      expect(controlBot.sent.some((m) => m.text === "🎤 Transcribing...")).toBe(true);
    });

    test("isStaleInbound suppresses a stale text update via postStaleConfirm instead of dispatching it", async () => {
      const { inboundMedia, routing, dispatched, controlBot } = await setup();
      routing.add(ROUTE);
      const staleDate = Math.floor(Date.now() / 1000) - 6 * 60 * 60; // 6h old, well past the threshold

      inboundMedia.routeInboundMessage(message({ message_thread_id: 5, text: "still relevant?", date: staleDate }));
      await Promise.resolve();
      await Promise.resolve();

      expect(dispatched).toEqual([]);
      expect(controlBot.sent.length).toBe(1);
      expect(controlBot.sent[0]?.text).toContain("received while offline");
    });

    test("a stale attachment gets notifyStaleAttachment instead of being downloaded", async () => {
      const { inboundMedia, routing, dispatched, confirmed } = await setup();
      routing.add(ROUTE);
      const staleDate = Math.floor(Date.now() / 1000) - 6 * 60 * 60;

      inboundMedia.routeInboundMessage(message({ message_thread_id: 5, document: { file_id: "d1" }, date: staleDate }));

      expect(dispatched).toEqual([]);
      expect(confirmed.length).toBe(1);
      expect(confirmed[0]?.text).toContain("arrived while offline");
    });

    test("voice notes are exempt from the stale gate - a stale voice note still goes through handleVoiceMessage", async () => {
      const { inboundMedia, routing, dispatched, controlBot } = await setup();
      routing.add(ROUTE);
      const staleDate = Math.floor(Date.now() / 1000) - 6 * 60 * 60;

      inboundMedia.routeInboundMessage(message({ message_thread_id: 5, voice: { file_id: "v1", duration: 2 }, date: staleDate }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(dispatched).toEqual([]);
      // The placeholder/confirm-card edit went through the control bot, not the "received while
      // offline" stale-text path.
      expect(controlBot.sent.some((m) => m.text.includes("Transcribing"))).toBe(true);
      expect(controlBot.sent.some((m) => m.text.includes("received while offline"))).toBe(false);
    });
  });

  describe("handleAttachmentMessage", () => {
    test("downloads into the session's inbox and announces the path via dispatchInboundMessage", async () => {
      const { inboundMedia, dispatched } = await setup();

      await inboundMedia.handleAttachmentMessage("document", "d1", undefined, "notes.txt", "text/plain", 5, ROUTE, false, 42, "here you go", "op", message({ message_thread_id: 5 }));

      expect(dispatched.length).toBe(1);
      expect(dispatched[0]?.messageId).toBe(42);
      expect(dispatched[0]?.rawText).toContain("here you go");
    });

    test("rejects an oversized attachment without downloading it", async () => {
      const { inboundMedia, dispatched, confirmed } = await setup();

      await inboundMedia.handleAttachmentMessage("video", "v1", 25 * 1024 * 1024, undefined, undefined, 5, ROUTE, false, 42, undefined, "op", message());

      expect(dispatched).toEqual([]);
      expect(confirmed[0]?.text).toContain("Bot API caps");
    });

    test("in the control topic with no route, tells the operator to send it in a session topic", async () => {
      const { inboundMedia, confirmed } = await setup();

      await inboundMedia.handleAttachmentMessage("image", "i1", undefined, undefined, undefined, undefined, undefined, true, 1, undefined, "op", message());

      expect(confirmed[0]?.text).toContain("session topic");
    });

    test("silently drops a route-less attachment outside the control topic", async () => {
      const { inboundMedia, confirmed, dispatched } = await setup();

      await inboundMedia.handleAttachmentMessage("image", "i1", undefined, undefined, undefined, undefined, undefined, false, 1, undefined, "op", message());

      expect(confirmed).toEqual([]);
      expect(dispatched).toEqual([]);
    });
  });

  describe("handleVoiceMessage", () => {
    test("posts a confirm card carrying the transcript when voiceConfirmEnabled is true", async () => {
      const { inboundMedia, controlBot } = await setup({ voiceConfirmEnabled: () => true });

      await inboundMedia.handleVoiceMessage({ file_id: "v1", duration: 2 }, 5, 1, "op", Math.floor(Date.now() / 1000), message());

      expect(controlBot.sent.some((m) => m.text === "🎤 Transcribing...")).toBe(true);
    });

    test("replies that voice input isn't set up when disabled", async () => {
      const { inboundMedia, confirmed } = await setup({ voice: { enabled: false, ffmpegPath: "ffmpeg", port: 1 } });

      await inboundMedia.handleVoiceMessage({ file_id: "v1", duration: 2 }, 5, 1, "op", Math.floor(Date.now() / 1000), message());

      expect(confirmed[0]?.text).toContain("Voice input isn't set up");
    });
  });

  describe("postStaleConfirm / notifyStaleAttachment", () => {
    test("postStaleConfirm posts the offline-replay prompt with a Yes/No keyboard", async () => {
      const { inboundMedia, controlBot } = await setup();

      await inboundMedia.postStaleConfirm(5, 10, "do the thing", "op", "6h", message({ message_thread_id: 5 }));

      expect(controlBot.sent[0]?.text).toContain("received while offline (6h)");
      expect(controlBot.sent[0]?.text).toContain("do the thing");
      expect(controlBot.sent[0]?.keyboard).toBeDefined();
    });

    test("notifyStaleAttachment posts through confirmSessionCommand", async () => {
      const { inboundMedia, confirmed } = await setup();

      inboundMedia.notifyStaleAttachment(5, "3h");

      expect(confirmed[0]?.text).toContain("arrived while offline");
    });
  });
});
