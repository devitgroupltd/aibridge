import { randomUUID } from "node:crypto";
import { buildOsConfirmKeyboard, OsConfirmRegistry, type OsAction, type PendingOsConfirm } from "./os-confirm.ts";
import type { ProcessRunner } from "./process-runner.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import type { SendMessageSource } from "./telegram.ts";
import type { LogFn } from "./logger.ts";

/** Reads `AutoAdminLogon` under `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon` via
 * the already-injected `runPowershell` (process-runner.ts's `ProcessRunner`) rather than
 * adding a second registry-access mechanism. `plans/telegram-claude-session-control-plan.md` (§7)
 * named this as the one precondition a remote reboot command needs: autologon is what stands
 * between `/os reboot` and stranding the whole fleet with nobody logged in to bring the Bridge back
 * (even with `/autostart install`, which only fires at logon, never at boot).
 *
 * Returns `true`/`false` for a successful read, `undefined` only if the underlying `runPowershell`
 * call itself failed (e.g. PowerShell missing) - kept distinct from `false` so the confirm-card
 * warning can say "could not check" rather than falsely claiming autologon is off. `-ErrorAction
 * SilentlyContinue` turns a missing value into empty stdout rather than a thrown error, so a
 * successful-but-empty read is `false`, not `undefined`. */
export async function checkAutoLogonEnabled(runPowershell: ProcessRunner["runPowershell"]): Promise<boolean | undefined> {
  const script =
    "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name AutoAdminLogon -ErrorAction SilentlyContinue).AutoAdminLogon";
  const result = await runPowershell(script);
  if (result.failed) return undefined;
  return result.stdout.trim() === "1";
}

export interface OsPowerCommandsOptions {
  controlBot: SendMessageSource;
  confirmSessionCommand: ConfirmSessionCommand;
  /** Edits the tapped confirm card in place, same as every other confirm-card flow
   * (confirm-cards.ts) - `finalizeCard` is already generic over any `messageId`, so `executeOsConfirm`
   * reuses it directly rather than needing its own dedicated finalize helper. */
  finalizeCard: (messageId: number, text: string) => Promise<void>;
  isControlTopic: (threadId: number | undefined) => boolean;
  osConfirmRegistry: OsConfirmRegistry;
  runShutdown: ProcessRunner["runShutdown"];
  runPowershell: ProcessRunner["runPowershell"];
  supergroupChatId: string;
  log: LogFn;
}

export interface OsPowerCommands {
  handleOsCommand(cmd: Extract<FleetCommand, { kind: "os" }>, topicId: number | undefined): Promise<void>;
  executeOsConfirm(pending: PendingOsConfirm): Promise<void>;
}

const ACTION_LABEL: Record<OsAction, string> = { shutdown: "shut down", reboot: "restart" };
const ACTION_VERB: Record<OsAction, string> = { shutdown: "Shutting down", reboot: "Restarting" };
const ACTION_FLAG: Record<OsAction, "/s" | "/r"> = { shutdown: "/s", reboot: "/r" };
const AFTER_TEXT: Record<OsAction, string> = {
  shutdown: "good until someone starts it by hand",
  reboot: "until logon-autostart brings it back, if installed",
};

/** §Design's `/os shutdown|reboot|cancel` (plans/swirling-crafting-pixel.md) - the same Yes/No
 * confirm-card shape `fleet-confirm-flow.ts` already uses for `/kill --all`/`/rm --all`, for a
 * strictly more consequential action: this kills the Bridge process itself, and (for shutdown)
 * doesn't come back without someone physically at the machine. */
export function createOsPowerCommands(opts: OsPowerCommandsOptions): OsPowerCommands {
  const { controlBot, confirmSessionCommand, finalizeCard, isControlTopic, osConfirmRegistry, runShutdown, runPowershell, supergroupChatId, log } = opts;

  /** `/os cancel` runs `shutdown /a` immediately - no confirm card, it's the undo action. `/a` only
   * has an effect during a pending countdown; run after that window has already elapsed, it's
   * indistinguishable from "nothing was scheduled in the first place" (no way to tell the two apart
   * from `/a`'s own exit code alone), so the report text never claims to distinguish them. */
  async function handleOsCancelCommand(topicId: number | undefined): Promise<void> {
    const result = await runShutdown(["/a"]);
    confirmSessionCommand(topicId, result.failed ? "Nothing to cancel (either nothing was scheduled, or it already started)." : "✅ Cancelled the pending shutdown/restart.");
  }

  async function handleOsCommand(cmd: Extract<FleetCommand, { kind: "os" }>, topicId: number | undefined): Promise<void> {
    if (!isControlTopic(topicId)) {
      confirmSessionCommand(topicId, "/os only works from the control topic.");
      return;
    }
    if (cmd.action === "cancel") {
      await handleOsCancelCommand(topicId);
      return;
    }

    const action = cmd.action;
    let warning = "";
    if (action === "reboot") {
      const autoLogon = await checkAutoLogonEnabled(runPowershell);
      if (autoLogon !== true) {
        const state = autoLogon === undefined ? "could not be checked" : "is NOT configured";
        warning =
          `\n\n⚠️ Autologon ${state} (HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\AutoAdminLogon) - nobody will be logged into ` +
          "the desktop after reboot until someone does so by hand, and the Bridge (even with /autostart install, which only fires at logon) will not come back on its own until then.";
      }
    }

    const id = randomUUID().slice(0, 8);
    const promptText =
      `⚠️ This will ${ACTION_LABEL[action]} THE WHOLE MACHINE in 60s - every open app will be force-closed, the Bridge and every session goes offline (${AFTER_TEXT[action]}). ` +
      `/os cancel within 60s to abort. Confirm?${warning}`;
    try {
      const sent = await controlBot.sendMessage(supergroupChatId, topicId, promptText, { inline_keyboard: buildOsConfirmKeyboard(action, id) });
      osConfirmRegistry.add({ id, action, topicId, messageId: sent.message_id });
    } catch (err) {
      log("WARN", `failed to post /os ${action} confirmation: ${(err as Error).message}`);
    }
  }

  async function executeOsConfirm(pending: PendingOsConfirm): Promise<void> {
    const result = await runShutdown([ACTION_FLAG[pending.action], "/t", "60", "/c", "aibridge: shutdown requested from Telegram"]);
    if (result.failed) {
      await finalizeCard(pending.messageId, `⚠️ Failed to schedule the ${pending.action} (${result.stderr || "unknown error"}) - the machine is unaffected.`);
      return;
    }
    await finalizeCard(pending.messageId, `✅ ${ACTION_VERB[pending.action]} in 60s. /os cancel to abort.`);
  }

  return { handleOsCommand, executeOsConfirm };
}
