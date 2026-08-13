import { randomUUID } from "node:crypto";
import { renderAskInterruptedCard } from "./ask-callback.ts";
import { AskRegistry } from "./ask-registry.ts";
import { buildAttachmentAnnouncement, forgetInboxGitignoreCache, writeAttachmentToInbox } from "./attachment-inbox.ts";
import { CostTracker } from "./cost-tracker.ts";
import { cleanupDiffRefs } from "./diff-review.ts";
import { describeExecFailure, formatExecFailureForLog, formatExitClause } from "./exec-failure.ts";
import { autoConfirmKind, buildFleetConfirmKeyboard, FleetConfirmRegistry, type FleetBulkKind } from "./fleet-confirm.ts";
import type { AutoCategory, FleetCommand } from "./fleet-commands.ts";
import { AUTO_CATEGORIES, buildLsDetail, newSessionContent, renderAttach, renderLsTable } from "./fleet-commands.ts";
import { checkConcurrencyCap, WEIGHTED_CAP } from "./concurrency-cap.ts";
import { monotonicNowMs } from "./monotonic-clock.ts";
import { PermissionRegistry } from "./permission-registry.ts";
import type { ReposRegistry } from "./repos-registry.ts";
import { resolveRepoNameFuzzy } from "./repos-registry.ts";
import type { Routing } from "./routing.ts";
import { launchSession } from "./session-launcher.ts";
import { DEFAULT_EFFORT, ESCAPE, type Effort, type Mode } from "./session-commands.ts";
import type { PtyIo } from "./pty-io.ts";
import type { SessionSupervisor } from "./session-supervisor.ts";
import { SessionStore, type SessionRow, type SessionState } from "./session-store.ts";
import { slugFromPrompt, uniqueSlug } from "./slug.ts";
import { buildTopicDeepLink, type ForumTopicSource, type InlineKeyboardMarkup, type SendMessageSource } from "./telegram.ts";
import type { ThinkingPlaceholder } from "./thinking-placeholder.ts";
import { removeWorktree } from "./worktree.ts";
import type { VerdictBehavior } from "@aibridge/protocol";

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

/** Just the feed-wiring accessors this module actually calls - the full `FeedWiring` interface
 * carries a lot more that has nothing to do with session lifecycle. */
export interface SessionLifecycleFeedWiring {
  allFeedStates(): ReadonlyMap<string, { turnActive: boolean; turnStartedAtMs: number | null; lines: readonly { summary: string; status: string }[] }>;
  forgetSession(slug: string): void;
  /** `feed-wiring.ts`'s state write, guarded by §4.3's transition table. Needed here because
   * `/stop` has no hook event of its own to ride (see `handleStopCommand`) - and taken as the
   * guarded `maybeSetState` rather than `sessionStore.setState` specifically so `/stop` can't
   * write an edge §4.3 forbids, which is the one thing a direct write would let it do. */
  maybeSetState(slug: string, next: SessionState): void;
}

export interface SessionLifecycleCommandsOptions {
  sessionStore: SessionStore;
  routing: Routing;
  controlBot: SendMessageSource & ForumTopicSource;
  sessionSupervisor: SessionSupervisor;
  ptyIo: PtyIo;
  feedWiring: SessionLifecycleFeedWiring;
  permissionRegistry: PermissionRegistry;
  askRegistry: AskRegistry;
  costTracker: CostTracker;
  fleetConfirmRegistry: FleetConfirmRegistry;
  confirmSessionCommand: (topicId: number | undefined, text: string, parseMode?: "HTML", keyboard?: InlineKeyboardMarkup) => void;
  /** `pipeHandle.finalizePermissionMessage` (pipe-server.ts) - edits a permission/ask card's text
   * in place and strips its keyboard. Already used for two other stale-card cases (the TTL sweep's
   * "expired", an ask's own "cancelled" ceiling); `/stop` (`handleStopCommand`) is a third. */
  finalizePermissionMessage: (messageId: number, text: string) => Promise<void>;
  /** `pipeHandle.sendVerdict` - genuinely new for `/auto permission`'s drain, and deliberately not
   * shared with `handleStopCommand`, the only other consumer of the two options above: that command
   * sends no verdict at all (see its doc comment). Returns false when the slug has no live channel
   * server, which the drain must check - a verdict delivered to nothing, with the card already
   * edited to claim approval, is the one outcome worse than not draining. */
  sendVerdict: (slug: string, requestId: string, behavior: VerdictBehavior) => boolean;
  /** Injected rather than imported, same "not yet extracted, avoid a forward reference into a
   * sibling module's own future file" treatment as `dispatchInboundMessage` in inbound-media.ts -
   * `stopIndicatorsForTopic`/`postFleetConfirm`/`executeFleetActionDirect` are fleet-confirm-flow.ts
   * (item 11)'s own functions, still sitting in index.ts today. */
  stopIndicatorsForTopic: (topicId: number) => void;
  /** `nl-dispatch.ts`'s `routeOrFallback` leaves its "🤔 Thinking..." placeholder pending (not
   * deleted) when it matches a `new` command, specifically so `handleNewCommand` can clear it once
   * its own slower work (topic creation, worktree, PTY spawn) is actually done - see that module's
   * comment. A typed `/new` never started one, so `consume` resolving `undefined` there is the
   * normal, harmless case. */
  thinkingPlaceholder: ThinkingPlaceholder;
  postFleetConfirm: (kind: FleetBulkKind, topicId: number | undefined, targets: readonly SessionRow[], promptText: string) => Promise<void>;
  executeFleetActionDirect: (kind: "kill" | "rm", topicId: number | undefined, targets: readonly SessionRow[]) => Promise<void>;
  /** Composition-root function today (channelConnectCoordinator isn't owned by any extracted
   * module) - injected rather than imported to avoid reaching back into index.ts. */
  waitForChannelConnected: (slug: string, timeoutMs?: number) => Promise<void>;
  /** `pty-quiet-wait.ts`'s own doc comment has the full story: closes a third race
   * `waitForChannelConnected` doesn't - Claude Code can still be busy registering its *other* MCP
   * servers (Playwright in particular, cold-spawned on every brand-new worktree) when the aibridge
   * channel's own handshake has already resolved, and that startup chatter fools `pty-io.ts`'s
   * `confirmSubmitted` into reading a lost Enter as a landed one. Called once, right before the
   * first `sendChannelText` write below - never for any later turn, which has no such startup race. */
  waitForPtyQuiet: (slug: string) => Promise<void>;
  /** §4.1's control-topic predicate - same injection reasoning as inbound-media.ts's own copy of
   * this option: it's index.ts's one free top-level function today. */
  isControlTopic: (topicId: number | undefined) => boolean;
  /** Live getter, not a snapshot: `/repos add`/`/repos reload` (fleet-reporting-commands.ts, item 8)
   * reassign this `let` at runtime. */
  getReposRegistry: () => ReposRegistry | undefined;
  /** Live getters, not snapshots: `/defaultmode`/`/defaulteffort` (voice-mode-commands.ts, item 10)
   * reassign these `let`s at runtime - `handleNewCommand` must see the current value on every call. */
  getDefaultSessionMode: () => Mode;
  getDefaultSessionEffort: () => Effort;
  /** Live getters for the same reason as the two above - `/default permission|answer`
   * (voice-mode-commands.ts) reassigns these `let`s at runtime. A construction-time `boolean` here
   * would compile, persist and confirm, and then every session for the rest of that Bridge's
   * lifetime would still start without the setting, looking correct again after the next restart. */
  getDefaultBypassEnabled: () => boolean;
  getDefaultAutoAnswerEnabled: () => boolean;
  supergroupChatId: string;
  selfCheckSlug: string;
  fleetWorktreesRoot: string | undefined;
  otlpPort: number;
  log?: LogFn;
  /** Injectable clock, same convention as quota-alarms.ts. */
  now?: () => string;
}

export interface SessionLifecycleCommands {
  resolveTargetSlug(explicit: string | undefined, currentSlug: string | undefined): { slug: string } | { error: string };
  killSessionRow(row: SessionRow): Promise<void>;
  removeSessionRow(row: SessionRow): Promise<boolean>;
  postOrphanTopicRmConfirm(topicId: number): Promise<void>;
  handleNewCommand(cmd: Extract<FleetCommand, { kind: "new" }>, controlTopicId: number | undefined): Promise<void>;
  handleLsCommand(topicId: number | undefined): void;
  handleKillCommand(cmd: Extract<FleetCommand, { kind: "kill" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void>;
  handleRmCommand(cmd: Extract<FleetCommand, { kind: "rm" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void>;
  handleAttachCommand(cmd: Extract<FleetCommand, { kind: "attach" }>, topicId: number | undefined, currentSlug: string | undefined): void;
  handlePauseCommand(cmd: Extract<FleetCommand, { kind: "pause" }>, topicId: number | undefined, currentSlug: string | undefined): void;
  handleStopCommand(cmd: Extract<FleetCommand, { kind: "stop" }>, topicId: number | undefined, currentSlug: string | undefined): void;
  handleResumeCommand(cmd: Extract<FleetCommand, { kind: "resume" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void>;
  handleDetailCommand(cmd: Extract<FleetCommand, { kind: "detail" }>, topicId: number | undefined, currentSlug: string | undefined): void;
  handleVerboseCommand(cmd: Extract<FleetCommand, { kind: "verbose" }>, topicId: number | undefined, currentSlug: string | undefined): void;
  handleAutoCommand(cmd: Extract<FleetCommand, { kind: "auto" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void>;
  /** Called by `fleet-confirm-flow.ts`'s `--all` branch: that path must go through this, not
   * `routing.setBypass`, or the fleet-bulk form silently skips the drain. */
  applyAutoToggle(slug: string, category: AutoCategory, on: boolean): void;
}

/** §4.5.2's note appended to an `/rm` confirmation whenever `deleteForumTopic` failed above -
 * without this the operator only finds out days later, by eye, that a topic was left behind
 * (as happened live: two such orphans had accumulated with nothing pointing at them). Naming
 * `/rm` explicitly rather than just describing the fix, since that's the exact recovery step
 * (§4.5.2's `rm-topic` confirm below, keyed off the orphaned topic's own thread id). */
export const ORPHAN_TOPIC_NOTE = " (Telegram topic itself could not be deleted - send /remove inside it directly to clean it up)";

/** Extracted out of `handleNewCommand` so the pendingAttachment-after-launch logic (note text, log
 * line, `sourceText` override) is independently testable - `handleNewCommand` itself can't be, past
 * this point, without a real `launchSession` call (git worktree + PTY spawn), which isn't injectable
 * here (see this module's own test file for that boundary). `write` defaults to the real
 * `writeAttachmentToInbox`, overridable so a test can make it throw on demand without touching disk.
 *
 * Returns `saved` explicitly rather than leaving the caller to infer success from `note`'s emptiness
 * (code-review finding: two booleans - `cmd.pendingAttachment` truthiness and `!note` - had to stay
 * in sync for a downstream `if` to mean what its own comment claimed) - `saved` is `false` both when
 * there was nothing to save and when saving it failed, `true` only on an actual successful write. */
export async function applyPendingAttachment(
  cmd: Extract<FleetCommand, { kind: "new" }>,
  worktreePath: string,
  slug: string,
  log: LogFn,
  write: typeof writeAttachmentToInbox = writeAttachmentToInbox,
): Promise<{ cmd: Extract<FleetCommand, { kind: "new" }>; note: string; saved: boolean }> {
  if (!cmd.pendingAttachment) return { cmd, note: "", saved: false };
  const { kind, name, bytes, rawCaption } = cmd.pendingAttachment;
  try {
    const attachmentAbsPath = await write(worktreePath, name, bytes, log);
    return { cmd: { ...cmd, sourceText: buildAttachmentAnnouncement(kind, attachmentAbsPath, rawCaption ?? cmd.prompt) }, note: "", saved: true };
  } catch (err) {
    log("WARN", `failed to save the attachment for "${slug}" into its worktree: ${(err as Error).message}`);
    return { cmd, note: ` (couldn't save the attachment - ${(err as Error).message}; re-send it in this topic once it's open.)`, saved: false };
  }
}

export function createSessionLifecycleCommands(opts: SessionLifecycleCommandsOptions): SessionLifecycleCommands {
  const {
    sessionStore,
    routing,
    controlBot,
    sessionSupervisor,
    ptyIo,
    feedWiring,
    permissionRegistry,
    askRegistry,
    costTracker,
    fleetConfirmRegistry,
    confirmSessionCommand,
    finalizePermissionMessage,
    sendVerdict,
    stopIndicatorsForTopic,
    thinkingPlaceholder,
    postFleetConfirm,
    executeFleetActionDirect,
    waitForChannelConnected,
    waitForPtyQuiet,
    isControlTopic,
    getReposRegistry,
    getDefaultSessionMode,
    getDefaultSessionEffort,
    getDefaultBypassEnabled,
    getDefaultAutoAnswerEnabled,
    supergroupChatId,
    selfCheckSlug,
    fleetWorktreesRoot,
    otlpPort,
  } = opts;
  const log = opts.log ?? (() => {});
  const nowIso = opts.now ?? (() => new Date().toISOString());

  /** Fleet-lifecycle commands take an optional `<slug>`, falling back to "the session this
   * message's own topic belongs to" (§4.2: "`/kill` with no argument inside a session topic kills
   * that session"). Returns an error string for an unresolvable target rather than throwing. */
  function resolveTargetSlug(explicit: string | undefined, currentSlug: string | undefined): { slug: string } | { error: string } {
    const slug = explicit ?? currentSlug;
    if (!slug) return { error: "usage: <command> <slug> (or send it bare from inside that session's own topic)" };
    if (!sessionStore.get(slug)) return { error: `unknown slug "${slug}"` };
    return { slug };
  }

  /** The second half of `resolveSessionOrBail` below, factored out on its own so
   * `handleRmCommand`'s orphan-topic special case (which needs to see `resolveTargetSlug`'s error
   * *before* deciding whether to redirect into `postOrphanTopicRmConfirm`) can still reach a real,
   * checked row - not the `sessionStore.get(slug) as NonNullable<...>` cast this replaces, which
   * would crash instead of reporting a clear failure in the (rare, but real: a concurrent /rm) gap
   * between `resolveTargetSlug` confirming the slug exists and this lookup running. */
  function getRowOrReportMissing(slug: string, topicId: number | undefined): SessionRow | undefined {
    const row = sessionStore.get(slug);
    if (!row) confirmSessionCommand(topicId, `"${slug}" no longer exists.`);
    return row;
  }

  /** The shared "resolve slug or bail" helper - `resolveTargetSlug` plus the row lookup above was
   * repeated verbatim, cast and all, across six call sites (seven cast occurrences -
   * `handleVerboseCommand` needs the row twice). Returns the live row directly, or `undefined`
   * after already posting the resolution error itself - callers' only job on `undefined` is to
   * return. */
  function resolveSessionOrBail(explicit: string | undefined, currentSlug: string | undefined, topicId: number | undefined): SessionRow | undefined {
    const resolved = resolveTargetSlug(explicit, currentSlug);
    if ("error" in resolved) {
      confirmSessionCommand(topicId, resolved.error);
      return undefined;
    }
    return getRowOrReportMissing(resolved.slug, topicId);
  }

  /** The actual teardown `/kill` does for one row - shared by the single-slug form and the
   * `--all` confirm-button flow below, so the two can't drift. */
  async function killSessionRow(row: SessionRow): Promise<void> {
    const { slug } = row;
    sessionSupervisor.killAndUntrack(slug);
    routing.clearPtyWrite(slug);
    if (row.state !== "dead") sessionStore.setState(slug, "dead", nowIso());
    stopIndicatorsForTopic(row.topicId);

    try {
      await controlBot.closeForumTopic(supergroupChatId, row.topicId);
    } catch (err) {
      log("WARN", `closeForumTopic failed for "${slug}": ${(err as Error).message}`);
    }
  }

  /** The actual teardown `/rm` does for one row - shared by the single-slug form and the bulk
   * `--dead`/`--prefix` forms below, so the two can't drift. Returns whether the Telegram topic
   * itself was actually deleted - the DB row is removed either way (§4.5.2: a Telegram-side
   * failure here, e.g. `TOPIC_ID_INVALID`, shouldn't leave a zombie row behind), but callers use
   * this to tell the operator when a topic was left orphaned rather than silently succeeding. */
  async function removeSessionRow(row: SessionRow): Promise<boolean> {
    const { slug } = row;
    if (row.state !== "dead") {
      sessionSupervisor.getPtyProcess(slug)?.kill();
    }
    sessionSupervisor.untrack(slug);
    routing.clearPtyWrite(slug);
    stopIndicatorsForTopic(row.topicId);

    // Best-effort - must run before removeWorktree deletes the checkout `cleanupDiffRefs` needs as
    // its `cwd` to reach `origin` at all.
    cleanupDiffRefs(row.worktreePath, slug);

    try {
      await removeWorktree(row.repoPath, row.worktreePath);
    } catch (err) {
      log("WARN", `removeWorktree failed for "${slug}": ${(err as Error).message}`);
    }
    // attachment-inbox.ts's own doc comment on `commonDirByWorktree`: this path (always
    // `<worktreesRoot>/<slug>`) is about to be freed for `/new` to hand to an unrelated repo -
    // forget the cached common-dir mapping now, unconditionally, regardless of whether the
    // `removeWorktree` above actually succeeded (a failed removal still frees the slug/row below).
    forgetInboxGitignoreCache(row.worktreePath);
    let topicDeleted = true;
    try {
      await controlBot.deleteForumTopic(supergroupChatId, row.topicId);
    } catch (err) {
      topicDeleted = false;
      log("WARN", `deleteForumTopic failed for "${slug}": ${(err as Error).message}`);
    }

    sessionStore.remove(slug);
    routing.remove(slug);
    feedWiring.forgetSession(slug);
    return topicDeleted;
  }

  /** §4.5.2: posts the confirm card for deleting a Telegram topic that has no matching session
   * row at all - the `rm-topic` fleet-confirm variant. Unlike `postFleetConfirm`, there are no
   * `slugs` to show (there is nothing tracked for this topic), so the prompt just names the topic
   * by id. */
  async function postOrphanTopicRmConfirm(topicId: number): Promise<void> {
    const id = randomUUID().slice(0, 8);
    try {
      const sent = await controlBot.sendMessage(
        supergroupChatId,
        topicId,
        "This topic has no session tracked in the Bridge - delete this Telegram topic itself?",
        { inline_keyboard: buildFleetConfirmKeyboard("rm-topic", id) },
      );
      fleetConfirmRegistry.add({ id, kind: "rm-topic", slugs: [], topicId, messageId: sent.message_id });
    } catch (err) {
      log("WARN", `failed to post orphan-topic /rm confirmation: ${(err as Error).message}`);
    }
  }

  async function handleNewCommand(cmd0: Extract<FleetCommand, { kind: "new" }>, controlTopicId: number | undefined): Promise<void> {
    // Reassigned below, once the attachment (if any) is moved into the inbox and `sourceText` is
    // set - never before the topic-creation confirmation just under `topic` is created, which
    // must render the clean `cmd.prompt`, not an announcement string carrying a raw file path
    // (attachment-triggered-session-creation-plan.md's Attachment-to-Session Handoff section).
    let cmd = cmd0;
    // Every early `return` below happens before the attachment (if any) is ever written anywhere -
    // `cmd.pendingAttachment`'s bytes are only held in memory at this point and would otherwise be
    // silently discarded with no indication to the operator that resending the file, not just
    // fixing the repo name or freeing up fleet capacity, is required (code-review finding).
    const attachmentLostNote = cmd.pendingAttachment ? " The attachment you sent was not saved - resend it once this is fixed." : "";

    // nl-dispatch.ts's `routeOrFallback` leaves its "🤔 Thinking..." placeholder pending (rather than
    // deleting it right after the NL match) specifically for this function's own latency - topic
    // creation, worktree, PTY spawn. A typed `/new` never started one, so `consume` resolving
    // `undefined` here is the normal case and this is a no-op. Called once, right before every
    // terminal `confirmSessionCommand(controlTopicId, ...)` below, so the placeholder disappears in
    // the same beat the real outcome (success or error) lands, instead of sitting there for however
    // long the rest of this function takes after the NL match resolved.
    const controlTopicIdStr = controlTopicId !== undefined ? String(controlTopicId) : undefined;
    let placeholderCleared = false;
    async function clearThinkingPlaceholder(): Promise<void> {
      if (placeholderCleared || !controlTopicIdStr) return;
      placeholderCleared = true;
      const messageId = await thinkingPlaceholder.consume(controlTopicIdStr);
      if (messageId === undefined || !controlBot.deleteMessage) return;
      await controlBot.deleteMessage(supergroupChatId, messageId).catch((err: unknown) => log("WARN", `failed to delete /new thinking placeholder: ${(err as Error).message}`));
    }

    const reposRegistry = getReposRegistry();
    if (!reposRegistry) {
      await clearThinkingPlaceholder();
      confirmSessionCommand(controlTopicId, `No repos.toml registered yet - see §7.5.${attachmentLostNote}`);
      return;
    }
    let repo = reposRegistry.get(cmd.repo);
    if (!repo) {
      // Voice-transcribed /new commands routinely mangle the repo name ("aibridge" heard back as
      // "eI-Bridge") before it ever reaches this codebase - fall back to the single unambiguous
      // fuzzy match (see resolveRepoNameFuzzy's own doc comment) rather than failing outright.
      const fuzzy = resolveRepoNameFuzzy(reposRegistry.all(), cmd.repo);
      if (fuzzy) {
        repo = fuzzy;
        confirmSessionCommand(controlTopicId, `Unknown repo "${cmd.repo}" - using closest match "${fuzzy.name}".`);
      } else {
        await clearThinkingPlaceholder();
        confirmSessionCommand(controlTopicId, `Unknown repo "${cmd.repo}". Registered: ${reposRegistry.names().join(", ") || "(none)"}${attachmentLostNote}`);
        return;
      }
    }
    const model = cmd.model ?? repo.model ?? "sonnet";

    // §10.5 point 1: refuse before ever creating a topic/worktree, so a rejected /new leaves no
    // debris the way a launch failure further down deliberately cleans up after itself.
    const capCheck = checkConcurrencyCap(sessionStore.all(), model);
    if (!capCheck.ok) {
      await clearThinkingPlaceholder();
      confirmSessionCommand(
        controlTopicId,
        `Refused: the fleet is already at ${capCheck.current}/${WEIGHTED_CAP} weighted units - adding a ${model} session would bring it to ${capCheck.wouldBe}. Kill or /remove a session first.${attachmentLostNote}`,
      );
      return;
    }

    const base = slugFromPrompt(cmd.prompt);
    const slug = uniqueSlug(base, sessionStore.slugs());

    let topic: { message_thread_id: number };
    try {
      topic = await controlBot.createForumTopic(supergroupChatId, cmd.prompt.slice(0, 128));
    } catch (err) {
      await clearThinkingPlaceholder();
      confirmSessionCommand(controlTopicId, `Failed to create a topic for "${slug}": ${(err as Error).message}`);
      return;
    }

    // The topic's own title is truncated to 128 chars (Telegram's forum-topic-name limit) and the
    // actual delivery further below is a raw PTY keystroke into Claude's context, not a Telegram
    // post - so without this, the topic opened straight into Claude's tool-call feed with no visible
    // record of what was actually asked for. Posted as a plain message (not `confirmSessionCommand`,
    // which targets `controlTopicId`) since this belongs in the new topic itself.
    confirmSessionCommand(topic.message_thread_id, newSessionContent(cmd));

    // `/default mode`, applied as a launch flag instead of the post-launch Shift+Tab burst that never
    // actually landed (see `buildClaudeSpawnArgs`). Read exactly once, here, and reused for all three
    // places this value has to land (the launch flag below, the row's `mode` column, and
    // `routing.setMode` after the startup gates) - `getDefaultSessionMode` is a *live* getter, and
    // there are two `await`s between the insert and that `setMode`, so three separate reads let
    // `/default mode <x>` land in the control topic mid-startup and be recorded as this session's mode
    // while the session is actually running in whatever the launch flag captured. That divergence used
    // to be in-memory-only; it is persisted and re-applied at the next restart now (v0.24.0/v0.25.0),
    // which is what makes one read load-bearing rather than tidy. It also makes the code match what
    // the `routing.setMode` comment below already claims: the tracked value is what the session
    // actually started in.
    const sessionMode = getDefaultSessionMode();
    let session: ReturnType<typeof launchSession>;
    try {
      session = launchSession({
        slug,
        topicId: topic.message_thread_id,
        repoPath: repo.path,
        worktreesRoot: fleetWorktreesRoot,
        model,
        permissionMode: sessionMode,
        otlpPort,
        log,
      });
    } catch (err) {
      // P1-9: log before anything else in this branch. Until 2026-08-12 a failed launch was
      // reported to Telegram and nowhere else, so `bridge.log` held no record that a launch had
      // even been attempted - which is how a real incident (every `/new` failing at
      // `git worktree add`, cleared by a restart) ended with the cause still unknown. The repo path
      // and worktrees root are included because they are the two inputs a `git worktree add`
      // failure is most likely to be about, and neither appears in the error message.
      const failure = describeExecFailure(err);
      log(
        "ERROR",
        // `fleetWorktreesRoot` is genuinely optional (`launchSession` falls back to its own default),
        // and a line reading "worktrees root undefined" invites a hunt for a config bug that isn't
        // there - live-verified 2026-08-12, that is exactly what the first version printed.
        `launch failed for "${slug}" (repo ${repo.path}, worktrees root ${fleetWorktreesRoot ?? "launcher default"}): ${formatExecFailureForLog(failure)}`,
      );
      // A launch failure this late still leaves the topic already created above (Telegram has no
      // atomic "create topic + do the rest" call) - deleted here rather than left as an orphan with
      // no session row and therefore no slug for `/rm` to ever find, confirmed live 2026-08-03 when
      // a branch-name collision left exactly this kind of debris behind.
      try {
        await controlBot.deleteForumTopic(supergroupChatId, topic.message_thread_id);
      } catch (deleteErr) {
        log("WARN", `failed to clean up topic for "${slug}" after a failed launch: ${(deleteErr as Error).message}`);
      }
      await clearThinkingPlaceholder();
      confirmSessionCommand(
        controlTopicId,
        `Failed to launch session "${slug}": ${failure.message}${formatExitClause(failure)}${attachmentLostNote}`,
      );
      return;
    }

    // Attachment-triggered-session-creation-plan.md's Attachment-to-Session Handoff section: must
    // run strictly *after* the topic-creation confirmation above (which shows the clean `cmd.prompt`,
    // untouched) and *before* the PTY send further below (which must show the announcement). Runs
    // after `launchSession` rather than before it (as an earlier version of this did) because the
    // attachment now lands inside the session's own worktree (`attachment-inbox.ts`'s
    // `writeAttachmentToInbox`, moved there to dodge `settings.ts`'s `Read(~/**)` deny rule) - and
    // that worktree does not exist until `ensureWorktree` inside `launchSession` has already created
    // it. A failure here no longer tears the topic/session down: both are already live at this point
    // (worktree cut, PTY spawned), so the fix is to degrade gracefully - note the loss in the
    // confirmation and still send the plain prompt - rather than discard a session that otherwise
    // launched fine.
    const applied = await applyPendingAttachment(cmd, session.worktreePath, slug, log);
    cmd = applied.cmd;
    const attachmentNote = applied.note;

    // Operator-requested 2026-08-09: `applyPendingAttachment` above only ever puts the file on disk
    // and tells *Claude* where it is (a plain-text path typed into its terminal, never rendered as a
    // Telegram message per §5.6's own doc comment) - the operator who just sent it never sees it
    // again anywhere in the new topic. This is the purely-cosmetic mirror: best-effort, into the new
    // topic itself (not `controlTopicId` - it belongs with the session it was attached to), for the
    // operator's own visual reference. Never blocks or fails session creation - a delivery failure
    // here is a WARN, not a reason to touch `attachmentNote` (already finalized above) or retry.
    if (applied.saved && cmd.pendingAttachment) {
      const { kind, name, bytes } = cmd.pendingAttachment;
      try {
        if (kind === "image" && controlBot.sendPhotoFile) {
          await controlBot.sendPhotoFile(supergroupChatId, topic.message_thread_id, name, bytes);
        } else if (controlBot.sendDocumentFile) {
          await controlBot.sendDocumentFile(supergroupChatId, topic.message_thread_id, name, bytes);
        }
      } catch (err) {
        log("WARN", `failed to forward the attachment for "${slug}" into its new topic: ${(err as Error).message}`);
      }
    }

    routing.add({ slug, topicId: topic.message_thread_id, worktreePath: session.worktreePath });
    sessionSupervisor.wireSession(slug, session.ptyProcess, topic.message_thread_id, session.ready);

    sessionStore.insert({
      slug,
      topicId: topic.message_thread_id,
      sessionId: null,
      worktreePath: session.worktreePath,
      branch: session.branch,
      repoPath: repo.path,
      model,
      ptyPid: session.ptyProcess.pid ?? 0,
      state: "starting",
      turnCardMsg: null,
      thinkingPlaceholderMsg: null,
      paused: false,
      renamed: false,
      feedDetail: "compact",
      feedVerbose: false,
      // Both false at insert time regardless of `/default permission`/`/default answer` - the
      // `autoCategorySpec(...).set(...)` calls a few lines below run after this row exists and go
      // through `routing.setBypass`/`setAutoAnswer`, which write these columns through themselves.
      bypassPermission: false,
      autoAnswer: false,
      // The same value the spawn flag above actually used, not a re-read - see `sessionMode`'s own
      // note for why re-reading the live getter here would let the row disagree with the process.
      mode: sessionMode,
      createdUtc: nowIso(),
      lastEventUtc: nowIso(),
    });

    if (applied.saved) {
      // Distinct from a text-typed /new (attachment-triggered-session-creation-plan.md's
      // Observability note) - the only place this trigger source is recorded anywhere. Skipped when
      // the save itself failed - that path already logged its own WARN inside applyPendingAttachment.
      log("INFO", `session "${slug}" created from a control-topic attachment caption (${cmd.pendingAttachment!.kind})`);
    }

    // Deep-links straight into the new topic (buildTopicDeepLink's own doc comment) rather than
    // making the operator find it by hand in the topic list - a `url` button, so no round trip
    // through the Bridge and no callback-registry entry to track or ever expire.
    await clearThinkingPlaceholder();
    confirmSessionCommand(controlTopicId, `Created "${slug}" (${model}, ${repo.name}) in a new topic.${attachmentNote}`, undefined, {
      inline_keyboard: [[{ text: `↪️ Open "${slug}"`, url: buildTopicDeepLink(supergroupChatId, topic.message_thread_id) }]],
    });

    // Two independent gates, both real events rather than guessed delays: the dev-channels dialog
    // must be confirmed (`session.ready` - otherwise the write lands on the still-open dialog and
    // corrupts it, confirmed live 2026-08-04), and the channel server's own MCP handshake must have
    // completed (`waitForChannelConnected` - otherwise the write's trailing Enter can be silently
    // lost even with the dialog long since confirmed, also confirmed live 2026-08-04).
    await session.ready;
    await waitForChannelConnected(slug);
    // A third gate, closing the race the two above don't (`pty-quiet-wait.ts`'s own doc comment has
    // the full story, live-confirmed 2026-08-11): Claude Code can still be busy registering its
    // *other* MCP servers (Playwright's cold `npx` spawn on this brand-new worktree path, in
    // particular) even once the aibridge channel's own handshake above has resolved, and that
    // startup chatter is enough real PTY output to fool `confirmSubmitted` below into reading a lost
    // Enter as a landed one - leaving the very first message sitting typed but never submitted, with
    // no error anywhere and no hook ever firing to say so.
    await waitForPtyQuiet(slug);
    // `/default effort`: applied before the initial prompt, not after, so the very first turn
    // already runs under the configured default rather than starting at the CLI's own "medium" and
    // switching mid-turn. Silent (no confirmSessionCommand) - a second "Switched..." message here
    // would just be noise on top of the "Created ..." confirmation already sent above. Skipped when
    // it's still at the CLI's own spawn default rather than relying on the write being a harmless
    // no-op at that value, which is unverified for `/effort`.
    //
    // `/default mode` is NOT applied here any more - it's a `--permission-mode` launch flag now (see
    // the `launchSession` call above). Only the Bridge's own tracked value is set, so a later live
    // `/mode` switch cycles from where the session actually is; no keystroke is sent, because the
    // session already started in that mode.
    const defaultSessionEffort = getDefaultSessionEffort();
    routing.setMode(slug, sessionMode);
    if (defaultSessionEffort !== DEFAULT_EFFORT) ptyIo.sendEffortCommand(slug, defaultSessionEffort);
    // `/default permission`/`/default answer`: deliberately *not* the keystroke/typed-command
    // machinery its two neighbours above need. This state lives in `routing.ts`, on the Bridge side
    // of the relay - there is no CLI setting to drive and nothing to type into the PTY. `spec.set`
    // rather than `applyAutoToggle` for the same reason the plan gives: a session created seconds ago
    // has no already-posted permission card to drain.
    if (getDefaultBypassEnabled()) autoCategorySpec("permission").set(slug, true);
    if (getDefaultAutoAnswerEnabled()) autoCategorySpec("answer").set(slug, true);
    ptyIo.sendChannelText(slug, topic.message_thread_id, newSessionContent(cmd), "new-1", "telegram");
  }

  function handleLsCommand(topicId: number | undefined): void {
    const rows = sessionStore.all();
    const nowMs = Date.now();
    const costBySlug = new Map<string, number>();
    for (const row of rows) {
      if (row.sessionId) costBySlug.set(row.slug, costTracker.lifetimeSpend(row.sessionId));
    }
    const detailBySlug = buildLsDetail(rows, nowMs, monotonicNowMs(), feedWiring.allFeedStates(), permissionRegistry.all(), askRegistry.all());
    controlBot
      .sendMessage(supergroupChatId, topicId, renderLsTable(rows, nowMs, costBySlug, detailBySlug), undefined, "HTML")
      .catch((err) => log("WARN", `sendMessage (/ls) failed: ${(err as Error).message}`));
  }

  async function handleKillCommand(cmd: Extract<FleetCommand, { kind: "kill" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    if (cmd.all) {
      // Excludes selfCheckSlug the same way runStartupReconciliation already does (index.ts's
      // reconciliation filter) - it's the Bridge's own hardcoded dev/self-check session (a fixed
      // SELF_CHECK_TOPIC_ID from .env, always relaunched on the next restart regardless), not a real
      // operator-created session with its own discoverable Telegram topic, so a blanket "kill
      // everything" must not sweep it in.
      const targets = sessionStore.all().filter((r) => r.state !== "dead" && r.slug !== selfCheckSlug);
      if (cmd.force) {
        await executeFleetActionDirect("kill", topicId, targets);
        return;
      }
      await postFleetConfirm("kill", topicId, targets, `Kill ${targets.length} live session${targets.length === 1 ? "" : "s"}?`);
      return;
    }

    const row = resolveSessionOrBail(cmd.slug, currentSlug, topicId);
    if (!row) return;
    await killSessionRow(row);
    confirmSessionCommand(topicId, `Killed "${row.slug}". Worktree left in place - \`/remove ${row.slug}\` to remove it.`);
  }

  async function handleRmCommand(cmd: Extract<FleetCommand, { kind: "rm" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    // `--all` (added 2026-08-04) is the deliberate exception to the dead-only rule below - it can
    // remove live sessions too, so it goes through the same confirm-button flow as `/kill --all`
    // rather than executing on the same message (fleet-commands.ts's RmBulkFilter note).
    if (cmd.bulk?.mode === "all") {
      // Same exclusion as /kill --all just above (and runStartupReconciliation's own filter) -
      // selfCheckSlug is the Bridge's own hardcoded dev/self-check session, not a real
      // operator-created one, and removeSessionRow would delete its worktree and try to
      // deleteForumTopic against a hardcoded SELF_CHECK_TOPIC_ID that was never actually created via
      // createForumTopic in the first place.
      const targets = sessionStore.all().filter((r) => r.slug !== selfCheckSlug);
      if (cmd.force) {
        await executeFleetActionDirect("rm", topicId, targets);
        return;
      }
      await postFleetConfirm("rm", topicId, targets, `Remove ALL ${targets.length} session${targets.length === 1 ? "" : "s"} - worktrees and topics deleted, live ones killed first?`);
      return;
    }

    // §4.2's bulk cleanup (added 2026-08-04): always scoped to `dead` rows, regardless of which
    // filter matched, since a bulk command is exactly the kind of action a mistyped prefix
    // shouldn't be able to turn into an accidental mass-`/kill` of live sessions.
    if (cmd.bulk) {
      const targets = sessionStore
        .all()
        .filter((r) => r.state === "dead")
        .filter((r) => (cmd.bulk?.mode === "prefix" ? r.slug.startsWith(cmd.bulk.prefix) : true));
      if (targets.length === 0) {
        confirmSessionCommand(topicId, "No dead sessions matched - nothing removed.");
        return;
      }
      let allTopicsDeleted = true;
      for (const row of targets) {
        if (!(await removeSessionRow(row))) allTopicsDeleted = false;
      }
      confirmSessionCommand(
        topicId,
        `Removed ${targets.length} dead session${targets.length === 1 ? "" : "s"}: ${targets.map((r) => r.slug).join(", ")}${allTopicsDeleted ? "" : ORPHAN_TOPIC_NOTE}`,
      );
      return;
    }

    const resolved = resolveTargetSlug(cmd.slug, currentSlug);
    if ("error" in resolved) {
      // §4.5.2: a bare `/rm` with nothing to resolve to - if this is a real Telegram topic (not
      // the control topic itself) that just has no session row, it's very likely one of these
      // orphans (an earlier `deleteForumTopic` failure left the topic behind after its row was
      // already removed) rather than a plain usage mistake. Offer to delete the topic directly,
      // keyed off `topicId` alone, since there is nothing in the DB to look up for it.
      if (topicId !== undefined && !isControlTopic(topicId) && cmd.slug === undefined) {
        await postOrphanTopicRmConfirm(topicId);
        return;
      }
      confirmSessionCommand(topicId, resolved.error);
      return;
    }
    const row = getRowOrReportMissing(resolved.slug, topicId);
    if (!row) return;
    const topicDeleted = await removeSessionRow(row);
    confirmSessionCommand(topicId, `Removed "${row.slug}" - worktree and topic deleted.${topicDeleted ? "" : ORPHAN_TOPIC_NOTE}`);
  }

  function handleAttachCommand(cmd: Extract<FleetCommand, { kind: "attach" }>, topicId: number | undefined, currentSlug: string | undefined): void {
    const row = resolveSessionOrBail(cmd.slug, currentSlug, topicId);
    if (!row) return;
    const tail = routing.getOutputTail(row.slug) || "(no output captured yet)";
    confirmSessionCommand(topicId, renderAttach(row, tail), "HTML");
  }

  function handlePauseCommand(cmd: Extract<FleetCommand, { kind: "pause" }>, topicId: number | undefined, currentSlug: string | undefined): void {
    const row = resolveSessionOrBail(cmd.slug, currentSlug, topicId);
    if (!row) return;
    const next = !row.paused;
    sessionStore.setPaused(row.slug, next);
    // "Feed paused/resumed" (not bare "Paused"/"Resumed") - deliberately worded to avoid colliding
    // with `/resume`'s own "Session ... resumed." text below: this only mutes/unmutes Telegram feed
    // updates for the topic, it never touches the session's process the way `/resume` does.
    confirmSessionCommand(topicId, `Feed ${next ? "paused" : "resumed"} for "${row.slug}".`);
  }

  /**
   * `/stop [<slug>]`: interrupt whatever the session is doing mid-turn, the same Escape keystroke
   * the Claude Code TUI's own "stop" button sends - not `/kill`, which tears the whole session
   * down. Raw PTY write via `routing.getPtyWrite`, same "bypass `renderChannelTag` entirely"
   * mechanism `/model`/`/mode` already use (§4.2.1/§4.2.2), just without the trailing `\r` since
   * Escape is a control byte the TUI consumes immediately rather than a typed+submitted line.
   *
   * No ack comes back from the PTY (same as `/model`/`/mode`), so the keystroke write only confirms
   * that Escape was sent, not that a turn was actually in flight to interrupt - sending Escape to an
   * idle session is a harmless no-op.
   *
   * **This used to leave the state write to the hook pipeline**, on the reasoning that the
   * `working -> idle` transition is `Stop`/`StopFailure`'s job once Claude aborts the turn, and that
   * asserting it here would race that. Live-verified false on 2026-08-13, and the reason it survived
   * so long is that the premise is unfalsifiable from `bridge.log` alone (`maybeSetState` logs only
   * *successful* writes, so "no transition" and "rejected transition" look identical): **an
   * operator interrupt produces no `Stop`/`StopFailure` hook at all.** Two real sessions, both
   * measured:
   *   - `/stop` mid-turn (state `working`) - no hook event of any kind followed, and the row was
   *     still `working` minutes later.
   *   - `/stop` while `awaiting_input` on a permission card - the row stayed `awaiting_input` for
   *     the ~3 minutes between the interrupt clearing the last pending prompt and an unrelated
   *     operator message happening to arrive and drag it to `working`. `/ls` reported
   *     "waiting: reply" throughout, for a session waiting on nothing.
   *
   * So there was never a hook to wait for, and P1-11's new `awaiting_input -> idle` edge alone
   * didn't help: an edge is only reachable if something crosses it. The resting state is asserted
   * here instead, which is also what finally gives that edge a caller. Same class of fix as P1-11's
   * three `onResolved` call sites - when the Bridge is the one that acted, the Bridge says so
   * rather than hoping a hook will infer it.
   *
   * Gated on the two states an interrupt can actually be interrupting rather than written
   * unconditionally: `quota_stopped -> idle` is a legal edge, so an Escape sent to a rate-limited
   * session would otherwise erase the one signal §10.5's alarms and `/ls` key on, and a `starting`
   * session would be claimed idle before its `SessionStart` ever landed.
   *
   * The old comment's "asserting it here would race the hook" concern is real but points the other
   * way once measured. There is no hook to race; the only race left is an Escape that fails to
   * interrupt (no PTY write registered, or a turn already past the interruptible point), which
   * leaves the row claiming `idle` while the turn runs on. That lie is bounded by the turn - the
   * turn's own `Stop` writes `idle` again, a no-op - and self-corrects, where the behavior it
   * replaces was a wrong state that persisted until the operator happened to send another message.
   * It is also the same case in which `/stop` did nothing at all, so the row is wrong about a
   * command that was already a no-op.
   *
   * DOES clear `permissionRegistry`/`askRegistry` entries for this slug, unlike `sessionStore`
   * above - live-verified 2026-08-09: interrupting a session mid-tool-call abandons the call
   * outright, so a still-pending permission/ask for it never resolves through either registry's
   * normal path (an operator button tap, an at-terminal answer, or an answered question) and would
   * otherwise sit there until its own TTL/cancel sweep, with `/ls` misreporting `awaiting_input`
   * and Telegram's own Allow/Deny buttons staying up over a request Claude has already dropped.
   * Only mentioned in the confirmation when something was actually cleared, so the common case
   * (no ask/permission was pending) doesn't grow the reply for no reason.
   *
   * Also edits each cleared entry's own Telegram card in place (added 2026-08-09) - §6.5's "a
   * stale button must never look tappable and silently do nothing" rule, already applied to the
   * TTL sweep's naturally-expired cards and to a cancelled ask's ceiling; leaving a `/stop`-cleared
   * card's live Allow/Deny/question buttons up would be the one inconsistent exception.
   * `finalizePermissionMessage` failures are logged, not thrown - a Telegram edit failing must never
   * stop the stop from having happened.
   *
   * The two registries are **not** symmetric about verdicts, which the 2026-08-09 "no verdict is
   * needed" note got wrong by generalizing from one to the other. An **ask** blocks a hook client,
   * and Claude's own interrupt handling does release it - confirmed 2026-08-13, no `aibridge-hook`
   * process survives a `/stop` over a live question card - so clearing the ask registry is genuinely
   * display-only. A **permission** blocks inside the session's own channel server instead, which
   * only a verdict over the pipe can release, so that half sends one (below).
   */
  function handleStopCommand(cmd: Extract<FleetCommand, { kind: "stop" }>, topicId: number | undefined, currentSlug: string | undefined): void {
    const row = resolveSessionOrBail(cmd.slug, currentSlug, topicId);
    if (!row) return;
    routing.getPtyWrite(row.slug)?.(ESCAPE);

    // The abandoned turn's typing indicator and "Thinking..." placeholder are the operator's only
    // visual cue that something is still in flight, and with no `Stop` hook coming (see above)
    // nothing else ever clears them - live-observed alongside the stranded row, a placeholder left
    // spinning on a turn that had already been interrupted. Same call `/kill` and `/rm` make for the
    // same reason. Unconditional, unlike the state write below: this is display-only cleanup, and a
    // stale indicator on an already-idle session is exactly as worth clearing.
    stopIndicatorsForTopic(row.topicId);

    const clearedPermissions = permissionRegistry.removeForSlug(row.slug);
    for (const entry of clearedPermissions) {
      // Send the same `deny` the TTL sweep sends, for the same reason it sends one (§6.5): removing
      // the entry without a verdict leaves *nothing* able to answer that request ever again -
      // `sweepExpiredPermissions` iterates the registry this just emptied, and the card's buttons
      // are about to be stripped. Escape does not cover it: a permission request blocks inside the
      // session's own channel server, not in a hook client, and only a verdict over the pipe
      // releases it. Measured 2026-08-13 - a `/stop` over a permission card, then nothing sent to
      // the session at all, produced total silence for 8 minutes; a sibling session `/stop`ped the
      // same way only emitted its abandoned call's `PostToolUse` once an unrelated operator message
      // arrived ~3 minutes later. `deny` rather than `allow` because the operator just asked for the
      // session to stop - the one verdict that cannot surprise them is the one that runs nothing.
      if (!sendVerdict(row.slug, entry.requestId, "deny")) {
        log("WARN", `/stop: no live channel for "${row.slug}", ${entry.toolName}'s pending permission left unanswered`);
      }
      finalizePermissionMessage(entry.messageId, `🛑 interrupted: ${entry.toolName} (session was stopped before this was answered)`).catch((err) =>
        log("WARN", `failed to mark permission as interrupted for "${row.slug}": ${(err as Error).message}`),
      );
    }

    const clearedAsks = askRegistry.removeForSlug(row.slug);
    let clearedQuestions = 0;
    for (const entry of clearedAsks) {
      for (const q of entry.questions) {
        if (q.answerLabel !== undefined) continue; // already answered - nothing stale to edit
        clearedQuestions++;
        finalizePermissionMessage(q.messageId, renderAskInterruptedCard(entry.slug, q.question, q.header)).catch((err) =>
          log("WARN", `failed to mark question as interrupted for "${row.slug}": ${(err as Error).message}`),
        );
      }
    }

    if (row.state === "working" || row.state === "awaiting_input") feedWiring.maybeSetState(row.slug, "idle");

    const cleared = clearedPermissions.length + clearedQuestions;
    const clearedNote = cleared > 0 ? ` (cleared ${cleared} stale pending prompt${cleared === 1 ? "" : "s"})` : "";
    confirmSessionCommand(topicId, `Sent stop to "${row.slug}".${clearedNote}`);
  }

  /**
   * `/resume [<slug>]`: the manual counterpart to `/stop`'s "how do I continue after this" gap
   * (2026-08-10 operator request - see the plan's changelog for the analysis this implements).
   *
   * `/stop` never kills the process - it only sends Escape (see `handleStopCommand`'s own doc
   * comment), so a `/stop`ped session has nothing to "resume" at the process level at all; the next
   * message sent into its topic is delivered to the still-live PTY exactly as it always would be.
   * `/resume` therefore only ever does real work for a `dead` row - one that was `/kill`ed, crashed
   * and exhausted its auto-resume attempts (`session-supervisor.ts`'s `MAX_CONSECUTIVE_RESUME_ATTEMPTS`),
   * or otherwise ended - by manually invoking the exact same `sessionSupervisor.resumeSession` the
   * crash-resume path (§4.5) already uses on a Bridge restart or an unexpected PTY exit: relaunches
   * `claude --resume <session_id>` on the row's preserved worktree, rewires the PTY, and re-adds the
   * routing entry. Every hazard that already applies there (a stale `session_id` failing outright, a
   * `/rm` racing the relaunch) applies identically here - `resumeSession` re-reads the row from the
   * store as its first step for exactly that reason, so this doesn't need its own copy of that guard.
   *
   * For anything short of `dead`, there is nothing to relaunch - reported as a no-op rather than
   * silently doing nothing, so an operator who reaches for `/resume` out of habit right after `/stop`
   * gets pointed at the actual fix (just send a message) instead of wondering whether the command
   * did anything. `quota_stopped` gets its own wording: the process is alive and expected to recover
   * on its own once the usage window resets (`quota-alarms.ts`'s `markQuotaStopped`), not something
   * `/resume` needs to (or can usefully) intervene on.
   */
  async function handleResumeCommand(cmd: Extract<FleetCommand, { kind: "resume" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    // `--all` (2026-08-12 operator request, after a Bridge restart left multiple sessions dead at
    // once with no bulk recovery path - `/resume <slug>` one at a time was the only option). Scoped
    // to `dead` rows only, same exclusion as `/kill --all`/`/rm --all`'s own selfCheckSlug note -
    // unlike those, there is nothing *live* a bulk resume could touch by mistake (the single-slug
    // branch below already no-ops on anything that isn't `dead`), so this executes immediately with
    // no confirm card, the same reasoning `/remove --dead`/`--prefix` already use.
    if (cmd.all) {
      const deadRows = sessionStore.all().filter((r) => r.state === "dead" && r.slug !== selfCheckSlug);
      if (deadRows.length === 0) {
        confirmSessionCommand(topicId, "No dead sessions to resume.");
        return;
      }
      // Reap before resuming (live-confirmed 2026-08-12): a row surviving from before a Telegram
      // topic was deleted has nowhere to receive `resumeSession`'s own confirmation - every send
      // into it fails with Telegram's "message thread not found", silently, and the operator sees
      // no explanation for why that one slug never showed up. `reapRowsWithDeletedTopics` already
      // does exactly this probe-and-notify (§4.5, shared with boot reconciliation) - reusing it here
      // means a deleted topic gets the same "marked dead, worktree preserved" notice on the control
      // topic instead of three retried sends nobody ever sees.
      const targets = await sessionSupervisor.reapRowsWithDeletedTopics(deadRows);
      const reapedCount = deadRows.length - targets.length;
      if (targets.length === 0) {
        confirmSessionCommand(
          topicId,
          `${reapedCount} dead session${reapedCount === 1 ? "" : "s"} could not be resumed - ${reapedCount === 1 ? "its" : "their"} Telegram topic no longer exists (see the notice${reapedCount === 1 ? "" : "s"} above).`,
        );
        return;
      }
      for (const target of targets) {
        // Sequential, not parallel - same precedent as `/rm --dead`'s bulk loop just above. Each
        // call re-reads its own row fresh (`resumeSession`'s first step) and `manuallyRequested`
        // bypasses its dead-guard the same way the single-slug branch below does - see that branch's
        // own comment for why that guard doesn't apply here.
        await sessionSupervisor.resumeSession(target, { manuallyRequested: true });
      }
      const reapedNote = reapedCount > 0 ? ` (${reapedCount} more had a deleted topic and couldn't be - see the notice${reapedCount === 1 ? "" : "s"} above)` : "";
      confirmSessionCommand(
        topicId,
        `Resumed ${targets.length} dead session${targets.length === 1 ? "" : "s"}: ${targets.map((r) => r.slug).join(", ")}${reapedNote}. Watch each one's own topic for a "couldn't resume" notice if its conversation transcript wasn't recoverable.`,
      );
      return;
    }

    const row = resolveSessionOrBail(cmd.slug, currentSlug, topicId);
    if (!row) return;
    if (row.state === "quota_stopped") {
      confirmSessionCommand(topicId, `"${row.slug}" is still alive - it's paused on a usage limit and should resume on its own once the window resets, nothing to /resume.`);
      return;
    }
    if (row.state !== "dead") {
      confirmSessionCommand(topicId, `"${row.slug}" is still running - just send it a message to continue (a /stop interrupt leaves the process alive).`);
      return;
    }
    // Same deleted-topic probe as the `--all` branch above, for the single-slug path - without it,
    // `/resume <slug>` on a row whose topic is gone just silently fails to post anything into that
    // (nonexistent) topic, leaving the operator watching a command that looks like it did nothing.
    const [survivor] = await sessionSupervisor.reapRowsWithDeletedTopics([row]);
    if (!survivor) return;
    // `manuallyRequested: true` - `row.state === "dead"` here is the whole reason /resume was
    // invoked, not a race for `resumeSession`'s own dead-guard to catch (see its doc comment: that
    // guard is for the crash-backoff/reconciliation callers, which capture a non-dead row before
    // doing async work). Omitting this silently no-ops every manual /resume (live-confirmed bug,
    // 2026-08-11).
    await sessionSupervisor.resumeSession(survivor, { manuallyRequested: true });
  }

  /**
   * §5.9's `/detail [<slug>] [compact|full]`: how much of each tool call the feed card shows for
   * this one session - "full" wraps each line's untruncated input in a `<blockquote expandable>`
   * instead of the 80-char one-liner; no argument reports the current setting rather than
   * changing anything, same "bare = status" convention as `/autostart`.
   */
  function handleDetailCommand(cmd: Extract<FleetCommand, { kind: "detail" }>, topicId: number | undefined, currentSlug: string | undefined): void {
    const row = resolveSessionOrBail(cmd.slug, currentSlug, topicId);
    if (!row) return;
    if (!cmd.level) {
      confirmSessionCommand(topicId, `"${row.slug}" feed detail: ${row.feedDetail}.`);
      return;
    }
    sessionStore.setFeedDetail(row.slug, cmd.level);
    confirmSessionCommand(topicId, `"${row.slug}" feed detail set to ${cmd.level}.`);
  }

  /**
   * §5.9's `/verbose [<slug>] [on|off]`: whether the feed also shows a tool's actual output, not
   * just what it was asked to do - default off, since real tool output can carry arbitrary file
   * content (the same §8.2 concern §5.3 already truncates for), and only visible at all once
   * `/detail` is `full`.
   */
  function handleVerboseCommand(cmd: Extract<FleetCommand, { kind: "verbose" }>, topicId: number | undefined, currentSlug: string | undefined): void {
    const row = resolveSessionOrBail(cmd.slug, currentSlug, topicId);
    if (!row) return;
    if (cmd.on === undefined) {
      confirmSessionCommand(topicId, `"${row.slug}" verbose tool output: ${row.feedVerbose ? "on" : "off"}.`);
      return;
    }
    sessionStore.setFeedVerbose(row.slug, cmd.on);
    // `row` is a snapshot from before the mutation above - re-read rather than trusting its stale
    // `feedDetail` for the no-effect-yet note below.
    const updated = sessionStore.get(row.slug) ?? row;
    const noEffectNote = cmd.on && updated.feedDetail !== "full" ? ` (no effect until /detail full is also set for "${row.slug}")` : "";
    confirmSessionCommand(topicId, `"${row.slug}" verbose tool output set to ${cmd.on ? "on" : "off"}.${noEffectNote}`);
  }

  /**
   * `/auto <category>`'s per-category differences, resolved once (bypass-and-autoanswer-plan.md
   * §0.2). The *only* place the categories are enumerated: `handleAutoCommand`'s scope tree and
   * `applyAutoToggle` both read this descriptor rather than switching again, so a future third
   * category fails to compile at one `never` arm instead of silently landing in someone's `else`.
   *
   * That indirection is not decoration. Four review passes over this feature's plan found nine
   * instances of the same defect - a two-way branch quietly absorbing a third case - and twice the
   * proposed fix was "add another exhaustive switch", after which the next pass found a site the
   * enumeration had missed. A guarantee spread over N sites is only as good as remembering all N.
   */
  interface AutoCategorySpec {
    readonly label: string;
    readonly get: (slug: string) => boolean;
    readonly set: (slug: string, on: boolean) => void;
    /** Whether turning this category ON drains that session's already-pending escalations.
     * `permission` does; `answer` deliberately does not - draining a pending question would answer
     * it on the operator's behalf with an option they never saw, which (unlike a permission verdict)
     * is not obviously the one they'd have picked. */
    readonly drainsOnEnable: boolean;
    readonly confirmation: (slug: string, on: boolean) => string;
    /** The `--all` confirm card's own prompt (§0.3). The slug list is appended by
     * `postFleetConfirm`, same as `/kill --all`'s. Only ever reached with an explicit on/off - a
     * bare `--all` reports fleet status and never posts a card. */
    readonly bulkPrompt: (on: boolean) => string;
  }

  function autoCategorySpec(category: AutoCategory): AutoCategorySpec {
    switch (category) {
      case "permission":
        return {
          label: "Auto-permission",
          get: (slug) => routing.getBypass(slug),
          set: (slug, on) => routing.setBypass(slug, on),
          drainsOnEnable: true,
          confirmation: (slug, on) =>
            on
              ? `🔓 Auto-permission is now ON for "${slug}" - every permission prompt this session would raise, including git commit/push, PR merge/create, and npm publish, is auto-allowed with no Telegram prompt. The deny list (force-push, secret reads, rm -rf /) still hard-blocks regardless - this cannot bypass that. This persists across a Bridge restart - /auto permission off to revert.`
              : `Auto-permission is now off for "${slug}" - permission prompts resume as normal.`,
          bulkPrompt: (on) =>
            on
              ? "⚠️ Turn auto-permission ON for every live session? This auto-allows ALL permission prompts (including git commit/push) with no further Telegram confirmation, for:"
              : "Turn auto-permission OFF for every live session? Permission prompts resume as normal for:",
        };
      case "answer":
        return {
          label: "Auto-answer",
          get: (slug) => routing.getAutoAnswer(slug),
          set: (slug, on) => routing.setAutoAnswer(slug, on),
          drainsOnEnable: false,
          confirmation: (slug, on) =>
            on
              ? `🔓 Auto-answer is now ON for "${slug}" - when Claude marks exactly one option as its recommendation, that question is answered automatically with no card posted. You still get the real buttons whenever there's no clear recommendation, or whenever one of the other options looks like "investigate/verify/hold off first" - those are yours to choose, never auto-picked. /auto answer off to revert.`
              : `Auto-answer is now off for "${slug}" - questions show you the real buttons again.`,
          bulkPrompt: (on) =>
            on
              ? "⚠️ Turn auto-answer ON for every live session? Questions where Claude marked exactly one option as recommended are answered automatically, with no card posted, for:"
              : "Turn auto-answer OFF for every live session? Questions show you the real buttons again for:",
        };
      default: {
        const _exhaustive: never = category;
        throw new Error(`unhandled /auto category: ${_exhaustive}`);
      }
    }
  }

  /**
   * The common way to discover you want auto-permission is to be looking at a card you don't want to
   * tap - so turning it on drains what's already pending rather than only affecting future requests.
   *
   * Unlike `handleStopCommand`'s superficially similar loop, this **must** send a verdict:
   * `/stop` writes an ESCAPE first, so Claude's own interrupt handling has already unblocked the
   * waiting hook client and there is nothing left for a verdict to reach. Nothing is interrupted
   * here. Popping the entry and editing its card without sending one would leave no recovery path at
   * all - `sweepExpiredPermissions` iterates the registry this just emptied, so the session would
   * hang forever on a card claiming it was approved.
   *
   * That first sentence was **wrong for permissions**, and `handleStopCommand` now sends a verdict
   * of its own - see its own comment. Both that claim and its (also corrected) "the hook pipeline
   * will move the row" sibling came out of the same 2026-08-09 live session, and both turned out to
   * generalize from the ask path, where the blocked party really is a hook client an Escape
   * releases, to the permission path, where it is the session's own channel server and only a
   * verdict releases it. What still distinguishes this function is the second half: nothing is
   * interrupted here, so `allow` is the right verdict, where `/stop` sends `deny`.
   */
  function drainPendingPermissions(slug: string): void {
    for (const entry of permissionRegistry.removeForSlug(slug)) {
      // Verdict first, then finalize - the reverse of the auto-approve notice's ordering in
      // pipe-server.ts, and for the opposite reason: this card edit is a terminal marker whose text
      // depends on whether the verdict actually reached anything, so it can't be written first
      // without guessing.
      const delivered = sendVerdict(slug, entry.requestId, "allow");
      if (!delivered) log("WARN", `auto-permission drain: no live channel for "${slug}", ${entry.toolName} left unapproved`);
      const text = delivered
        ? `🔓 auto-approved: ${entry.toolName} (auto-permission was turned on)`
        : `⚠️ auto-permission is on, but this request couldn't be auto-approved: the session's channel is disconnected. Re-send the tool call once it's back.`;
      finalizePermissionMessage(entry.messageId, text).catch((err) => log("WARN", `failed to finalize auto-approved permission for "${slug}": ${(err as Error).message}`));
    }
  }

  /** Set + drain, in that order - the only supported way to change either toggle for a live session.
   * A bare `spec.set` call skips the drain and leaves already-posted cards wedged forever. */
  function applyAutoToggle(slug: string, category: AutoCategory, on: boolean): void {
    const spec = autoCategorySpec(category);
    spec.set(slug, on);
    if (on && spec.drainsOnEnable) drainPendingPermissions(slug);
  }

  /**
   * `/auto <category> --all` with no on/off value: one line per live session showing *both*
   * categories, not just the one asked about. This is the reports-status form (§0.3) - a bare `--all`
   * must never reach the confirm card, whose kind carries the value and whose prompt is a fixed
   * string saying ON; a card built from `undefined` would say one thing and, via a falsy coercion at
   * the Yes button, do the opposite fleet-wide.
   *
   * It also closes the only real observability gap this deliberately in-memory design otherwise has:
   * there is no `/ls` column for either flag and no other way to ask "which sessions have this on?".
   */
  function renderAutoFleetStatus(rows: readonly SessionRow[]): string {
    if (rows.length === 0) return "No live sessions.";
    const lines = rows.map((row) => `${row.slug}: ${AUTO_CATEGORIES.map((category) => `${category} ${autoCategorySpec(category).get(row.slug) ? "on" : "off"}`).join(", ")}`);
    return [`Auto-resolve settings for ${rows.length} live session${rows.length === 1 ? "" : "s"}:`, ...lines].join("\n");
  }

  /**
   * `/auto <permission|answer> [<slug>|--all] [on|off]` - dispatches on *scope*, with the category
   * resolved once through `autoCategorySpec`. All three scopes are category-agnostic, so splitting
   * by category first would mean writing the whole tree twice.
   */
  async function handleAutoCommand(cmd: Extract<FleetCommand, { kind: "auto" }>, topicId: number | undefined, currentSlug: string | undefined): Promise<void> {
    const spec = autoCategorySpec(cmd.category);

    if (cmd.all) {
      // Same `selfCheckSlug` exclusion `/kill --all`/`/rm --all` already apply, and the same
      // live-only filter: the Bridge's own hardcoded dev/self-check session isn't an
      // operator-created one, and a dead session has no escalations left to auto-resolve.
      const targets = sessionStore.all().filter((r) => r.state !== "dead" && r.slug !== selfCheckSlug);
      if (cmd.on === undefined) {
        confirmSessionCommand(topicId, renderAutoFleetStatus(targets));
        return;
      }
      await postFleetConfirm(autoConfirmKind(cmd.category, cmd.on), topicId, targets, spec.bulkPrompt(cmd.on));
      return;
    }

    const row = resolveSessionOrBail(cmd.slug, currentSlug, topicId);
    if (!row) return;

    // Bare = reports status, never toggles. A status read must not flip a safety gate.
    if (cmd.on === undefined) {
      confirmSessionCommand(topicId, `"${row.slug}" ${spec.label.toLowerCase()}: ${spec.get(row.slug) ? "on" : "off"}.`);
      return;
    }

    applyAutoToggle(row.slug, cmd.category, cmd.on);
    confirmSessionCommand(topicId, spec.confirmation(row.slug, cmd.on));
  }

  return {
    resolveTargetSlug,
    killSessionRow,
    removeSessionRow,
    postOrphanTopicRmConfirm,
    handleNewCommand,
    handleLsCommand,
    handleKillCommand,
    handleRmCommand,
    handleAttachCommand,
    handlePauseCommand,
    handleStopCommand,
    handleResumeCommand,
    handleDetailCommand,
    handleVerboseCommand,
    handleAutoCommand,
    applyAutoToggle,
  };
}
