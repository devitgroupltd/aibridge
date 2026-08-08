import { randomUUID } from "node:crypto";
import { AskRegistry } from "./ask-registry.ts";
import { CostTracker } from "./cost-tracker.ts";
import { cleanupDiffRefs } from "./diff-review.ts";
import { buildFleetConfirmKeyboard, FleetConfirmRegistry } from "./fleet-confirm.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import { buildLsDetail, newSessionContent, renderAttach, renderLsTable } from "./fleet-commands.ts";
import { checkConcurrencyCap, WEIGHTED_CAP } from "./concurrency-cap.ts";
import { monotonicNowMs } from "./monotonic-clock.ts";
import { PermissionRegistry } from "./permission-registry.ts";
import type { ReposRegistry } from "./repos-registry.ts";
import { resolveRepoNameFuzzy } from "./repos-registry.ts";
import type { Routing } from "./routing.ts";
import { launchSession } from "./session-launcher.ts";
import { DEFAULT_EFFORT, DEFAULT_MODE, type Effort, type Mode } from "./session-commands.ts";
import type { PtyIo } from "./pty-io.ts";
import type { SessionSupervisor } from "./session-supervisor.ts";
import { SessionStore, type SessionRow } from "./session-store.ts";
import { slugFromPrompt, uniqueSlug } from "./slug.ts";
import { buildTopicDeepLink, type ForumTopicSource, type InlineKeyboardMarkup, type SendMessageSource } from "./telegram.ts";
import { removeWorktree } from "./worktree.ts";

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

/** Just the two feed-wiring accessors this module actually calls - the full `FeedWiring` interface
 * carries a lot more that has nothing to do with session lifecycle. */
export interface SessionLifecycleFeedWiring {
  allFeedStates(): ReadonlyMap<string, { turnActive: boolean; turnStartedAtMs: number | null; lines: readonly { summary: string; status: string }[] }>;
  forgetSession(slug: string): void;
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
  /** Injected rather than imported, same "not yet extracted, avoid a forward reference into a
   * sibling module's own future file" treatment as `dispatchInboundMessage` in inbound-media.ts -
   * `stopIndicatorsForTopic`/`postFleetConfirm`/`executeFleetActionDirect` are fleet-confirm-flow.ts
   * (item 11)'s own functions, still sitting in index.ts today. */
  stopIndicatorsForTopic: (topicId: number) => void;
  postFleetConfirm: (kind: "kill" | "rm", topicId: number | undefined, targets: readonly SessionRow[], promptText: string) => Promise<void>;
  executeFleetActionDirect: (kind: "kill" | "rm", topicId: number | undefined, targets: readonly SessionRow[]) => Promise<void>;
  /** voice-mode-commands.ts (item 10)'s own function - injected for the same reason. */
  writeModeKeystrokes: (slug: string, mode: Mode) => void;
  /** Composition-root function today (channelConnectCoordinator isn't owned by any extracted
   * module) - injected rather than imported to avoid reaching back into index.ts. */
  waitForChannelConnected: (slug: string, timeoutMs?: number) => Promise<void>;
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
  handleDetailCommand(cmd: Extract<FleetCommand, { kind: "detail" }>, topicId: number | undefined, currentSlug: string | undefined): void;
  handleVerboseCommand(cmd: Extract<FleetCommand, { kind: "verbose" }>, topicId: number | undefined, currentSlug: string | undefined): void;
}

/** §4.5.2's note appended to an `/rm` confirmation whenever `deleteForumTopic` failed above -
 * without this the operator only finds out days later, by eye, that a topic was left behind
 * (as happened live: two such orphans had accumulated with nothing pointing at them). Naming
 * `/rm` explicitly rather than just describing the fix, since that's the exact recovery step
 * (§4.5.2's `rm-topic` confirm below, keyed off the orphaned topic's own thread id). */
export const ORPHAN_TOPIC_NOTE = " (Telegram topic itself could not be deleted - send /rm inside it directly to clean it up)";

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
    stopIndicatorsForTopic,
    postFleetConfirm,
    executeFleetActionDirect,
    writeModeKeystrokes,
    waitForChannelConnected,
    isControlTopic,
    getReposRegistry,
    getDefaultSessionMode,
    getDefaultSessionEffort,
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

  async function handleNewCommand(cmd: Extract<FleetCommand, { kind: "new" }>, controlTopicId: number | undefined): Promise<void> {
    const reposRegistry = getReposRegistry();
    if (!reposRegistry) {
      confirmSessionCommand(controlTopicId, "No repos.toml registered yet - see §7.5.");
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
        confirmSessionCommand(controlTopicId, `Unknown repo "${cmd.repo}". Registered: ${reposRegistry.names().join(", ") || "(none)"}`);
        return;
      }
    }
    const model = cmd.model ?? repo.model ?? "sonnet";

    // §10.5 point 1: refuse before ever creating a topic/worktree, so a rejected /new leaves no
    // debris the way a launch failure further down deliberately cleans up after itself.
    const capCheck = checkConcurrencyCap(sessionStore.all(), model);
    if (!capCheck.ok) {
      confirmSessionCommand(
        controlTopicId,
        `Refused: the fleet is already at ${capCheck.current}/${WEIGHTED_CAP} weighted units - adding a ${model} session would bring it to ${capCheck.wouldBe}. Kill or /rm a session first.`,
      );
      return;
    }

    const base = slugFromPrompt(cmd.prompt);
    const slug = uniqueSlug(base, sessionStore.slugs());

    let topic: { message_thread_id: number };
    try {
      topic = await controlBot.createForumTopic(supergroupChatId, cmd.prompt.slice(0, 128));
    } catch (err) {
      confirmSessionCommand(controlTopicId, `Failed to create a topic for "${slug}": ${(err as Error).message}`);
      return;
    }

    // The topic's own title is truncated to 128 chars (Telegram's forum-topic-name limit) and the
    // actual delivery further below is a raw PTY keystroke into Claude's context, not a Telegram
    // post - so without this, the topic opened straight into Claude's tool-call feed with no visible
    // record of what was actually asked for. Posted as a plain message (not `confirmSessionCommand`,
    // which targets `controlTopicId`) since this belongs in the new topic itself.
    confirmSessionCommand(topic.message_thread_id, newSessionContent(cmd));

    let session: ReturnType<typeof launchSession>;
    try {
      session = launchSession({
        slug,
        topicId: topic.message_thread_id,
        repoPath: repo.path,
        worktreesRoot: fleetWorktreesRoot,
        model,
        otlpPort,
        log,
      });
    } catch (err) {
      // A launch failure this late still leaves the topic already created above (Telegram has no
      // atomic "create topic + do the rest" call) - deleted here rather than left as an orphan with
      // no session row and therefore no slug for `/rm` to ever find, confirmed live 2026-08-03 when
      // a branch-name collision left exactly this kind of debris behind.
      try {
        await controlBot.deleteForumTopic(supergroupChatId, topic.message_thread_id);
      } catch (deleteErr) {
        log("WARN", `failed to clean up topic for "${slug}" after a failed launch: ${(deleteErr as Error).message}`);
      }
      confirmSessionCommand(controlTopicId, `Failed to launch session "${slug}": ${(err as Error).message}`);
      return;
    }

    routing.add({ slug, topicId: topic.message_thread_id, worktreePath: session.worktreePath });
    sessionSupervisor.wireSession(slug, session.ptyProcess, topic.message_thread_id);

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
      paused: false,
      renamed: false,
      feedDetail: "compact",
      feedVerbose: false,
      createdUtc: nowIso(),
      lastEventUtc: nowIso(),
    });

    // Deep-links straight into the new topic (buildTopicDeepLink's own doc comment) rather than
    // making the operator find it by hand in the topic list - a `url` button, so no round trip
    // through the Bridge and no callback-registry entry to track or ever expire.
    confirmSessionCommand(controlTopicId, `Created "${slug}" (${model}) in a new topic.`, undefined, {
      inline_keyboard: [[{ text: `↪️ Open "${slug}"`, url: buildTopicDeepLink(supergroupChatId, topic.message_thread_id) }]],
    });

    // Two independent gates, both real events rather than guessed delays: the dev-channels dialog
    // must be confirmed (`session.ready` - otherwise the write lands on the still-open dialog and
    // corrupts it, confirmed live 2026-08-04), and the channel server's own MCP handshake must have
    // completed (`waitForChannelConnected` - otherwise the write's trailing Enter can be silently
    // lost even with the dialog long since confirmed, also confirmed live 2026-08-04).
    await session.ready;
    await waitForChannelConnected(slug);
    // `/defaultmode`/`/defaulteffort`: applied before the initial prompt, not after, so the very
    // first turn already runs under the configured defaults rather than starting under the CLI's
    // own "manual"/"medium" spawn default and switching mid-turn. Silent (no confirmSessionCommand)
    // - see writeModeKeystrokes's own doc comment for why a second "Switched..." message here would
    // just be noise on top of the "Created ..." confirmation already sent above. Skipped entirely
    // when a default is still at the CLI's own spawn default, rather than relying on either write
    // being a harmless no-op at that value - unverified for `/effort`, and `routing.getMode`'s
    // default already assumes "manual" until the first real switch, so a same-value keystroke send
    // isn't even a true no-op, just zero `buildModeKeystrokes` steps.
    const defaultSessionMode = getDefaultSessionMode();
    const defaultSessionEffort = getDefaultSessionEffort();
    if (defaultSessionMode !== DEFAULT_MODE) writeModeKeystrokes(slug, defaultSessionMode);
    if (defaultSessionEffort !== DEFAULT_EFFORT) ptyIo.sendEffortCommand(slug, defaultSessionEffort);
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
    confirmSessionCommand(topicId, `Killed "${row.slug}". Worktree left in place - \`/rm ${row.slug}\` to remove it.`);
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
    confirmSessionCommand(topicId, `${next ? "Paused" : "Resumed"} feed updates for "${row.slug}".`);
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
    handleDetailCommand,
    handleVerboseCommand,
  };
}
