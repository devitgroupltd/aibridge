import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildCreateArgs, buildDeleteArgs, buildFixTaskSettingsScript, buildQueryArgs, parseQueryOutput, renderAutostartStatus, TASK_NAME } from "./autostart.ts";
import { buildRestartConfirmKeyboard, RestartConfirmRegistry, type PendingRestartConfirm } from "./restart-confirm.ts";
import type { ProcessRunner } from "./process-runner.ts";
import {
  commitIfDirty as realCommitIfDirty,
  deployBranch as realDeployBranch,
  discoverTypecheckedPackages,
  isSelfRepo,
  pushCurrentBranch as realPushCurrentBranch,
  resolveBridgeRepoRoot,
  truncateForTelegram,
  writeDeployMarker,
} from "./deploy.ts";
import { escapeForFeed } from "./feed-escape.ts";
import { resolveNodeExecutable } from "./session-launcher.ts";
import type { DeployOutcome } from "./deploy.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import type { PtyIo } from "./pty-io.ts";
import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import type { InlineKeyboardButton, SendMessageSource } from "./telegram.ts";
import type { SessionRow, SessionStore } from "./session-store.ts";
import type { LogFn } from "./logger.ts";

/**
 * Renders a `DeployOutcome` (or any ok/failure notice built the same way) for Telegram: a bold
 * headline plus, only if there's raw command output to show, a separate `<pre>` block for it.
 * Found live 2026-08-11: a rebase-conflict message used to fold git's multi-line stderr straight
 * into the middle of a sentence - unreadable once Telegram wrapped it. Keeping the prose and the
 * raw dump visually distinct fixes that without changing what's actually reported. Every
 * interpolated part is untrusted (branch names, worktree paths, git output) so both go through
 * `escapeForFeed` - same treatment feed cards give tool output, for the same reason (§9 scenario 21).
 */
function formatOutcomeHtml(message: string, detail?: string): string {
  const head = `<b>${escapeForFeed(message)}</b>`;
  if (!detail || detail.trim().length === 0) return head;
  return `${head}\n<pre>${escapeForFeed(truncateForTelegram(detail))}</pre>`;
}

export interface DeployLifecycleCommandsOptions {
  sessionStore: SessionStore;
  controlBot: SendMessageSource;
  confirmSessionCommand: ConfirmSessionCommand;
  isControlTopic: (threadId: number | undefined) => boolean;
  runSchtasks: ProcessRunner["runSchtasks"];
  runPowershell: ProcessRunner["runPowershell"];
  /** The only correct way for this process to replace itself (self-respawn via Task Scheduler
   * re-run, falling back to a raw detached spawn). Stays defined in index.ts, adjacent to
   * `main()`'s startup sequencing, because its `bootReadyAt` settle-delay state is set on
   * reconciliation completion and its ordering relative to `runStartupReconciliation`/the
   * stale-deploy-rollback check at boot is safety-critical - injected here as a callback rather
   * than relocated (plan Risks). */
  respawnSelfAndExit: () => Promise<never>;
  /** `/restart`'s own confirm-gate registry (see `RestartConfirmRegistry`'s doc comment) - constructed
   * once in index.ts alongside `osConfirmRegistry`/`fleetConfirmRegistry`, so a pending card survives
   * exactly as long as this process does and is swept by the same periodic sweep. */
  restartConfirmRegistry: RestartConfirmRegistry;
  /** Edits the tapped confirm card in place - `confirmCards.finalizeCard` bound at construction, same
   * as `os-power-commands.ts`'s identically-named option. Kept as a plain function rather than the
   * whole `ConfirmCards` object so this module doesn't gain a dependency on every other confirm-card
   * protocol it has nothing to do with. */
  finalizeCard: (messageId: number, text: string) => Promise<void>;
  stateDir: string;
  supergroupChatId: string;
  entryScriptDir: string;
  log: LogFn;
  /** Defaults to the real `deploy.ts` merge-and-gate implementation - injectable so
   * `handleMergeCommand`'s own control flow (topic gating, ack/failure/success messaging,
   * self-repo restart + deploy-marker sequencing) is unit-testable without a real git repo or a
   * real `bun test`/`tsc` gate run. */
  deployBranch?: typeof realDeployBranch;
  /** Injectable for the same reason as `deployBranch` - `/ship`'s auto-commit and post-merge push
   * steps need to be exercised in tests without a real git worktree/remote. */
  commitIfDirty?: typeof realCommitIfDirty;
  pushCurrentBranch?: typeof realPushCurrentBranch;
  /** Lets `/merge`/`/ship` reach into the session that owns the branch being landed when
   * `deployBranch` reports `conflict: true` - the auto-rebase hit real conflicts and backed out
   * clean, and that session's own Claude is already sitting in the worktree with full context to
   * resolve them, unlike the operator relaying a raw filesystem path over Telegram. Optional (not
   * every caller needs the nudge exercised) - no live session just means `sendChannelText` logs a
   * `WARN` and drops it, same as any other nudge with no PTY to write to. */
  ptyIo?: Pick<PtyIo, "sendChannelText">;
}

export interface DeployLifecycleCommands {
  handleRestartCommand(topicId: number | undefined): Promise<void>;
  /** Runs after a `/restart` confirm tap - the actual respawn `handleRestartCommand` used to fire
   * unconditionally. Only ever called with `confirmed: true` (the callback-query-router rule
   * finalizes a cancel itself, same as every other simple Yes/Cancel card). */
  executeRestartConfirm(pending: PendingRestartConfirm): Promise<void>;
  handleMergeCommand(topicId: number | undefined, slug: string): Promise<void>;
  handleShipCommand(topicId: number | undefined, explicitSlug: string | undefined, currentSlug: string | undefined): Promise<void>;
  handleAutostartCommand(cmd: Extract<FleetCommand, { kind: "autostart" }>, topicId: number | undefined): Promise<void>;
}

export function createDeployLifecycleCommands(opts: DeployLifecycleCommandsOptions): DeployLifecycleCommands {
  const { sessionStore, controlBot, confirmSessionCommand, isControlTopic, runSchtasks, runPowershell, respawnSelfAndExit, restartConfirmRegistry, finalizeCard, stateDir, supergroupChatId, entryScriptDir, log } = opts;
  const deployBranch = opts.deployBranch ?? realDeployBranch;
  const commitIfDirty = opts.commitIfDirty ?? realCommitIfDirty;
  const pushCurrentBranch = opts.pushCurrentBranch ?? realPushCurrentBranch;
  const ptyIo = opts.ptyIo;

  /**
   * Reports a failed `DeployOutcome` to the control topic and, only when it's the specific
   * "auto-rebase hit real conflicts" shape (`conflict: true`), also nudges the owning session
   * (`sendChannelText` - same synthetic-inbound-turn mechanism as the resume/no-reply nudges in
   * session-supervisor.ts/feed-wiring.ts) to resolve them itself: it's already sitting in
   * `worktreePath` with full code context, which a raw filesystem path relayed over Telegram never
   * gave the operator. The nudge points at the in-session `/ship` skill specifically because that
   * one already does "fetch, check behind, merge, resolve conflicts" end to end - no need to spell
   * the steps out twice.
   */
  async function reportFailure(topicId: number | undefined, outcome: DeployOutcome, row: { slug: string; topicId: number }, commandLabel: string): Promise<void> {
    log("WARN", `${commandLabel} failed for "${row.slug}": ${outcome.message}${outcome.detail ? ` (${outcome.detail})` : ""}`);
    if (outcome.conflict) {
      ptyIo?.sendChannelText(
        row.slug,
        row.topicId,
        `${commandLabel} from the control topic hit a rebase conflict landing your branch on main - aborted cleanly, nothing left half-done. Please resolve it yourself: run /ship here and it'll fetch main, check whether you're behind, merge it in, resolve the conflicts, gate, push, and open/merge a PR.`,
        `${commandLabel}-conflict-nudge`,
        "aibridge",
      );
    }
    try {
      await controlBot.sendMessage(supergroupChatId, topicId, formatOutcomeHtml(outcome.message, outcome.detail), undefined, "HTML");
    } catch (err) {
      log("WARN", `failed to send ${commandLabel} failure message: ${(err as Error).message}`);
    }
  }

  /** `/merge`/`/ship`/`/restart` all send a best-effort Telegram notice and only log (never throw)
   * on a send failure - a dropped ack/failure/success message must not abort a merge that already
   * ran. Shared so the same log-label convention can't drift between the two commands' near-dozen
   * call sites the way it had started to (found live during a DRY pass: `/merge`/`/ship` each wrote
   * this try/catch out by hand at every step). */
  async function notify(topicId: number | undefined, text: string, label: string): Promise<void> {
    try {
      await controlBot.sendMessage(supergroupChatId, topicId, text);
    } catch (err) {
      log("WARN", `failed to send ${label}: ${(err as Error).message}`);
    }
  }

  /** Same best-effort-send contract as `notify` above, but through `formatOutcomeHtml`'s `"HTML"`
   * parse mode - the shape `/merge`'s and `/ship`'s own success messages need. */
  async function notifyHtml(topicId: number | undefined, html: string, label: string): Promise<void> {
    try {
      await controlBot.sendMessage(supergroupChatId, topicId, html, undefined, "HTML");
    } catch (err) {
      log("WARN", `failed to send ${label}: ${(err as Error).message}`);
    }
  }

  /**
   * The merge+gate step shared by `/merge` and `/ship`: runs `deployBranch` and, on failure, reports
   * it via `reportFailure` (which also fires the rebase-conflict nudge back into the owning session
   * when `outcome.conflict` is set) - returns `undefined` in that case (already fully handled) so
   * the caller's only job is "if there's an outcome, keep going". Success reporting is deliberately
   * left to each caller instead of folded in here: `/merge` reports right away, `/ship` first pushes
   * and folds the push result into one combined message, so there is no single "success text" this
   * helper could emit that would be correct for both.
   */
  async function mergeAndReport(commandLabel: string, topicId: number | undefined, row: SessionRow): Promise<DeployOutcome | undefined> {
    const { repoPath, branch, worktreePath } = row;
    const packageDirs = discoverTypecheckedPackages(repoPath);
    const outcome = await deployBranch(repoPath, branch, packageDirs, undefined, worktreePath);
    if (!outcome.ok) {
      await reportFailure(topicId, outcome, row, commandLabel);
      return undefined;
    }
    return outcome;
  }

  /** Writes `deployMarker` and actually respawns - the tail end both `restartIfSelfRepo`'s immediate
   * path and `executeRestartConfirm`'s self-repo branch need, extracted so the marker write can't
   * drift between "restart right away" and "restart once confirmed". */
  async function writeMarkerAndRespawn(commandLabel: string, repoPath: string, branch: string, previousHeadSha: string, newHeadSha: string, topicId: number | undefined): Promise<void> {
    writeDeployMarker(stateDir, { previousHeadSha, newHeadSha, repoRoot: repoPath, branch, chatId: supergroupChatId, topicId, deployedAtIso: new Date().toISOString() });
    log("INFO", `${commandLabel}: self-repo, respawning and exiting`);
    await respawnSelfAndExit();
  }

  /**
   * The self-repo-restart tail shared by `/merge` and `/ship`: once a merge into `repoPath` has
   * already succeeded, only if that repo is this Bridge's own checkout (`isSelfRepo`) does landing
   * the fix also mean respawning to run it - any other project's branch is just a merge+test, there
   * is no "Bridge" to restart for it.
   *
   * Confirm-gated (2026-08-12 operator request) on *other* live sessions, not on `ownSlug` (the
   * session that owns `branch`) - that one is expected to die and cold-resume as a direct, deliberate
   * consequence of the `/merge`/`/ship` the operator (or the session itself, for a bare `/ship`) just
   * ran, the same way a `/restart` with only its own topic's session alive would restart immediately
   * (§4.5.1's `handleRestartCommand`). It's *other* sessions this would surprise-kill that need a Yes/
   * Cancel card first, via the same `RestartConfirmRegistry` `/restart` itself uses -
   * `PendingRestartConfirm.selfRepoRestart` carries what `executeRestartConfirm` needs to write the
   * deploy marker at confirm time instead of now, since a Cancel tap must leave nothing written.
   */
  async function restartIfSelfRepo(commandLabel: string, repoPath: string, branch: string, outcome: { previousHeadSha?: string; newHeadSha?: string }, topicId: number | undefined, ownSlug: string): Promise<void> {
    const bridgeRepoRoot = resolveBridgeRepoRoot(entryScriptDir);
    if (!isSelfRepo(repoPath, bridgeRepoRoot)) {
      log("INFO", `${commandLabel}: "${repoPath}" isn't this Bridge's own repo - merged only, no restart`);
      return;
    }

    const previousHeadSha = outcome.previousHeadSha ?? "";
    const newHeadSha = outcome.newHeadSha ?? "";
    const otherLiveRows = sessionStore.all().filter((r) => r.state !== "dead" && r.slug !== ownSlug);

    if (otherLiveRows.length === 0) {
      await notify(
        topicId,
        "This is aibridge's own repo - restarting now to apply the fix (§5.9). If it doesn't come back up cleanly within a minute, it rolls itself back automatically and restarts again.",
        `${commandLabel} restart notice`,
      );
      await writeMarkerAndRespawn(commandLabel, repoPath, branch, previousHeadSha, newHeadSha, topicId);
      return;
    }

    const id = randomUUID().slice(0, 8);
    const sessionList = otherLiveRows.map((r) => `${r.slug} (${r.state})`).join(", ");
    const promptText =
      `⚠️ ${commandLabel} landed a fix to aibridge's own repo - restarting to apply it would also kill ${otherLiveRows.length} other live session${otherLiveRows.length === 1 ? "" : "s"} (cold-resumed via claude --resume once back up):\n${sessionList}\nRestart now?`;
    try {
      const sent = await controlBot.sendMessage(supergroupChatId, topicId, promptText, { inline_keyboard: buildRestartConfirmKeyboard(id) });
      restartConfirmRegistry.add({ id, topicId, messageId: sent.message_id, selfRepoRestart: { commandLabel, repoPath, branch, previousHeadSha, newHeadSha } });
    } catch (err) {
      log("WARN", `failed to post ${commandLabel} restart confirmation: ${(err as Error).message}`);
    }
  }

  /**
   * §4.5.1's `/restart`: self-respawn, not an external supervisor. Every live session dies with
   * this process (§4.5's measurement) and comes back via `resumeSession`'s `claude --resume` path
   * once the successor's own startup reconciliation runs - the same cold-start cost as any other
   * Bridge restart, just operator-triggered instead of waiting for a crash.
   *
   * Confirm-gated (2026-08-12 operator request) whenever that cost is real: with at least one
   * non-`dead` session in the fleet, this posts the same Yes/Cancel card `/os shutdown|reboot` uses
   * (`RestartConfirmRegistry`, above) instead of restarting on the same message, and returns without
   * touching `respawnSelfAndExit` - `executeRestartConfirm` runs it once the operator actually taps
   * Yes. With zero live sessions there's nothing to lose, so this still restarts immediately, exactly
   * as it always has.
   */
  async function handleRestartCommand(topicId: number | undefined): Promise<void> {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/restart only works from the control topic.");
      return;
    }

    const liveRows = sessionStore.all().filter((r) => r.state !== "dead");
    if (liveRows.length === 0) {
      await notify(topicId, "Restarting the Bridge now (§4.5.1) - no live sessions to lose.", "/restart confirmation");
      log("INFO", "/restart requested - no live sessions, relaunching and exiting");
      await respawnSelfAndExit();
      return;
    }

    const id = randomUUID().slice(0, 8);
    const sessionList = liveRows.map((r) => `${r.slug} (${r.state})`).join(", ");
    const promptText =
      `⚠️ This will restart the Bridge - ${liveRows.length} live session${liveRows.length === 1 ? "" : "s"} will be killed and cold-resumed via claude --resume:\n${sessionList}\nConfirm?`;
    try {
      const sent = await controlBot.sendMessage(supergroupChatId, topicId, promptText, { inline_keyboard: buildRestartConfirmKeyboard(id) });
      restartConfirmRegistry.add({ id, topicId, messageId: sent.message_id });
    } catch (err) {
      log("WARN", `failed to post /restart confirmation: ${(err as Error).message}`);
    }
  }

  async function executeRestartConfirm(pending: PendingRestartConfirm): Promise<void> {
    if (pending.selfRepoRestart) {
      const { commandLabel, repoPath, branch, previousHeadSha, newHeadSha } = pending.selfRepoRestart;
      await finalizeCard(
        pending.messageId,
        "✅ Restarting the Bridge now to apply the fix (§5.9). If it doesn't come back up cleanly within a minute, it rolls itself back automatically and restarts again.",
      );
      await writeMarkerAndRespawn(commandLabel, repoPath, branch, previousHeadSha, newHeadSha, pending.topicId);
      return;
    }
    await finalizeCard(pending.messageId, "✅ Restarting the Bridge now (§4.5.1) - live sessions will relaunch via claude --resume once it's back up.");
    log("INFO", "/restart confirmed - relaunching and exiting");
    await respawnSelfAndExit();
  }

  /**
   * §5.9's `/merge <slug>`: lets a fix written by a Claude session - including one against
   * aibridge's own repo, registered like any other project (§7.5) - land without a desk. Merges
   * that session's own branch into its repo's main checkout via `deployBranch` (fast-forward only,
   * rolled back automatically on a gate failure; if main has moved on since the branch was cut,
   * `deployBranch` auto-rebases the branch in `worktreePath` onto main's current tip and retries
   * once before giving up), then only if the repo being merged into is this
   * Bridge's own checkout (`isSelfRepo` - any other project's branch is just a merge+test, there is
   * no "Bridge" to restart for it) does the same self-respawn `/restart` already does, first
   * writing `deployMarker` so a boot that never comes up cleanly gets rolled back automatically
   * (see the startup check near the end of `main()`) rather than crash-looping on a bad commit
   * with no way to say so.
   */
  async function handleMergeCommand(topicId: number | undefined, slug: string): Promise<void> {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/merge only works from the control topic.");
      return;
    }
    const row = sessionStore.get(slug);
    if (!row) {
      confirmSessionCommand(topicId, `No session "${slug}".`);
      return;
    }
    const { repoPath, branch } = row;
    await notify(topicId, `Merging "${branch}" (session "${slug}") into ${repoPath}…`, "/merge ack");
    log("INFO", `/merge requested for slug "${slug}" -> merging "${branch}" into ${repoPath}`);
    const outcome = await mergeAndReport("/merge", topicId, row);
    if (!outcome) return;
    await notifyHtml(topicId, formatOutcomeHtml(outcome.message), "/merge success message");

    await restartIfSelfRepo("/merge", repoPath, branch, outcome, topicId, slug);
  }

  /**
   * `/ship <slug>` (control topic) or bare `/ship` (a session's own topic, §4.2's existing
   * `/kill`/`/rm`/`/pause`/`/usage` convention): the one-shot "land it, I'm done" command, reachable
   * without opening a control-topic round-trip *or* going through the session's own Claude process
   * at all - this runs as trusted Bridge code via a direct `CommandRunner`, the same way `/merge`
   * always has, so it never touches (and never needs a Telegram button from) the session's own
   * `permissions.ask` gate the way an equivalent in-session `git commit`/`git push` would. An
   * explicit slug naming a *different* session still requires the control topic - only a bare
   * invocation resolving to *this* topic's own session skips that check, since typing "ship" while
   * sitting inside session X's own topic is exactly as deliberate an operator action as typing
   * "/ship X" from the control topic, just aimed at the one session already in view.
   *
   * Three steps chained together, each already its own tested piece: auto-commit the session's
   * worktree if it's dirty (`commitIfDirty` - a session may still have uncommitted work sitting
   * there), then exactly what `/merge` does (merge+gate, rolled back automatically on failure,
   * self-repo restart), then - only on a successful merge - `git push origin <branch>` from
   * `repoPath` so the fast-forward actually reaches the remote instead of staying local to this
   * machine's checkout (`deployBranch` alone never pushes). A push failure is reported on its own:
   * the merge already happened and stays merged either way, only "did it reach origin" is in
   * question at that point.
   */
  async function handleShipCommand(topicId: number | undefined, explicitSlug: string | undefined, currentSlug: string | undefined): Promise<void> {
    const targetingOwnSession = !explicitSlug && currentSlug !== undefined;
    if (!isControlTopic(topicId) && !targetingOwnSession) {
      confirmSessionCommand(topicId, "/ship needs a slug from the control topic, or send it bare from inside that session's own topic.");
      return;
    }
    const slug = explicitSlug ?? currentSlug;
    if (!slug) {
      confirmSessionCommand(topicId, "usage: /ship <slug> (or send it bare from inside that session's own topic)");
      return;
    }
    const row = sessionStore.get(slug);
    if (!row) {
      confirmSessionCommand(topicId, `No session "${slug}".`);
      return;
    }
    const { repoPath, branch, worktreePath } = row;
    await notify(topicId, `Shipping "${branch}" (session "${slug}") to main…`, "/ship ack");
    log("INFO", `/ship requested for slug "${slug}" -> committing+merging "${branch}" into ${repoPath}`);

    const commitOutcome = await commitIfDirty(worktreePath);
    if (commitOutcome.committed) {
      log("INFO", `/ship: ${commitOutcome.message}`);
    }

    const outcome = await mergeAndReport("/ship", topicId, row);
    if (!outcome) return;

    const push = await pushCurrentBranch(repoPath);
    const pushFailed = push.status !== 0;
    const pushNote = pushFailed ? "Merged locally, but the push to origin failed." : "Pushed to origin.";
    if (pushFailed) log("WARN", `/ship: push failed for ${repoPath}: ${push.stderr || push.stdout}`);
    await notifyHtml(
      topicId,
      formatOutcomeHtml(`${outcome.message} ${pushNote}`, pushFailed ? push.stderr || push.stdout : undefined),
      "/ship success message",
    );

    await restartIfSelfRepo("/ship", repoPath, branch, outcome, topicId, slug);
  }

  /** `/autostart status|install|uninstall`: §7.2's Task Scheduler entry, made reachable from
   * Telegram instead of only from the desk. `install` registers a logon-trigger task under this
   * account's own token (`/RL LIMITED`), which needs no admin rights. */
  async function handleAutostartCommand(cmd: Extract<FleetCommand, { kind: "autostart" }>, topicId: number | undefined): Promise<void> {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/autostart only works from the control topic.");
      return;
    }
    try {
      if (cmd.action === "status") {
        const { stdout, stderr } = await runSchtasks(buildQueryArgs());
        await controlBot.sendMessage(supergroupChatId, topicId, renderAutostartStatus(parseQueryOutput(stdout, stderr)));
        return;
      }
      if (cmd.action === "install") {
        const entryScript = path.join(entryScriptDir, "index.ts");
        const result = await runSchtasks(buildCreateArgs(resolveNodeExecutable(), entryScript));
        if (result.failed) throw new Error(result.stderr.trim() || "schtasks /Create failed");
        // schtasks /Create leaves two defaults that would bite later (§7.2 point 2's 3-day execution
        // limit, and a "Multiple Instances" policy that silently breaks /restart's buildRunArgs path -
        // see buildFixTaskSettingsScript's own doc comment for both). Best-effort: the task is already
        // registered and usable either way, so a failure here is reported, not thrown, and doesn't
        // undo the install.
        const settingsResult = await runPowershell(buildFixTaskSettingsScript(TASK_NAME));
        confirmSessionCommand(
          topicId,
          settingsResult.failed
            ? `Registered "${TASK_NAME}" as a logon-trigger scheduled task (§7.2), but fixing its execution-time-limit/multiple-instances defaults failed: ${settingsResult.stderr.trim() || "unknown error"}. It will still start at logon, but a long-running fleet risks the 3-day kill and /restart may not survive - run /autostart install again once fixed, or fix both manually in Task Scheduler.`
            : `Registered "${TASK_NAME}" as a logon-trigger scheduled task (§7.2) - starts the Bridge at next log-on, current-user scope, no admin rights needed. Its 3-day execution time limit is disabled and multiple-instances is set to Parallel, so a long-running fleet won't get killed on the fourth day and /restart works reliably.`,
        );
        return;
      }
      const result = await runSchtasks(buildDeleteArgs());
      if (result.failed) throw new Error(result.stderr.trim() || "schtasks /Delete failed");
      confirmSessionCommand(topicId, `Removed the "${TASK_NAME}" scheduled task.`);
    } catch (err) {
      confirmSessionCommand(topicId, `/autostart ${cmd.action} failed: ${(err as Error).message}`);
    }
  }

  return { handleRestartCommand, executeRestartConfirm, handleMergeCommand, handleShipCommand, handleAutostartCommand };
}
