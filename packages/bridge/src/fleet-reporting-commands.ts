import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import { CostTracker, FIVE_HOURS_MS, ONE_WEEK_MS } from "./cost-tracker.ts";
import { currentUnits, WEIGHTED_CAP } from "./concurrency-cap.ts";
import { addRepoEntry, cloneRepo, inferDefaultRepoPath, isGitUrl, loadReposRegistry, removeRepoEntry, type ReposRegistry } from "./repos-registry.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import { renderBudget, renderReposList, renderSettings } from "./fleet-commands.ts";
import type { SendMessageSource } from "./telegram.ts";
import type { SessionStore } from "./session-store.ts";

/** Read-only fleet reporting (`/budget`, `/settings`, `/repos`) - split out from what would
 * otherwise be a single `fleet-admin-commands.ts` because bundling these with process/deploy
 * lifecycle (item 9's `deploy-lifecycle-commands.ts`) and Windows Task Scheduler integration was
 * itself the same "many unrelated responsibilities in one scope" SRP violation this whole
 * module-split plan exists to fix in `index.ts` - just at smaller scale. This file's only real
 * dependency is reading already-constructed state (`costTracker`, `sessionStore`, `reposRegistry`)
 * and rendering a reply. Thin, low-risk, read-only wrapper - no test file, mirroring the treatment
 * of `card-senders.ts`. */
export interface FleetReportingCommandsOptions {
  controlBot: SendMessageSource;
  sessionStore: SessionStore;
  costTracker: CostTracker;
  confirmSessionCommand: ConfirmSessionCommand;
  isControlTopic: (threadId: number | undefined) => boolean;
  /** `reposRegistry` is a `let` reassigned by `/repos add`/`/repos rm` themselves (below) as well
   * as by other not-yet-extracted commands - a plain getter alone isn't enough since this module
   * also needs to write the reload back, hence the getter/setter pair rather than a single
   * live-value injection. */
  getReposRegistry: () => ReposRegistry | undefined;
  setReposRegistry: (registry: ReposRegistry) => void;
  reposTomlPath: string;
  supergroupChatId: string;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}

export interface FleetReportingCommands {
  handleBudgetCommand(topicId: number | undefined): void;
  handleSettingsCommand(topicId: number | undefined): void;
  handleReposCommand(cmd: Extract<FleetCommand, { kind: "repos" }>, topicId: number | undefined): void;
}

export function createFleetReportingCommands(opts: FleetReportingCommandsOptions): FleetReportingCommands {
  const { controlBot, sessionStore, costTracker, confirmSessionCommand, isControlTopic, getReposRegistry, setReposRegistry, reposTomlPath, supergroupChatId, log } = opts;

  /** §10.5 point 2's `/budget`: fleet-wide rolling 5h/7d spend plus a per-session 5h breakdown -
   * control-topic only, same as `/ls` (no single session to scope this to). */
  function handleBudgetCommand(topicId: number | undefined): void {
    const nowMs = Date.now();
    costTracker.prune(nowMs);
    const fleetFiveHour = costTracker.fleetSpendSince(FIVE_HOURS_MS, nowMs);
    const fleetWeekly = costTracker.fleetSpendSince(ONE_WEEK_MS, nowMs);
    const perSessionFiveHour = new Map<string, number>();
    for (const row of sessionStore.all()) {
      if (row.sessionId) perSessionFiveHour.set(row.slug, costTracker.spendSince(row.sessionId, FIVE_HOURS_MS, nowMs));
    }
    controlBot
      .sendMessage(supergroupChatId, topicId, renderBudget(fleetFiveHour, fleetWeekly, perSessionFiveHour))
      .catch((err) => log("WARN", `sendMessage (/budget) failed: ${(err as Error).message}`));
  }

  function handleSettingsCommand(topicId: number | undefined): void {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/settings only works from the control topic.");
      return;
    }
    controlBot
      .sendMessage(
        supergroupChatId,
        topicId,
        renderSettings(getReposRegistry()?.all() ?? [], { current: currentUnits(sessionStore.all()), cap: WEIGHTED_CAP }),
      )
      .catch((err) => log("WARN", `sendMessage (/settings) failed: ${(err as Error).message}`));
  }

  /** `/repos [list|add <name> [path|git-url] [--base <b>] [--model <m>]|rm <name>]`: §7.5's
   * registry, now mutable from Telegram (`repos-registry.ts` owns the file I/O and validation)
   * instead of only by hand-editing repos.toml. Control-topic only, same reasoning as
   * `/settings`/`/budget` - the registry is fleet-wide, not scoped to any one session's topic.
   * `add`/`rm` reload `reposRegistry` in place so the very next `/new` sees the change without a
   * Bridge restart.
   *
   * `add`'s path argument is resolved here, ahead of `addRepoEntry`'s own local-path checks: a git
   * URL (`isGitUrl`) is cloned first (`cloneRepo`) into an inferred destination, and an omitted path
   * is inferred outright (`inferDefaultRepoPath`) - both only when every already-registered repo
   * shares one parent folder, per the operator's own §7.5 ask; otherwise this asks for an explicit
   * path rather than guessing. */
  function handleReposCommand(cmd: Extract<FleetCommand, { kind: "repos" }>, topicId: number | undefined): void {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/repos only works from the control topic.");
      return;
    }
    if (cmd.action === "list") {
      controlBot
        .sendMessage(supergroupChatId, topicId, renderReposList(getReposRegistry()?.all() ?? []))
        .catch((err) => log("WARN", `sendMessage (/repos) failed: ${(err as Error).message}`));
      return;
    }
    try {
      if (cmd.action === "add") {
        const existing = getReposRegistry()?.all() ?? [];
        const givenUrl = cmd.path && isGitUrl(cmd.path) ? cmd.path : undefined;
        let repoPath = givenUrl ? undefined : cmd.path;
        if (!repoPath) {
          repoPath = inferDefaultRepoPath(existing, cmd.name) ?? undefined;
          if (!repoPath) {
            confirmSessionCommand(
              topicId,
              `/repos add ${cmd.name}: no path given and none could be inferred (need at least one repo already registered, all sharing one parent folder) - specify a path or git URL explicitly.`,
            );
            return;
          }
        }
        if (givenUrl) {
          cloneRepo(givenUrl, repoPath, cmd.base);
        }
        addRepoEntry(reposTomlPath, { name: cmd.name, path: repoPath, base: cmd.base, model: cmd.model });
        setReposRegistry(loadReposRegistry(reposTomlPath));
        confirmSessionCommand(
          topicId,
          `${givenUrl ? `Cloned ${givenUrl} -> ${repoPath} and r` : "R"}egistered "${cmd.name}" -> ${repoPath} (§7.5). /new ${cmd.name} <prompt> now works.`,
        );
        return;
      }
      removeRepoEntry(reposTomlPath, cmd.name);
      setReposRegistry(loadReposRegistry(reposTomlPath));
      confirmSessionCommand(topicId, `Unregistered "${cmd.name}" - any existing worktree/session for it is untouched.`);
    } catch (err) {
      confirmSessionCommand(topicId, `/repos ${cmd.action} failed: ${(err as Error).message}`);
    }
  }

  return { handleBudgetCommand, handleSettingsCommand, handleReposCommand };
}
