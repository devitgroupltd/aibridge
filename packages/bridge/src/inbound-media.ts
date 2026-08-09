import type { AttachmentKind } from "./attachment-inbox.ts";
import { attachmentKindLabel, buildAttachmentAnnouncement, guessAttachmentFilename, TELEGRAM_MAX_DOWNLOAD_BYTES, writeAttachmentToInbox } from "./attachment-inbox.ts";
import { fireAndForget } from "./fire-and-forget.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import { isKnownCommandText, parseFleetCommand } from "./fleet-commands.ts";
import { buildContextPrefix, type MessageOrigin } from "./message-context.ts";
import { randomUUID } from "node:crypto";
import type { RateGovernor } from "./rate-governor.ts";
import type { Routing, SessionRoute } from "./routing.ts";
import type { SessionStore } from "./session-store.ts";
import { buildStaleConfirmKeyboard, type StaleConfirmRegistry } from "./stale-confirm.ts";
import { formatStaleAge, hasAttachment, isStaleInbound } from "./stale-inbound.ts";
import type { SendMessageSource, TelegramMessage } from "./telegram.ts";
import { buildVoiceConfirmKeyboard, type VoiceConfirmRegistry } from "./voice-confirm.ts";
import { transcribeVoiceNote } from "./voice-transcribe.ts";

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

/** `SendMessageSource` plus the two file-download methods the voice/attachment paths need -
 * narrower than the full `TelegramClient` class, so a test double doesn't have to fake every
 * method that file implements. */
export interface MediaSource extends SendMessageSource {
  getFile(fileId: string): Promise<{ file_path: string }>;
  downloadFile(filePath: string): Promise<Uint8Array>;
}

/** Same shape `dispatchInboundMessage` (command-dispatch.ts, not yet extracted) has today - taken
 * as an injected callback rather than a direct import to avoid a circular dependency (this module
 * calls it; command-dispatch.ts's own fallback path never needs to call back into this one). */
export type DispatchInboundMessage = (
  messageId: number,
  rawText: string,
  threadId: number | undefined,
  isControl: boolean,
  route: SessionRoute | undefined,
  currentSlug: string | undefined,
  from: string,
  contextPrefix?: string,
) => Promise<void>;

export interface InboundMediaOptions {
  controlBot: MediaSource;
  /** Shared reference, same "composition root owns it, module borrows it" rule as
   * feed-wiring.ts/quota-alarms.ts/confirm-cards.ts. */
  feedGovernor: RateGovernor;
  routing: Routing;
  sessionStore: SessionStore;
  staleConfirmRegistry: StaleConfirmRegistry;
  voiceConfirmRegistry: VoiceConfirmRegistry;
  confirmSessionCommand: (topicId: number | undefined, text: string) => void;
  dispatchInboundMessage: DispatchInboundMessage;
  /** Injected rather than imported - `session-lifecycle-commands.ts`'s `handleNewCommand` isn't
   * constructed until well after this module (see `index.ts`'s `LateBound`), same forward-reference
   * shape as `dispatchInboundMessage` above. Lets a control-topic attachment whose caption is a
   * `/new <repo> <prompt>` invocation create a session exactly as the text-only command does
   * (attachment-triggered-session-creation-plan.md). */
  createSessionFromAttachment: (cmd: Extract<FleetCommand, { kind: "new" }>, controlTopicId: number | undefined) => Promise<void>;
  /** Kill switch for the caption-triggered `/new` path only - if set, a captioned attachment in
   * the control topic falls back to today's plain rejection reply, same as any other malformed
   * caption. See that plan's Attachment-to-Session Handoff section for why this exists. */
  disableCaptionNew: boolean;
  /** §4.1's control-topic predicate - injected rather than imported since it's index.ts's one free
   * top-level function today, with call sites remaining in not-yet-extracted modules too. */
  isControlTopic: (threadId: number | undefined) => boolean;
  /** Getter, not a snapshot boolean: `/voiceconfirm` flips this at runtime and `handleVoiceMessage`
   * must see the current value on every call, the same "live getter" shape feed-coalescer.ts's
   * `quietMode` option already uses for the same reason. */
  voiceConfirmEnabled: () => boolean;
  voice: { enabled: boolean; ffmpegPath: string; port: number };
  supergroupChatId: string;
  stateDir: string;
  log?: LogFn;
}

export interface InboundMedia {
  postStaleConfirm(threadId: number | undefined, messageId: number, rawText: string, from: string, ageLabel: string, origin: MessageOrigin): Promise<void>;
  notifyStaleAttachment(threadId: number | undefined, ageLabel: string): void;
  handleVoiceMessage(
    voice: { file_id: string; duration: number },
    threadId: number | undefined,
    messageId: number,
    from: string,
    messageDate: number,
    origin: MessageOrigin,
  ): Promise<void>;
  handleAttachmentMessage(
    kind: AttachmentKind,
    fileId: string,
    fileSize: number | undefined,
    fileName: string | undefined,
    mimeType: string | undefined,
    threadId: number | undefined,
    route: SessionRoute | undefined,
    isControl: boolean,
    messageId: number,
    caption: string | undefined,
    from: string,
    origin: MessageOrigin,
  ): Promise<void>;
  /** The `onUpdate` plain-message routing entry point: stale-inbound gating, then media-type
   * sniffing to decide which of this module's own handlers (or the injected
   * `dispatchInboundMessage` fallback) a given update reaches. Synchronous by design, mirroring
   * `onUpdate`'s own non-async handler - every terminal action here is already a fire-and-forget
   * `void`-prefixed async call, same as before this was its own function. */
  routeInboundMessage(message: TelegramMessage): void;
}

export function createInboundMedia(opts: InboundMediaOptions): InboundMedia {
  const {
    controlBot,
    feedGovernor,
    routing,
    sessionStore,
    staleConfirmRegistry,
    voiceConfirmRegistry,
    confirmSessionCommand,
    dispatchInboundMessage,
    createSessionFromAttachment,
    disableCaptionNew,
    isControlTopic,
    voiceConfirmEnabled,
    voice,
    supergroupChatId,
    stateDir,
  } = opts;
  const log = opts.log ?? (() => {});

  /** §7.4's stale-inbound path: posts the "received while offline, still want this?" card instead
   * of dispatching a backlog message directly, and registers the replay payload. Mirrors
   * `postFleetConfirm`'s shape exactly. */
  async function postStaleConfirm(threadId: number | undefined, messageId: number, rawText: string, from: string, ageLabel: string, origin: MessageOrigin): Promise<void> {
    const id = randomUUID().slice(0, 8);
    const preview = rawText.length > 200 ? `${rawText.slice(0, 200)}…` : rawText;
    try {
      const sent = await controlBot.sendMessage(supergroupChatId, threadId, `⏳ received while offline (${ageLabel}) - still want this?\n\n${preview}`, {
        inline_keyboard: buildStaleConfirmKeyboard(id),
      });
      staleConfirmRegistry.add({ id, threadId, messageId, rawText, from, confirmCardMessageId: sent.message_id, origin });
    } catch (err) {
      log("WARN", `failed to post stale-inbound confirmation: ${(err as Error).message}`);
    }
  }

  /** §7.4 for the media paths: say so and stop, rather than landing a hours-old file in the
   * worktree and announcing it to a live session as if it had just arrived. */
  function notifyStaleAttachment(threadId: number | undefined, ageLabel: string): void {
    confirmSessionCommand(threadId, `⏳ An attachment arrived while offline (${ageLabel}) - not delivered. Re-send it if you still want it.`);
  }

  /** Voice-input's own confirm-card path (voice-confirm.ts): downloads the voice note, transcribes
   * it locally against the Bridge's own supervised whisper-server, and posts a Send/Re-record/
   * Type-instead card - never dispatched directly. Whisper's accuracy varies a lot by language
   * (Azerbaijani meaningfully weaker than English/Russian/Ukrainian per the voice-input design
   * decision), so showing the transcript before it reaches a live session is load-bearing.
   *
   * A real recording is several seconds of download+ffmpeg+whisper before there's anything to
   * show - same "nothing visible is happening" gap thinking-placeholder.ts exists to close for a
   * turn, and observed live the same way (an 8s voice note with no feedback at all reads as
   * "did this even work?"). Same fix: post a "🎤 Transcribing..." placeholder immediately, then
   * edit that same message into the real confirm card - one message per voice note, not two. */
  async function handleVoiceMessage(
    voiceMessage: { file_id: string; duration: number },
    threadId: number | undefined,
    messageId: number,
    from: string,
    messageDate: number,
    origin: MessageOrigin,
  ): Promise<void> {
    if (!voice.enabled) {
      confirmSessionCommand(threadId, "Voice input isn't set up on this Bridge yet - see scripts/setup-windows.ps1's voice step, then set VOICE_ENABLED=true.");
      return;
    }
    let placeholderId: number | undefined;
    try {
      const placeholder = await feedGovernor.scheduleAsync("P1", () =>
        controlBot.sendMessage(supergroupChatId, threadId, "🎤 Transcribing..."),
      );
      placeholderId = placeholder.message_id;

      const { file_path } = await controlBot.getFile(voiceMessage.file_id);
      const oggBytes = await controlBot.downloadFile(file_path);
      const { text } = await transcribeVoiceNote(
        { ffmpegPath: voice.ffmpegPath, serverUrl: `http://127.0.0.1:${voice.port}` },
        oggBytes,
      );
      const preview = text.length > 0 ? text : "(nothing recognised - try again?)";
      // An empty transcript always still shows the card, even with confirmation off - there's
      // nothing useful to auto-send, and re-record/type-instead are the only sensible next steps.
      // A *stale* note does the same: voice is exempt from §7.4's gate only because the confirm
      // card is itself the review step, so with confirmation off that justification disappears and
      // a note recorded hours ago would otherwise auto-send into a live session.
      const staleNote = isStaleInbound(messageDate, Date.now());
      if (voiceConfirmEnabled() || text.length === 0 || staleNote) {
        const id = randomUUID().slice(0, 8);
        if (controlBot.editMessageText) {
          await feedGovernor.scheduleAsync("P1", () =>
            controlBot.editMessageText!(supergroupChatId, placeholderId!, `🎤 ${preview}`, { inline_keyboard: buildVoiceConfirmKeyboard(id) }),
          );
        }
        voiceConfirmRegistry.add({ id, threadId, messageId, transcript: text, from, confirmCardMessageId: placeholderId, origin });
        return;
      }
      // Confirmation is off - send straight through, but the transcript stays visible on the
      // finalized message (not just a bare "Sent") so there's still something to read before
      // deciding to flip /voiceconfirm back on.
      if (controlBot.editMessageText) {
        await feedGovernor.scheduleAsync("P1", () =>
          controlBot.editMessageText!(
            supergroupChatId,
            placeholderId!,
            `🎤 ${preview}\n\n✅ Auto-sent (confirmation off - /voiceconfirm on to review before sending).`,
            { inline_keyboard: [] },
          ),
        );
      }
      const autoIsControl = isControlTopic(threadId);
      const autoRoute = threadId !== undefined ? routing.getByTopicId(threadId) : undefined;
      fireAndForget(
        dispatchInboundMessage(messageId, text, threadId, autoIsControl, autoRoute, autoRoute?.slug, from, buildContextPrefix(origin)),
        log,
        "inbound-media dispatchInboundMessage(auto-sent voice)",
      );
    } catch (err) {
      log("WARN", `voice transcription failed: ${(err as Error).message}`);
      const failText = "Couldn't transcribe that voice note - try again, or just type it.";
      if (placeholderId !== undefined && controlBot.editMessageText) {
        await controlBot.editMessageText(supergroupChatId, placeholderId, failText).catch(() => {});
      } else {
        confirmSessionCommand(threadId, failText);
      }
    }
  }

  /** attachment-triggered-session-creation-plan.md: a photo/document/video/audio/video-note landed
   * in the control topic (§5.6's `!route` branch), with a caption that's a `/new <repo> <prompt>`
   * invocation - reuses the real `parseFleetCommand`/`parseNew` grammar (the caption already starts
   * with `/new`, so no synthetic string or exported-`parseNew` shortcut is needed), the exact same
   * parser the text-only command uses. Anything else - no caption, a caption that isn't `/new`, or
   * the kill switch set - falls back unchanged to today's fixed rejection reply. */
  /** The size-check + download + filename-guess shared by both attachment paths below (a
   * control-topic caption-triggered `/new`, and an existing session's own inbox) - identical up to
   * the point each does something different with the result (code-review DRY finding). Returns
   * `null` after already posting whatever rejection/failure reply applies - callers' only job on
   * `null` is to return. */
  async function downloadAttachment(
    kind: AttachmentKind,
    fileId: string,
    fileSize: number | undefined,
    fileName: string | undefined,
    mimeType: string | undefined,
    threadId: number | undefined,
  ): Promise<{ bytes: Uint8Array; name: string } | null> {
    if (fileSize !== undefined && fileSize > TELEGRAM_MAX_DOWNLOAD_BYTES) {
      confirmSessionCommand(threadId, `That's too large to download (${Math.round(fileSize / (1024 * 1024))} MB) - Telegram's Bot API caps bot downloads at 20 MB.`);
      return null;
    }
    try {
      const { file_path } = await controlBot.getFile(fileId);
      const bytes = await controlBot.downloadFile(file_path);
      return { bytes, name: guessAttachmentFilename(kind, fileName, mimeType) };
    } catch (err) {
      log("WARN", `attachment download failed: ${(err as Error).message}`);
      confirmSessionCommand(threadId, `Couldn't download that ${kind} - try sending it again.`);
      return null;
    }
  }

  async function handleControlTopicAttachment(
    kind: AttachmentKind,
    fileId: string,
    fileSize: number | undefined,
    fileName: string | undefined,
    mimeType: string | undefined,
    threadId: number | undefined,
    caption: string | undefined,
  ): Promise<void> {
    const fleetCmd: FleetCommand | null = caption ? parseFleetCommand(caption) : null;
    if (disableCaptionNew || !fleetCmd || fleetCmd.kind !== "new") {
      confirmSessionCommand(threadId, `Send ${attachmentKindLabel(kind)} in a session topic - the control topic has no session to hand it to.`);
      return;
    }
    const downloaded = await downloadAttachment(kind, fileId, fileSize, fileName, mimeType, threadId);
    if (!downloaded) return;
    await createSessionFromAttachment({ ...fleetCmd, pendingAttachment: { kind, name: downloaded.name, bytes: downloaded.bytes } }, threadId);
  }

  /** Inbound photos/documents/videos/audio/video-notes (§5.6): downloaded into the session's own
   * `inbox/` directory and announced by path - "no protocol extension is needed, because a path
   * in context is enough." Unlike voice input, there's no transcription step and no confirm card:
   * the announcement (plus any caption) goes straight to the session through the same
   * `dispatchInboundMessage` path a typed message would, since there's nothing ambiguous here for
   * an operator to review first. Only fires for a real session topic - the control topic has no
   * worktree/session to hand a landed file to. */
  async function handleAttachmentMessage(
    kind: AttachmentKind,
    fileId: string,
    fileSize: number | undefined,
    fileName: string | undefined,
    mimeType: string | undefined,
    threadId: number | undefined,
    route: SessionRoute | undefined,
    isControl: boolean,
    messageId: number,
    caption: string | undefined,
    from: string,
    origin: MessageOrigin,
  ): Promise<void> {
    if (!route) {
      if (isControl) {
        await handleControlTopicAttachment(kind, fileId, fileSize, fileName, mimeType, threadId, caption);
      }
      return;
    }
    const downloaded = await downloadAttachment(kind, fileId, fileSize, fileName, mimeType, threadId);
    if (!downloaded) return;
    try {
      const absPath = await writeAttachmentToInbox(stateDir, route.slug, downloaded.name, downloaded.bytes);
      const announcement = buildAttachmentAnnouncement(kind, absPath, caption);
      fireAndForget(
        dispatchInboundMessage(messageId, announcement, threadId, isControl, route, route.slug, from, buildContextPrefix(origin)),
        log,
        `inbound-media dispatchInboundMessage(${kind} attachment)`,
      );
    } catch (err) {
      log("WARN", `attachment download failed: ${(err as Error).message}`);
      confirmSessionCommand(threadId, `Couldn't download that ${kind} - try sending it again.`);
    }
  }

  function routeInboundMessage(message: TelegramMessage): void {
    if (String(message.chat.id) !== supergroupChatId) return;

    const threadId = message.message_thread_id;
    const isControl = isControlTopic(threadId);
    const route = threadId !== undefined ? routing.getByTopicId(threadId) : undefined;
    const currentSlug = route?.slug;
    // A topic with no *live route* may still be a topic this Bridge knows about: a `dead` row's
    // topic (reconciliation only re-routes non-dead rows, so every `/kill`ed session's topic
    // loses its route on the next restart), or an orphaned topic whose row is gone entirely -
    // §4.5.2's own recovery instruction is for the operator to send `/rm` *in that topic*.
    // Dropping those outright made that instruction impossible to follow and silently swallowed
    // `/help` too, which is also what made the live diagnosis of §4.5.2 ambiguous: an unanswered
    // command there was indistinguishable from a dead Bot-API thread.
    // An *unrouted* topic gets explicit slash commands dispatched (so `/rm` and `/help` work
    // there) but not free text - including a topic whose row is only `dead`. Without that
    // narrowing, ordinary chatter in an unrelated forum topic, or a reply typed into a killed
    // session's topic, would fall through to the NL router and spend an LLM call answering
    // something no session can act on anyway.
    // A *known* command specifically, not merely a leading "/": anything else in an unrouted topic
    // would fall through to the NL router and spend an LLM call answering something no session can
    // act on. A topic this Bridge still has a row for is let through regardless of shape, so §4.3's
    // "this session has ended" acknowledgement can fire there.
    const knownRow = threadId !== undefined ? sessionStore.getByTopicId(threadId) : undefined;
    if (!isControl && !route && knownRow === undefined && !isKnownCommandText(message.text)) return;

    const from = message.from?.username ?? message.from?.first_name ?? "unknown";

    // §7.4, checked before *any* content branch below. It used to sit after the media handlers,
    // so every attachment path bypassed it: a document queued while the laptop slept, captioned
    // "yes, push it", was downloaded into the worktree and written straight into the live PTY on
    // resume - the exact surprise §7.4 exists to prevent, quoted almost word for word there.
    // Voice notes remain the one deliberate exception (their own confirm card, below).
    const nowMs = Date.now();
    // Only content this Bridge would actually act on is gated. Without that narrowing the `else`
    // branch below fired for every *service* message too (forum_topic_created/_edited,
    // pinned_message, new_chat_members) and for stickers/polls/locations, all of which previously
    // fell through to `if (!message.text) return` - so a backlog replay after downtime posted a
    // spurious "an attachment arrived while offline" notice for each one.
    const hasActionableContent = message.text !== undefined || hasAttachment(message);
    if (hasActionableContent && !message.voice && isStaleInbound(message.date, nowMs)) {
      if (message.text !== undefined) {
        fireAndForget(
          postStaleConfirm(threadId, message.message_id, message.text, from, formatStaleAge(message.date, nowMs), message),
          log,
          "inbound-media postStaleConfirm",
        );
      } else {
        // An attachment gets a plain notice rather than a replayable confirm card: replaying one
        // would mean holding its `file_id` and re-running the download later, and a re-send from
        // the phone is both cheaper and unambiguous. The point is that it isn't silently landed
        // in the worktree and announced to a live session.
        notifyStaleAttachment(threadId, formatStaleAge(message.date, nowMs));
      }
      return;
    }

    // Voice input - a recorded voice note, not a forwarded/uploaded audio file (message.audio,
    // unhandled). Goes through its own confirm-card path (handleVoiceMessage), and is the one
    // deliberate exemption from the §7.4 gate above: staleness of the *card* (voice-confirm.ts's
    // own TTL) is what matters, not staleness of when the note was recorded, because nothing
    // reaches the session until the operator taps Send on a transcript they can read.
    if (message.voice) {
      fireAndForget(handleVoiceMessage(message.voice, threadId, message.message_id, from, message.date, message), log, "inbound-media handleVoiceMessage");
      return;
    }

    // §5.6: photos/documents/videos/audio/video-notes - landed in the session's inbox and
    // announced by path rather than transcribed. `photo` arrives as one entry per resolution,
    // smallest to largest; the largest is the one worth downloading. Telegram allows a message
    // to carry at most one kind of media, so these are mutually exclusive with each other and
    // with `voice`/`text` above - order here doesn't matter beyond that.
    if (message.photo && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1]!;
      fireAndForget(
        handleAttachmentMessage("image", largest.file_id, largest.file_size, undefined, undefined, threadId, route, isControl, message.message_id, message.caption, from, message),
        log,
        "inbound-media handleAttachmentMessage(image)",
      );
      return;
    }
    if (message.document) {
      const doc = message.document;
      fireAndForget(
        handleAttachmentMessage("document", doc.file_id, doc.file_size, doc.file_name, doc.mime_type, threadId, route, isControl, message.message_id, message.caption, from, message),
        log,
        "inbound-media handleAttachmentMessage(document)",
      );
      return;
    }
    if (message.video) {
      const video = message.video;
      fireAndForget(
        handleAttachmentMessage("video", video.file_id, video.file_size, video.file_name, video.mime_type, threadId, route, isControl, message.message_id, message.caption, from, message),
        log,
        "inbound-media handleAttachmentMessage(video)",
      );
      return;
    }
    if (message.audio) {
      const audio = message.audio;
      fireAndForget(
        handleAttachmentMessage("audio", audio.file_id, audio.file_size, audio.file_name, audio.mime_type, threadId, route, isControl, message.message_id, message.caption, from, message),
        log,
        "inbound-media handleAttachmentMessage(audio)",
      );
      return;
    }
    if (message.video_note) {
      const note = message.video_note;
      fireAndForget(
        handleAttachmentMessage("video note", note.file_id, note.file_size, undefined, undefined, threadId, route, isControl, message.message_id, message.caption, from, message),
        log,
        "inbound-media handleAttachmentMessage(video note)",
      );
      return;
    }

    if (!message.text) return;

    // §7.4's gate already ran above, before any content branch - nothing below ever sees a stale
    // message.
    fireAndForget(
      dispatchInboundMessage(message.message_id, message.text, threadId, isControl, route, currentSlug, from, buildContextPrefix(message)),
      log,
      "inbound-media dispatchInboundMessage",
    );
  }

  return {
    postStaleConfirm,
    notifyStaleAttachment,
    handleVoiceMessage,
    handleAttachmentMessage,
    routeInboundMessage,
  };
}
