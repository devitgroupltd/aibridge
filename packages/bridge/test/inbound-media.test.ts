import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInboundMedia } from "../src/inbound-media.ts";
import { Routing } from "../src/routing.ts";
import { RateGovernor } from "../src/rate-governor.ts";
import { RepoPickRegistry } from "../src/repo-picker.ts";
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
  const repoPickRegistry = new RepoPickRegistry();
  const dispatched: Array<{ messageId: number; rawText: string; threadId: number | undefined; replyToText: string | undefined }> = [];
  const confirmed: Array<{ topicId: number | undefined; text: string }> = [];
  const createdFromAttachment: Array<{ cmd: unknown; controlTopicId: number | undefined }> = [];
  const inboundMedia = createInboundMedia({
    controlBot,
    feedGovernor,
    routing,
    sessionStore,
    staleConfirmRegistry,
    voiceConfirmRegistry,
    repoPickRegistry,
    confirmSessionCommand: (topicId, text) => {
      confirmed.push({ topicId, text });
    },
    dispatchInboundMessage: async (messageId, rawText, threadId, _isControl, _route, _currentSlug, _from, _contextPrefix, replyToText) => {
      dispatched.push({ messageId, rawText, threadId, replyToText });
    },
    createSessionFromAttachment: async (cmd, controlTopicId) => {
      createdFromAttachment.push({ cmd, controlTopicId });
    },
    disableCaptionNew: false,
    // NL routing disabled by default in tests - `nlRouterConfig.enabled: false` short-circuits
    // `routeCaptionToNewCommand` before it would ever call the real `routeText`/an LLM backend.
    nlRouterConfig: { enabled: false, apiKey: undefined, model: "" },
    getNlRouterBackend: () => "cli",
    getReposRegistry: () => undefined,
    isControlTopic: (threadId) => threadId === undefined || threadId === 1,
    voiceConfirmEnabled: () => true,
    voice: { enabled: true, ffmpegPath: "ffmpeg", port: 8123 },
    supergroupChatId: "-100",
    ...overrides,
  });
  return { inboundMedia, controlBot, routing, sessionStore, staleConfirmRegistry, voiceConfirmRegistry, repoPickRegistry, dispatched, confirmed, createdFromAttachment };
}

// A real temp directory, not a bare string literal - `writeAttachmentToInbox` (attachment-inbox.ts)
// now writes into `route.worktreePath` directly (moved there from `$STATE` to dodge settings.ts's
// `Read(~/**)` deny rule), so any test that lands an attachment needs a real, writable path here
// rather than a fake `c:\worktrees\...` string that was never actually touched before this move.
let routeWorktreeDir: string;
let ROUTE: { slug: string; topicId: number; worktreePath: string };

beforeAll(async () => {
  routeWorktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-inbound-media-worktree-"));
  ROUTE = { slug: "fix-bug", topicId: 5, worktreePath: routeWorktreeDir };
});

afterAll(async () => {
  await fs.rm(routeWorktreeDir, { recursive: true, force: true });
});

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

      expect(dispatched).toEqual([{ messageId: 1, rawText: "hello", threadId: 5, replyToText: undefined }]);
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

      expect(dispatched).toEqual([{ messageId: 1, rawText: "/help", threadId: 999, replyToText: undefined }]);
    });

    // Reply-to-retry follow-up: reply_to_message's text/caption is threaded through to
    // dispatchInboundMessage's own replyToText param - the actual retry-vs-stash decision is
    // command-dispatch.ts's job (see command-dispatch.test.ts), this only covers the plumbing.
    describe("reply_to_message threading", () => {
      test("a reply's text/caption is passed through as replyToText", async () => {
        const { inboundMedia, routing, dispatched } = await setup();
        routing.add(ROUTE);

        inboundMedia.routeInboundMessage(
          message({ message_thread_id: 5, text: "retry", reply_to_message: { message_id: 1, text: "Start a new session for demo-repo" } }),
        );
        await Promise.resolve();

        expect(dispatched).toEqual([{ messageId: 1, rawText: "retry", threadId: 5, replyToText: "Start a new session for demo-repo" }]);
      });

      test("falls back to the reply target's caption when it has no text", async () => {
        const { inboundMedia, routing, dispatched } = await setup();
        routing.add(ROUTE);

        inboundMedia.routeInboundMessage(message({ message_thread_id: 5, text: "try again", reply_to_message: { message_id: 1, caption: "fix the login bug" } }));
        await Promise.resolve();

        expect(dispatched[0]?.replyToText).toBe("fix the login bug");
      });

      test("an ordinary message with no reply_to_message carries no replyToText", async () => {
        const { inboundMedia, routing, dispatched } = await setup();
        routing.add(ROUTE);

        inboundMedia.routeInboundMessage(message({ message_thread_id: 5, text: "hello" }));
        await Promise.resolve();

        expect(dispatched[0]?.replyToText).toBeUndefined();
      });

      // Reply-to-retry over an attachment: replying "retry" to a message that carried a photo/
      // document/video/audio/video-note must re-download and re-announce the attachment itself, not
      // just forward its caption as bare text - otherwise Claude sees only the caption on retry and
      // silently loses whatever the operator actually wanted analyzed.
      test("retry replying to a photo message re-downloads and re-announces the attachment, not just the caption", async () => {
        const { inboundMedia, routing, dispatched } = await setup();
        routing.add(ROUTE);

        inboundMedia.routeInboundMessage(
          message({
            message_thread_id: 5,
            text: "retry",
            reply_to_message: { message_id: 1, caption: "check this bug", photo: [{ file_id: "p1", width: 10, height: 10 }] },
          }),
        );
        await waitFor(() => dispatched.length >= 1);

        expect(dispatched.length).toBe(1);
        expect(dispatched[0]?.rawText).toContain("operator sent an image");
        expect(dispatched[0]?.rawText).toContain("check this bug");
        // This went through handleAttachmentMessage's own dispatch, not the plain-text replyToText
        // fallback - replyToText stays unset on this call.
        expect(dispatched[0]?.replyToText).toBeUndefined();
      });

      test("try again replying to a document in the control topic re-runs the caption-triggered /new", async () => {
        const { inboundMedia, createdFromAttachment } = await setup();

        inboundMedia.routeInboundMessage(
          message({
            message_thread_id: 1,
            text: "try again",
            reply_to_message: { message_id: 1, caption: "/new demo-repo add a README", document: { file_id: "d1", file_name: "spec.pdf" } },
          }),
        );
        await waitFor(() => createdFromAttachment.length >= 1);

        expect(createdFromAttachment.length).toBe(1);
      });

      test("a non-retry reply to a photo message is left as plain-text reply-to-retry threading, not attachment retry", async () => {
        const { inboundMedia, routing, dispatched } = await setup();
        routing.add(ROUTE);

        inboundMedia.routeInboundMessage(
          message({
            message_thread_id: 5,
            text: "looks good",
            reply_to_message: { message_id: 1, caption: "check this bug", photo: [{ file_id: "p1", width: 10, height: 10 }] },
          }),
        );
        await Promise.resolve();

        expect(dispatched).toEqual([{ messageId: 1, rawText: "looks good", threadId: 5, replyToText: "check this bug" }]);
      });
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
      // Lands inside the route's own worktree (attachment-inbox.ts's INBOX_DIR_NAME), not under a
      // slug-named $STATE path anymore - see writeAttachmentToInbox's own doc comment for why.
      expect(dispatched[0]?.rawText).toContain(ROUTE.worktreePath);
      expect(dispatched[0]?.rawText).toContain(".aibridge-inbox");
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

    // attachment-triggered-session-creation-plan.md: a captioned attachment in the control topic
    // with no route.
    describe("caption-triggered /new in the control topic", () => {
      test("a /new <repo> <prompt> caption creates a session via createSessionFromAttachment", async () => {
        const { inboundMedia, confirmed, createdFromAttachment } = await setup();

        await inboundMedia.handleAttachmentMessage("image", "i1", undefined, undefined, undefined, 1, undefined, true, 1, "/new demo-repo add a README", "op", message());

        expect(confirmed).toEqual([]);
        expect(createdFromAttachment.length).toBe(1);
        expect(createdFromAttachment[0]?.controlTopicId).toBe(1);
        expect(createdFromAttachment[0]?.cmd).toMatchObject({
          kind: "new",
          repo: "demo-repo",
          prompt: "add a README",
          pendingAttachment: { kind: "image", name: expect.any(String), bytes: expect.any(Uint8Array) },
        });
      });

      test("a caption that isn't a /new invocation still gets the plain rejection reply", async () => {
        const { inboundMedia, confirmed, createdFromAttachment } = await setup();

        await inboundMedia.handleAttachmentMessage("image", "i1", undefined, undefined, undefined, 1, undefined, true, 1, "check this out", "op", message());

        expect(createdFromAttachment).toEqual([]);
        expect(confirmed[0]?.text).toContain("session topic");
      });

      test("/new with no prompt (fails parseNew's grammar) falls back to the plain rejection reply", async () => {
        const { inboundMedia, confirmed, createdFromAttachment } = await setup();

        await inboundMedia.handleAttachmentMessage("image", "i1", undefined, undefined, undefined, 1, undefined, true, 1, "/new demo-repo", "op", message());

        expect(createdFromAttachment).toEqual([]);
        expect(confirmed[0]?.text).toContain("session topic");
      });

      test("the kill switch (disableCaptionNew) falls back to the plain rejection reply even for a valid caption", async () => {
        const { inboundMedia, confirmed, createdFromAttachment } = await setup({ disableCaptionNew: true });

        await inboundMedia.handleAttachmentMessage("image", "i1", undefined, undefined, undefined, 1, undefined, true, 1, "/new demo-repo add a README", "op", message());

        expect(createdFromAttachment).toEqual([]);
        expect(confirmed[0]?.text).toContain("session topic");
      });

      test("an oversized attachment with a valid /new caption is rejected without downloading", async () => {
        const { inboundMedia, confirmed, createdFromAttachment } = await setup();

        await inboundMedia.handleAttachmentMessage("video", "v1", 25 * 1024 * 1024, undefined, undefined, 1, undefined, true, 1, "/new demo-repo add a README", "op", message());

        expect(createdFromAttachment).toEqual([]);
        expect(confirmed[0]?.text).toContain("Bot API caps");
      });

      // Feature A of the caption-triggered /new follow-up: NL-router fallback for a freeform
      // caption. `routeText` is injected here (see InboundMediaOptions's own doc comment) so these
      // tests never hit a real CLI/API backend.
      describe("NL fallback for a freeform caption", () => {
        test("a freeform caption that NL-matches kind:new creates a session, same as the literal syntax", async () => {
          const routeTextCalls: Array<{ text: string; ctx: unknown }> = [];
          const { inboundMedia, confirmed, createdFromAttachment } = await setup({
            nlRouterConfig: { enabled: true, apiKey: undefined, model: "test-model" },
            routeText: async (text, ctx) => {
              routeTextCalls.push({ text, ctx });
              return { matched: true, command: { kind: "new", repo: "demo-repo", prompt: "fix the login bug" }, destructive: false };
            },
          });

          await inboundMedia.handleAttachmentMessage(
            "image",
            "i1",
            undefined,
            undefined,
            undefined,
            1,
            undefined,
            true,
            1,
            "create a session for demo-repo and fix the login bug",
            "op",
            message(),
          );

          expect(confirmed).toEqual([]);
          expect(routeTextCalls.length).toBe(1);
          expect(routeTextCalls[0]?.text).toBe("create a session for demo-repo and fix the login bug");
          expect(routeTextCalls[0]?.ctx).toMatchObject({ isControl: true, hasSession: false });
          expect(createdFromAttachment.length).toBe(1);
          expect(createdFromAttachment[0]?.cmd).toMatchObject({
            kind: "new",
            repo: "demo-repo",
            prompt: "fix the login bug",
            pendingAttachment: {
              kind: "image",
              name: expect.any(String),
              bytes: expect.any(Uint8Array),
              rawCaption: "create a session for demo-repo and fix the login bug",
            },
          });
        });

        test("literal /new syntax never reaches the NL router at all", async () => {
          let routeTextCalled = false;
          const { inboundMedia, createdFromAttachment } = await setup({
            nlRouterConfig: { enabled: true, apiKey: undefined, model: "test-model" },
            routeText: async () => {
              routeTextCalled = true;
              return { matched: false };
            },
          });

          await inboundMedia.handleAttachmentMessage("image", "i1", undefined, undefined, undefined, 1, undefined, true, 1, "/new demo-repo add a README", "op", message());

          expect(routeTextCalled).toBe(false);
          expect(createdFromAttachment.length).toBe(1);
          expect(createdFromAttachment[0]?.cmd).toMatchObject({ pendingAttachment: { rawCaption: undefined } });
        });

        test("an NL match to a non-new kind still falls back to the plain rejection reply", async () => {
          const { inboundMedia, confirmed, createdFromAttachment } = await setup({
            nlRouterConfig: { enabled: true, apiKey: undefined, model: "test-model" },
            routeText: async () => ({ matched: true, command: { kind: "ls" }, destructive: false }),
          });

          await inboundMedia.handleAttachmentMessage("image", "i1", undefined, undefined, undefined, 1, undefined, true, 1, "list my sessions", "op", message());

          expect(createdFromAttachment).toEqual([]);
          expect(confirmed[0]?.text).toContain("session topic");
        });

        // Ambiguous-repo gap fix: a caption that NL-matches session-creation intent without naming
        // one of 2+ registered repos used to be treated the same as any other non-"new" match and
        // fall straight through to the fixed rejection reply, silently dropping the attachment.
        describe("NL match to new_pick_repo (ambiguous repo)", () => {
          test("posts the ask-which-repo card instead of rejecting, and stashes the attachment", async () => {
            const { inboundMedia, controlBot, confirmed, createdFromAttachment, repoPickRegistry } = await setup({
              nlRouterConfig: { enabled: true, apiKey: undefined, model: "test-model" },
              getReposRegistry: () => ({ names: () => ["demo-repo", "other-repo"] }) as never,
              routeText: async () => ({ matched: true, command: { kind: "new_pick_repo", prompt: "fix the login bug" }, destructive: false }),
            });

            await inboundMedia.handleAttachmentMessage(
              "image",
              "i1",
              undefined,
              undefined,
              undefined,
              1,
              undefined,
              true,
              1,
              "create a session and fix the login bug",
              "op",
              message(),
            );

            // No rejection, and no session created yet - creation only happens once a repo is picked.
            expect(confirmed).toEqual([]);
            expect(createdFromAttachment).toEqual([]);

            expect(controlBot.sent.length).toBe(1);
            expect(controlBot.sent[0]?.text).toContain("Which repo");
            expect(controlBot.sent[0]?.text).toContain("image");
            const keyboard = controlBot.sent[0]?.keyboard as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
            const buttons = keyboard.inline_keyboard.flat();
            expect(buttons.map((b) => b.text)).toEqual(["demo-repo", "other-repo", "❌ Cancel"]);

            // The stashed pending pick carries the attachment bytes and raw caption, ready for a
            // repo tap (callback-query-router.ts's "rp:" rule) to hand off to createSessionFromAttachment.
            const id = buttons[0]!.callback_data.split(":")[1]!;
            const pending = repoPickRegistry.resolve(id);
            expect(pending?.prompt).toBe("fix the login bug");
            expect(pending?.sourceText).toBe("create a session and fix the login bug");
            expect(pending?.pendingAttachment).toMatchObject({
              kind: "image",
              name: expect.any(String),
              bytes: expect.any(Uint8Array),
              rawCaption: "create a session and fix the login bug",
            });
          });

          test("a caption that NL-matches new_pick_repo with an oversized attachment is rejected without ever posting the pick card", async () => {
            const { inboundMedia, confirmed, controlBot } = await setup({
              nlRouterConfig: { enabled: true, apiKey: undefined, model: "test-model" },
              getReposRegistry: () => ({ names: () => ["demo-repo", "other-repo"] }) as never,
              routeText: async () => ({ matched: true, command: { kind: "new_pick_repo", prompt: "fix the login bug" }, destructive: false }),
            });

            await inboundMedia.handleAttachmentMessage(
              "video",
              "v1",
              25 * 1024 * 1024,
              undefined,
              undefined,
              1,
              undefined,
              true,
              1,
              "create a session and fix the login bug",
              "op",
              message(),
            );

            expect(controlBot.sent).toEqual([]);
            expect(confirmed[0]?.text).toContain("Bot API caps");
          });
        });

        test("nlRouterConfig.enabled: false never calls routeText and falls back to rejection", async () => {
          let routeTextCalled = false;
          const { inboundMedia, confirmed, createdFromAttachment } = await setup({
            nlRouterConfig: { enabled: false, apiKey: undefined, model: "test-model" },
            routeText: async () => {
              routeTextCalled = true;
              return { matched: false };
            },
          });

          await inboundMedia.handleAttachmentMessage("image", "i1", undefined, undefined, undefined, 1, undefined, true, 1, "create a session for demo-repo", "op", message());

          expect(routeTextCalled).toBe(false);
          expect(createdFromAttachment).toEqual([]);
          expect(confirmed[0]?.text).toContain("session topic");
        });

        test("a caption that's already a known but non-new fleet command skips the NL router entirely (code-review fix)", async () => {
          let routeTextCalled = false;
          const { inboundMedia, confirmed, createdFromAttachment } = await setup({
            nlRouterConfig: { enabled: true, apiKey: undefined, model: "test-model" },
            routeText: async () => {
              routeTextCalled = true;
              return { matched: false };
            },
          });

          await inboundMedia.handleAttachmentMessage("image", "i1", undefined, undefined, undefined, 1, undefined, true, 1, "/ls", "op", message());

          expect(routeTextCalled).toBe(false);
          expect(createdFromAttachment).toEqual([]);
          expect(confirmed[0]?.text).toContain("session topic");
        });

        test("the kill switch also suppresses the NL fallback", async () => {
          let routeTextCalled = false;
          const { inboundMedia, confirmed, createdFromAttachment } = await setup({
            disableCaptionNew: true,
            nlRouterConfig: { enabled: true, apiKey: undefined, model: "test-model" },
            routeText: async () => {
              routeTextCalled = true;
              return { matched: true, command: { kind: "new", repo: "demo-repo", prompt: "fix it" }, destructive: false };
            },
          });

          await inboundMedia.handleAttachmentMessage("image", "i1", undefined, undefined, undefined, 1, undefined, true, 1, "create a session for demo-repo", "op", message());

          expect(routeTextCalled).toBe(false);
          expect(createdFromAttachment).toEqual([]);
          expect(confirmed[0]?.text).toContain("session topic");
        });
      });
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
