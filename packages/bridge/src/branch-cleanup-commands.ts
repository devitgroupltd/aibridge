import { randomUUID } from "node:crypto";
import { buildFleetConfirmKeyboard, type FleetConfirmRegistry } from "./fleet-confirm.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import { classifyOrphanBranches, listSessionBranches, renderOrphanBranchReport, type OrphanBranch } from "./orphan-branches.ts";
import type { RepoEntry, ReposRegistry } from "./repos-registry.ts";
import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import type { SessionStore } from "./session-store.ts";
import type { SendMessageSource } from "./telegram.ts";
import type { LogFn } from "./logger.ts";

/**
 * `/branches [<repo>]` - the operator surface for `orphan-branches.ts`. Read that module first; it
 * carries the reasoning for why leftover session branches exist at all, why they are reported rather
 * than posted at boot, and why only the merged ones may be deleted.
 *
 * One card per repo rather than one card listing everything. Two reasons, both practical: a confirm
 * entry carries a single `repoPath` (branch names say nothing about which repo they came from), and
 * an operator with several repos registered almost always wants to act on one of them at a time.
 */
export interface BranchCleanupCommandsOptions {
  controlBot: SendMessageSource;
  sessionStore: SessionStore;
  fleetConfirmRegistry: FleetConfirmRegistry;
  confirmSessionCommand: ConfirmSessionCommand;
  isControlTopic: (threadId: number | undefined) => boolean;
  getReposRegistry: () => ReposRegistry | undefined;
  supergroupChatId: string;
  /** Seam for tests - the real one shells out to git in `repo.path`. */
  listBranches?: typeof listSessionBranches;
  log: LogFn;
}

export interface BranchCleanupCommands {
  handleBranchesCommand(cmd: Extract<FleetCommand, { kind: "branches" }>, topicId: number | undefined): Promise<void>;
}

export function createBranchCleanupCommands(opts: BranchCleanupCommandsOptions): BranchCleanupCommands {
  const { controlBot, sessionStore, fleetConfirmRegistry, confirmSessionCommand, isControlTopic, getReposRegistry, supergroupChatId, log } = opts;
  const listBranches = opts.listBranches ?? listSessionBranches;

  async function reportRepo(repo: RepoEntry, topicId: number | undefined): Promise<OrphanBranch[]> {
    const orphans = classifyOrphanBranches({
      branches: listBranches(repo.path, repo.base),
      knownSlugs: sessionStore.all().map((r) => r.slug),
    });
    if (orphans.length === 0) return orphans;
    const text = renderOrphanBranchReport(repo.name, orphans);
    const removable = orphans.filter((o) => o.removable).map((o) => o.branch);
    try {
      // No button when nothing is safe to delete, exactly as `postOrphanWorktreeConfirm` does it: a
      // "Yes, proceed" that would act on zero branches is a card that lies about what tapping it
      // does - and with this command that is the *common* case, since unmerged is the normal state
      // of a session branch.
      if (removable.length === 0) {
        confirmSessionCommand(topicId, text);
        return orphans;
      }
      const id = randomUUID().slice(0, 8);
      const sent = await controlBot.sendMessage(supergroupChatId, topicId, `${text}\n\nDelete the ${removable.length} merged branch${removable.length === 1 ? "" : "es"} listed above?`, {
        inline_keyboard: buildFleetConfirmKeyboard("rm-branch", id),
      });
      fleetConfirmRegistry.add({ id, kind: "rm-branch", slugs: removable, topicId, repoPath: repo.path, messageId: sent.message_id });
    } catch (err) {
      log("WARN", `failed to post the orphaned-branch report for "${repo.name}": ${(err as Error).message}`);
    }
    return orphans;
  }

  async function handleBranchesCommand(cmd: Extract<FleetCommand, { kind: "branches" }>, topicId: number | undefined): Promise<void> {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/branches only works from the control topic.");
      return;
    }
    const registry = getReposRegistry();
    const all = registry?.all() ?? [];
    if (all.length === 0) {
      confirmSessionCommand(topicId, "No repos are registered - /repos add <name> <path> first.");
      return;
    }
    // A named repo that isn't registered is an error rather than an empty report: "no orphaned
    // branches in seowrit" for a typo'd name reads exactly like a clean result.
    const targets = cmd.repo === undefined ? all : all.filter((r) => r.name === cmd.repo);
    if (targets.length === 0) {
      confirmSessionCommand(topicId, `No repo named "${cmd.repo}" is registered - /repos list shows what is.`);
      return;
    }
    let total = 0;
    for (const repo of targets) {
      total += (await reportRepo(repo, topicId)).length;
    }
    // Said explicitly rather than by staying silent. Unlike the boot card, this command was *asked*
    // a question, and no answer at all is indistinguishable from the command having failed.
    if (total === 0) {
      confirmSessionCommand(topicId, targets.length === 1 ? `No orphaned session branches in "${targets[0]!.name}".` : `No orphaned session branches in any of the ${targets.length} registered repos.`);
    }
  }

  return { handleBranchesCommand };
}
