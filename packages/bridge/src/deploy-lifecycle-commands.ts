import { execFile } from "node:child_process";
import path from "node:path";
import { buildCreateArgs, buildDeleteArgs, buildFixTaskSettingsScript, buildQueryArgs, parseQueryOutput, renderAutostartStatus, TASK_NAME } from "./autostart.ts";
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
import { resolveNodeExecutable } from "./session-launcher.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import type { SendMessageSource } from "./telegram.ts";
import type { SessionStore } from "./session-store.ts";

/** Result shape shared by `runSchtasks`/`runPowershell` - `/Query` against an unregistered task
 * exits non-zero, which is a valid "not registered" answer, not a transport failure, so both
 * always resolve rather than reject; callers that care about install/delete failing check
 * `failed` themselves. */
export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  failed: boolean;
}

/** An injected `execFile`-shaped runner, so `runSchtasks`/`runPowershell` are fakeable in tests
 * rather than requiring a real Windows host with a real Task Scheduler - same dependency-inversion
 * treatment already applied to `confirmSessionCommand` elsewhere in this split. */
export type ExecFileFn = (
  command: string,
  args: string[],
  options: { windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export interface ProcessRunner {
  /** Wraps `schtasks.exe` (built into Windows, no extra dependency). */
  runSchtasks(args: string[]): Promise<ProcessRunResult>;
  /** Runs a PowerShell one-liner and reports success/failure the same shape as `runSchtasks` -
   * `schtasks.exe` alone can't fix the two task-settings defaults `buildFixTaskSettingsScript`
   * targets, so `/autostart install` needs this second tool as well. `stdout` was added for
   * `os-power-commands.ts`'s `checkAutoLogonEnabled` (needs the actual registry value back, not
   * just success/failure) - every existing caller only ever read `stderr`/`failed`, so this is a
   * pure addition, not a behaviour change for them. */
  runPowershell(script: string): Promise<{ stdout: string; stderr: string; failed: boolean }>;
  /** Wraps `shutdown.exe` (built into Windows) - `/os shutdown|reboot|cancel` (os-power-commands.ts).
   * A third method on this same interface rather than a separate injectable, so there's still only
   * one process-runner shape to fake in tests. */
  runShutdown(args: string[]): Promise<ProcessRunResult>;
}

export function createProcessRunner(execFileFn: ExecFileFn = execFile as unknown as ExecFileFn): ProcessRunner {
  function runSchtasks(args: string[]): Promise<ProcessRunResult> {
    return new Promise((resolve) => {
      execFileFn("schtasks", args, { windowsHide: true }, (err, stdout, stderr) => {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", failed: err !== null });
      });
    });
  }

  function runPowershell(script: string): Promise<{ stdout: string; stderr: string; failed: boolean }> {
    return new Promise((resolve) => {
      execFileFn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, (err, stdout, stderr) => {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", failed: err !== null });
      });
    });
  }

  function runShutdown(args: string[]): Promise<ProcessRunResult> {
    return new Promise((resolve) => {
      execFileFn("shutdown", args, { windowsHide: true }, (err, stdout, stderr) => {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", failed: err !== null });
      });
    });
  }

  return { runSchtasks, runPowershell, runShutdown };
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
  stateDir: string;
  supergroupChatId: string;
  entryScriptDir: string;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
  /** Defaults to the real `deploy.ts` merge-and-gate implementation - injectable so
   * `handleDeployCommand`'s own control flow (topic gating, ack/failure/success messaging,
   * self-repo restart + deploy-marker sequencing) is unit-testable without a real git repo or a
   * real `bun test`/`tsc` gate run. */
  deployBranch?: typeof realDeployBranch;
  /** Injectable for the same reason as `deployBranch` - `/ship`'s auto-commit and post-merge push
   * steps need to be exercised in tests without a real git worktree/remote. */
  commitIfDirty?: typeof realCommitIfDirty;
  pushCurrentBranch?: typeof realPushCurrentBranch;
}

export interface DeployLifecycleCommands {
  handleRestartCommand(topicId: number | undefined): Promise<void>;
  handleDeployCommand(topicId: number | undefined, slug: string): Promise<void>;
  handleShipCommand(topicId: number | undefined, explicitSlug: string | undefined, currentSlug: string | undefined): Promise<void>;
  handleAutostartCommand(cmd: Extract<FleetCommand, { kind: "autostart" }>, topicId: number | undefined): Promise<void>;
}

export function createDeployLifecycleCommands(opts: DeployLifecycleCommandsOptions): DeployLifecycleCommands {
  const { sessionStore, controlBot, confirmSessionCommand, isControlTopic, runSchtasks, runPowershell, respawnSelfAndExit, stateDir, supergroupChatId, entryScriptDir, log } = opts;
  const deployBranch = opts.deployBranch ?? realDeployBranch;
  const commitIfDirty = opts.commitIfDirty ?? realCommitIfDirty;
  const pushCurrentBranch = opts.pushCurrentBranch ?? realPushCurrentBranch;

  /**
   * The self-repo-restart tail shared by `/deploy` and `/ship`: once a merge into `repoPath` has
   * already succeeded, only if that repo is this Bridge's own checkout (`isSelfRepo`) does landing
   * the fix also mean respawning to run it - any other project's branch is just a merge+test, there
   * is no "Bridge" to restart for it. Writes `deployMarker` first so a boot that never comes up
   * cleanly gets rolled back automatically (see the startup check near the end of `main()`) rather
   * than crash-looping on a bad commit with no way to say so. Extracted so `/ship` gets the exact
   * same self-repo behaviour as `/deploy` without duplicating it.
   */
  async function restartIfSelfRepo(commandLabel: string, repoPath: string, branch: string, outcome: { previousHeadSha?: string; newHeadSha?: string }, topicId: number | undefined): Promise<void> {
    const bridgeRepoRoot = resolveBridgeRepoRoot(entryScriptDir);
    if (!isSelfRepo(repoPath, bridgeRepoRoot)) {
      log("INFO", `${commandLabel}: "${repoPath}" isn't this Bridge's own repo - merged only, no restart`);
      return;
    }

    writeDeployMarker(stateDir, {
      previousHeadSha: outcome.previousHeadSha ?? "",
      newHeadSha: outcome.newHeadSha ?? "",
      repoRoot: repoPath,
      branch,
      chatId: supergroupChatId,
      topicId,
      deployedAtIso: new Date().toISOString(),
    });
    try {
      await controlBot.sendMessage(
        supergroupChatId,
        topicId,
        "This is aibridge's own repo - restarting now to apply the fix (§5.9). If it doesn't come back up cleanly within a minute, it rolls itself back automatically and restarts again.",
      );
    } catch (err) {
      log("WARN", `failed to send ${commandLabel} restart notice: ${(err as Error).message}`);
    }
    log("INFO", `${commandLabel}: self-repo, respawning and exiting`);
    await respawnSelfAndExit();
  }

  /**
   * §4.5.1's `/restart`: self-respawn, not an external supervisor. Every live session dies with
   * this process (§4.5's measurement) and comes back via `resumeSession`'s `claude --resume` path
   * once the successor's own startup reconciliation runs - the same cold-start cost as any other
   * Bridge restart, just operator-triggered instead of waiting for a crash.
   */
  async function handleRestartCommand(topicId: number | undefined): Promise<void> {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/restart only works from the control topic.");
      return;
    }
    try {
      await controlBot.sendMessage(
        supergroupChatId,
        topicId,
        "Restarting the Bridge now (§4.5.1) - live sessions will relaunch via claude --resume once it's back up.",
      );
    } catch (err) {
      log("WARN", `failed to send /restart confirmation: ${(err as Error).message}`);
    }
    log("INFO", "/restart requested - relaunching and exiting");
    await respawnSelfAndExit();
  }

  /**
   * §5.9's `/deploy <slug>`: lets a fix written by a Claude session - including one against
   * aibridge's own repo, registered like any other project (§7.5) - land without a desk. Merges
   * that session's own branch into its repo's main checkout via `deployBranch` (fast-forward only,
   * rolled back automatically on a gate failure), then only if the repo being merged into is this
   * Bridge's own checkout (`isSelfRepo` - any other project's branch is just a merge+test, there is
   * no "Bridge" to restart for it) does the same self-respawn `/restart` already does, first
   * writing `deployMarker` so a boot that never comes up cleanly gets rolled back automatically
   * (see the startup check near the end of `main()`) rather than crash-looping on a bad commit
   * with no way to say so.
   */
  async function handleDeployCommand(topicId: number | undefined, slug: string): Promise<void> {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/deploy only works from the control topic.");
      return;
    }
    const row = sessionStore.get(slug);
    if (!row) {
      confirmSessionCommand(topicId, `No session "${slug}".`);
      return;
    }
    const { repoPath, branch } = row;
    try {
      await controlBot.sendMessage(supergroupChatId, topicId, `Deploying "${branch}" (session "${slug}") into ${repoPath}…`);
    } catch (err) {
      log("WARN", `failed to send /deploy ack: ${(err as Error).message}`);
    }
    log("INFO", `/deploy requested for slug "${slug}" -> merging "${branch}" into ${repoPath}`);
    const packageDirs = discoverTypecheckedPackages(repoPath);
    const outcome = await deployBranch(repoPath, branch, packageDirs);
    if (!outcome.ok) {
      log("WARN", `/deploy failed for "${branch}": ${outcome.message}`);
      try {
        await controlBot.sendMessage(supergroupChatId, topicId, truncateForTelegram(outcome.message));
      } catch (err) {
        log("WARN", `failed to send /deploy failure message: ${(err as Error).message}`);
      }
      return;
    }
    try {
      await controlBot.sendMessage(supergroupChatId, topicId, truncateForTelegram(outcome.message));
    } catch (err) {
      log("WARN", `failed to send /deploy success message: ${(err as Error).message}`);
    }

    await restartIfSelfRepo("/deploy", repoPath, branch, outcome, topicId);
  }

  /**
   * `/ship <slug>` (control topic) or bare `/ship` (a session's own topic, §4.2's existing
   * `/kill`/`/rm`/`/pause`/`/usage` convention): the one-shot "land it, I'm done" command, reachable
   * without opening a control-topic round-trip *or* going through the session's own Claude process
   * at all - this runs as trusted Bridge code via a direct `CommandRunner`, the same way `/deploy`
   * always has, so it never touches (and never needs a Telegram button from) the session's own
   * `permissions.ask` gate the way an equivalent in-session `git commit`/`git push` would. An
   * explicit slug naming a *different* session still requires the control topic - only a bare
   * invocation resolving to *this* topic's own session skips that check, since typing "ship" while
   * sitting inside session X's own topic is exactly as deliberate an operator action as typing
   * "/ship X" from the control topic, just aimed at the one session already in view.
   *
   * Three steps chained together, each already its own tested piece: auto-commit the session's
   * worktree if it's dirty (`commitIfDirty` - a session may still have uncommitted work sitting
   * there), then exactly what `/deploy` does (merge+gate, rolled back automatically on failure,
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
    try {
      await controlBot.sendMessage(supergroupChatId, topicId, `Shipping "${branch}" (session "${slug}") to main…`);
    } catch (err) {
      log("WARN", `failed to send /ship ack: ${(err as Error).message}`);
    }
    log("INFO", `/ship requested for slug "${slug}" -> committing+merging "${branch}" into ${repoPath}`);

    const commitOutcome = await commitIfDirty(worktreePath);
    if (commitOutcome.committed) {
      log("INFO", `/ship: ${commitOutcome.message}`);
    }

    const packageDirs = discoverTypecheckedPackages(repoPath);
    const outcome = await deployBranch(repoPath, branch, packageDirs);
    if (!outcome.ok) {
      log("WARN", `/ship failed for "${branch}": ${outcome.message}`);
      try {
        await controlBot.sendMessage(supergroupChatId, topicId, truncateForTelegram(outcome.message));
      } catch (err) {
        log("WARN", `failed to send /ship failure message: ${(err as Error).message}`);
      }
      return;
    }

    const push = await pushCurrentBranch(repoPath);
    const pushNote = push.status === 0 ? "Pushed to origin." : `Merged locally, but the push to origin failed: ${push.stderr || push.stdout}`;
    if (push.status !== 0) log("WARN", `/ship: push failed for ${repoPath}: ${push.stderr || push.stdout}`);
    try {
      await controlBot.sendMessage(supergroupChatId, topicId, `${truncateForTelegram(outcome.message)}\n${pushNote}`);
    } catch (err) {
      log("WARN", `failed to send /ship success message: ${(err as Error).message}`);
    }

    await restartIfSelfRepo("/ship", repoPath, branch, outcome, topicId);
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

  return { handleRestartCommand, handleDeployCommand, handleShipCommand, handleAutostartCommand };
}
