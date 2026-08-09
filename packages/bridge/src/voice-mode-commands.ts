import path from "node:path";
import { fireAndForget } from "./fire-and-forget.ts";
import { buildVoiceModelKeyboard, listAvailableVoiceModels } from "./voice-model.ts";
import type { WhisperServerHandle } from "./voice-transcribe.ts";
import {
  buildDefaultCategoryKeyboard,
  buildDefaultEffortKeyboard,
  buildDefaultModeKeyboard,
  buildModeKeystrokes,
} from "./session-commands.ts";
import type { DefaultCategory, Effort, Mode } from "./session-commands.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import type { PtyIo } from "./pty-io.ts";
import type { Routing } from "./routing.ts";
import type { SessionStore } from "./session-store.ts";
import type { SettingsStore } from "./settings-store.ts";
import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import type { SendMessageSource } from "./telegram.ts";

/** §4.2's `/model`/`/mode`/`/effort`/`/voice`/`/assist`/`/voiceconfirm`/`/default`/`/router` fleet
 * commands and their shared apply-and-confirm primitives. Split into its own module because these
 * are all "switch a live setting, persist it, confirm it" commands operating on session-scoped or
 * fleet-wide in-memory state - a distinct responsibility from process/deploy lifecycle (item 9) or
 * read-only reporting (item 8), even though all three used to sit side by side in `index.ts`.
 *
 * `assistEnabled`/`voiceConfirmEnabled`/`defaultSessionMode`/`defaultSessionEffort`/
 * `nlRouterBackend` are all `let`s still read and written from several not-yet-extracted spots in
 * `index.ts` (nl-dispatch.ts/command-dispatch.ts/callback-query-router.ts territory, items 13-15) -
 * each gets a getter/setter pair here rather than a live-getter-only injection, the same treatment
 * `reposRegistry` got in fleet-reporting-commands.ts (item 8), because this module also needs to
 * write them, not just read them. */
export interface VoiceModeCommandsOptions {
  ptyIo: PtyIo;
  routing: Routing;
  sessionStore: SessionStore;
  settingsStore: SettingsStore;
  controlBot: SendMessageSource;
  confirmSessionCommand: ConfirmSessionCommand;
  voiceServer: WhisperServerHandle | null;
  voiceModelPath: string;
  getAssistEnabled: () => boolean;
  setAssistEnabled: (value: boolean) => void;
  getVoiceConfirmEnabled: () => boolean;
  setVoiceConfirmEnabled: (value: boolean) => void;
  getDefaultSessionMode: () => Mode;
  setDefaultSessionMode: (mode: Mode) => void;
  getDefaultSessionEffort: () => Effort;
  setDefaultSessionEffort: (effort: Effort) => void;
  getNlRouterBackend: () => "api" | "cli";
  setNlRouterBackend: (backend: "api" | "cli") => void;
  nlRouterApiKeyConfigured: boolean;
  supergroupChatId: string;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}

export interface VoiceModeCommands {
  applyModelSwitch(slug: string, topicId: number, model: string): void;
  writeModeKeystrokes(slug: string, mode: Mode): void;
  applyModeSwitch(slug: string, topicId: number, mode: Mode): void;
  applyEffortSwitch(slug: string, topicId: number, effort: Effort): void;
  handleVoiceModelCommand(cmd: Extract<FleetCommand, { kind: "voice" }>, topicId: number | undefined): void;
  applyVoiceModelSwitch(topicId: number | undefined, name: string, voiceDir: string, models: readonly string[], currentName: string): Promise<void>;
  handleAssistCommand(cmd: Extract<FleetCommand, { kind: "assist" }>, topicId: number | undefined): void;
  handleVoiceConfirmCommand(cmd: Extract<FleetCommand, { kind: "voiceconfirm" }>, topicId: number | undefined): void;
  renderDefaultModeConfirmation(mode: Mode): string;
  sendDefaultStatusCard(topicId: number | undefined): void;
  sendDefaultCategoryPicker(topicId: number | undefined, category: DefaultCategory): void;
  applyDefaultMode(mode: Mode): string;
  applyDefaultEffort(effort: Effort): string;
  handleDefaultCommand(cmd: Extract<FleetCommand, { kind: "default" }>, topicId: number | undefined): void;
  handleRouterBackendCommand(cmd: Extract<FleetCommand, { kind: "router" }>, topicId: number | undefined): void;
}

export function createVoiceModeCommands(opts: VoiceModeCommandsOptions): VoiceModeCommands {
  const {
    ptyIo,
    routing,
    sessionStore,
    settingsStore,
    controlBot,
    confirmSessionCommand,
    voiceServer,
    voiceModelPath,
    getAssistEnabled,
    setAssistEnabled,
    getVoiceConfirmEnabled,
    setVoiceConfirmEnabled,
    getDefaultSessionMode,
    setDefaultSessionMode,
    getDefaultSessionEffort,
    setDefaultSessionEffort,
    getNlRouterBackend,
    setNlRouterBackend,
    nlRouterApiKeyConfigured,
    supergroupChatId,
    log,
  } = opts;

  // Shared by the typed `/model foo` / `/mode bar` / `/effort baz` path and the button-tap path
  // (bare /model, /mode or /effort followed by a keyboard selection) - same switch, two triggers.
  function applyModelSwitch(slug: string, topicId: number, model: string): void {
    ptyIo.sendRaw(slug, `/model ${model}`);
    sessionStore.setModel(slug, model);
    confirmSessionCommand(topicId, `Switched ${slug} to ${model}`);
  }

  // Shared by applyModeSwitch (an operator-visible switch, with its own confirmation) and
  // handleNewCommand's `/defaultmode` application (silent - the new topic already gets its own
  // "Created ..." confirmation, and a second "Switched ... mode" message right after would just be
  // noise for something the operator already configured, not something they just asked for here).
  function writeModeKeystrokes(slug: string, mode: Mode): void {
    const current = routing.getMode(slug);
    const keystrokes = buildModeKeystrokes(current, mode);
    // Already at the target mode: no keystroke to send, and ptyIo.sendRaw("") would still submit a
    // spurious blank Enter at the prompt.
    if (keystrokes.length > 0) {
      routing.getPtyWrite(slug)?.(keystrokes);
    }
    routing.setMode(slug, mode);
  }

  function applyModeSwitch(slug: string, topicId: number, mode: Mode): void {
    writeModeKeystrokes(slug, mode);
    confirmSessionCommand(topicId, `Switched ${slug} to ${mode} mode`);
  }

  function applyEffortSwitch(slug: string, topicId: number, effort: Effort): void {
    ptyIo.sendEffortCommand(slug, effort);
    routing.setEffort(slug, effort);
    confirmSessionCommand(topicId, `Switched ${slug} to ${effort} effort`);
  }

  /** `/voice [<model>]` - control-topic-only (voice-model.ts), same reasoning as `/budget`/`/ls`:
   * there is exactly one whisper-server for the whole Bridge, not one per session, so there is
   * nothing to scope this to besides the fleet itself. Bare `/voice` lists what's on disk with a
   * button per model (current one checkmarked); `/voice <model>` or a button tap switches live via
   * `/load` - live-verified 2026-08-05, no process restart needed. */
  function handleVoiceModelCommand(cmd: Extract<FleetCommand, { kind: "voice" }>, topicId: number | undefined): void {
    if (!voiceServer) {
      confirmSessionCommand(topicId, "Voice input isn't enabled on this Bridge (VOICE_ENABLED=false).");
      return;
    }
    const voiceDir = path.dirname(voiceModelPath);
    const models = listAvailableVoiceModels(voiceDir);
    const currentName = path.basename(voiceServer.currentModelPath()).replace(/^ggml-/, "").replace(/\.bin$/, "");
    if (!cmd.model) {
      if (models.length === 0) {
        confirmSessionCommand(topicId, `No Whisper models found under ${voiceDir} - run scripts/setup-windows.ps1's voice step.`);
        return;
      }
      controlBot
        .sendMessage(supergroupChatId, topicId, `Current model: ${currentName}\nChoose a model:`, { inline_keyboard: buildVoiceModelKeyboard(models, currentName) })
        .catch((err) => log("WARN", `sendMessage (/voice) failed: ${(err as Error).message}`));
      return;
    }
    fireAndForget(applyVoiceModelSwitch(topicId, cmd.model, voiceDir, models, currentName), log, "voice-mode-commands applyVoiceModelSwitch");
  }

  /** Re-validates `name` against a freshly re-scanned model list rather than trusting the caller
   * (a typed `/voice <name>` argument is untrusted text; a button tap is re-checked too, since the
   * list on disk could have changed between the button being posted and tapped). */
  async function applyVoiceModelSwitch(topicId: number | undefined, name: string, voiceDir: string, models: readonly string[], currentName: string): Promise<void> {
    if (!voiceServer) return;
    if (name === currentName) {
      confirmSessionCommand(topicId, `🎤 Already using "${name}".`);
      return;
    }
    if (!models.includes(name)) {
      confirmSessionCommand(topicId, `Unknown model "${name}" - available: ${models.length > 0 ? models.join(", ") : "(none found)"}`);
      return;
    }
    try {
      await voiceServer.switchModel(path.join(voiceDir, `ggml-${name}.bin`));
      confirmSessionCommand(topicId, `🎤 Switched to "${name}".`);
    } catch (err) {
      confirmSessionCommand(topicId, `Failed to switch to "${name}": ${(err as Error).message}`);
    }
  }

  /** `/assist [on|off]` - whether an NL-matched destructive command shows a confirm card first
   * (nl-confirm.ts). `assistEnabled` is the in-memory copy every confirm-gate check reads;
   * `settingsStore` is only touched on an actual change, matching `feed_detail`/`feed_verbose`'s
   * own "in-memory for reads, persisted on write" shape (session-store.ts). */
  function handleAssistCommand(cmd: Extract<FleetCommand, { kind: "assist" }>, topicId: number | undefined): void {
    if (cmd.action === "status") {
      confirmSessionCommand(topicId, `Natural-language destructive-command confirmation is ${getAssistEnabled() ? "on" : "off"}.`);
      return;
    }
    const assistEnabled = cmd.action === "on";
    setAssistEnabled(assistEnabled);
    settingsStore.set("assist_enabled", assistEnabled ? "true" : "false");
    confirmSessionCommand(
      topicId,
      assistEnabled
        ? "Natural-language destructive-command confirmation is now on - kill/rm/restart/deploy/ship/repos-rm matched from plain text or voice will ask first."
        : "Natural-language destructive-command confirmation is now off - kill/rm/restart/deploy/ship/repos-rm matched from plain text or voice will run immediately.",
    );
  }

  /** `/voiceconfirm [on|off]` - whether a transcribed voice note shows a Send/Re-record/Type-
   * instead card first (voice-confirm.ts) or is auto-sent straight through. Same in-memory-for-
   * reads, persisted-on-write shape as `handleAssistCommand`. */
  function handleVoiceConfirmCommand(cmd: Extract<FleetCommand, { kind: "voiceconfirm" }>, topicId: number | undefined): void {
    if (cmd.action === "status") {
      confirmSessionCommand(topicId, `Voice-note send confirmation is ${getVoiceConfirmEnabled() ? "on" : "off"}.`);
      return;
    }
    const voiceConfirmEnabled = cmd.action === "on";
    setVoiceConfirmEnabled(voiceConfirmEnabled);
    settingsStore.set("voice_confirm_enabled", voiceConfirmEnabled ? "true" : "false");
    confirmSessionCommand(
      topicId,
      voiceConfirmEnabled
        ? "Voice-note send confirmation is now on - a transcribed voice note shows a Send/Re-record/Type-instead card before it's dispatched."
        : "Voice-note send confirmation is now off - a transcribed voice note is sent straight through, with the transcript still shown so you can see what was sent - /voiceconfirm on to review before sending again.",
    );
  }

  /** Text shown by both bare `/default` and the "Cancel"-free result of applying a mode change -
   * kept as one function so the two spots that need "what are the defaults right now" (the status
   * card and the mode-change confirmation) can't drift apart. */
  function renderDefaultModeConfirmation(mode: Mode): string {
    return mode === "auto"
      ? "New sessions will now start in auto mode - no permission prompts at all for any tool call, including git commit/push, until this is changed back. /default mode manual to revert."
      : `New sessions will now start in ${mode} mode.`;
  }

  /** `/default` (bare or `status`): both current values, plus a tappable Mode/Effort keyboard to
   * drill into either one (`session-commands.ts`'s `buildDefaultCategoryKeyboard`) - one command to
   * remember instead of two separately-named ones (operator feedback, 2026-08-07). Sent directly via
   * `controlBot`, not `confirmSessionCommand`, so the keyboard actually attaches - same reasoning as
   * the bare `/model`/`/mode`/`/effort` keyboards further down. */
  function sendDefaultStatusCard(topicId: number | undefined): void {
    const defaultSessionMode = getDefaultSessionMode();
    const defaultSessionEffort = getDefaultSessionEffort();
    controlBot
      .sendMessage(
        supergroupChatId,
        topicId,
        `New sessions currently start in ${defaultSessionMode} mode at ${defaultSessionEffort} effort. Tap one to change it:`,
        { inline_keyboard: buildDefaultCategoryKeyboard(defaultSessionMode, defaultSessionEffort) },
      )
      .catch((err) => log("WARN", `sendMessage (/default status) failed: ${(err as Error).message}`));
  }

  /** `/default mode` / `/default effort` with no value (typed, or reached by tapping a category
   * button from `sendDefaultStatusCard`'s keyboard): shows that category's own value picker, current
   * value marked, under the `defmode:`/`defeffort:` namespace (`session-commands.ts` - deliberately
   * not `mode:`/`effort:`, which resolve against `currentSlug` and would silently no-op here). */
  function sendDefaultCategoryPicker(topicId: number | undefined, category: DefaultCategory): void {
    const [prompt, keyboard] =
      category === "mode"
        ? [`Choose the default permission mode for new sessions (current: ${getDefaultSessionMode()}):`, buildDefaultModeKeyboard(getDefaultSessionMode())]
        : [`Choose the default effort level for new sessions (current: ${getDefaultSessionEffort()}):`, buildDefaultEffortKeyboard(getDefaultSessionEffort())];
    controlBot
      .sendMessage(supergroupChatId, topicId, prompt, { inline_keyboard: keyboard })
      .catch((err) => log("WARN", `sendMessage (/default ${category}) failed: ${(err as Error).message}`));
  }

  /** `/default mode <value>` / `/default effort <value>` (typed, or via the value pickers' own
   * callback taps in the `onUpdate` handler below) - the actual set-and-persist, shared by both
   * entry points so a typed command and a tapped button can't drift into different behavior.
   *
   * `mode`'s `auto` gets its own explicit warning in the confirmation text - it's the one
   * `nl-router.ts`'s `isDestructive` already treats as security-sensitive when reached via natural
   * language inside a live session, and setting it here has a wider blast radius than that
   * single-session case: every session launched from this point on starts with no permission
   * prompts at all, not just the one the operator is looking at right now, until this is explicitly
   * changed back. `effort` has no such warning - it's a cost/latency choice, not a safety one. */
  function applyDefaultMode(mode: Mode): string {
    setDefaultSessionMode(mode);
    settingsStore.set("default_session_mode", mode);
    return renderDefaultModeConfirmation(mode);
  }

  function applyDefaultEffort(effort: Effort): string {
    setDefaultSessionEffort(effort);
    settingsStore.set("default_session_effort", effort);
    return `New sessions will now start at ${effort} effort.`;
  }

  function handleDefaultCommand(cmd: Extract<FleetCommand, { kind: "default" }>, topicId: number | undefined): void {
    if (cmd.category === "status") {
      sendDefaultStatusCard(topicId);
      return;
    }
    if (cmd.category === "mode") {
      if (cmd.value === undefined) {
        sendDefaultCategoryPicker(topicId, "mode");
        return;
      }
      confirmSessionCommand(topicId, applyDefaultMode(cmd.value));
      return;
    }
    if (cmd.value === undefined) {
      sendDefaultCategoryPicker(topicId, "effort");
      return;
    }
    confirmSessionCommand(topicId, applyDefaultEffort(cmd.value));
  }

  /** `/router [api|cli]` - live switch for the NL-router backend, no restart needed either
   * direction. Switching to "api" is refused (not silently downgraded to "cli") when no key is
   * configured - the operator asked for the fast/paid path specifically, so a silent no-op would
   * be more confusing than telling them what's missing. */
  function handleRouterBackendCommand(cmd: Extract<FleetCommand, { kind: "router" }>, topicId: number | undefined): void {
    if (cmd.action === "status") {
      const nlRouterBackend = getNlRouterBackend();
      confirmSessionCommand(
        topicId,
        `Natural-language routing backend: ${nlRouterBackend}${nlRouterBackend === "cli" ? " (your Claude Code subscription)" : " (funded ANTHROPIC_API_KEY)"}.`,
      );
      return;
    }
    if (cmd.action === "api" && !nlRouterApiKeyConfigured) {
      confirmSessionCommand(topicId, "No ANTHROPIC_API_KEY configured in .env - add one first, then /router api.");
      return;
    }
    setNlRouterBackend(cmd.action);
    settingsStore.set("nl_router_backend", cmd.action);
    confirmSessionCommand(
      topicId,
      cmd.action === "api"
        ? "Natural-language routing now uses the API backend - faster, but each unmatched message has a small real cost."
        : "Natural-language routing now uses your Claude Code subscription (cli backend) - no extra cost, but slower per message.",
    );
  }

  return {
    applyModelSwitch,
    writeModeKeystrokes,
    applyModeSwitch,
    applyEffortSwitch,
    handleVoiceModelCommand,
    applyVoiceModelSwitch,
    handleAssistCommand,
    handleVoiceConfirmCommand,
    renderDefaultModeConfirmation,
    sendDefaultStatusCard,
    sendDefaultCategoryPicker,
    applyDefaultMode,
    applyDefaultEffort,
    handleDefaultCommand,
    handleRouterBackendCommand,
  };
}
