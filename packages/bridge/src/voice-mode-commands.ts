import path from "node:path";
import { fireAndForget } from "./fire-and-forget.ts";
import { buildVoiceModelKeyboard, listAvailableVoiceModels } from "./voice-model.ts";
import type { WhisperServerHandle } from "./voice-transcribe.ts";
import {
  buildDefaultCategoryKeyboard,
  buildDefaultEffortKeyboard,
  buildDefaultModeKeyboard,
  buildModeKeystrokeSteps,
} from "./session-commands.ts";
import type { InlineKeyboardButton } from "./session-commands.ts";
import type { DefaultPickerCategory, DefaultToggleCategory, Effort, Mode } from "./session-commands.ts";
import type { FleetCommand } from "./fleet-commands.ts";
import type { PtyIo } from "./pty-io.ts";
import type { Routing } from "./routing.ts";
import type { SessionStore } from "./session-store.ts";
import type { SettingsStore } from "./settings-store.ts";
import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import type { SendMessageSource } from "./telegram.ts";

/** §4.2's `/model`/`/mode`/`/effort`/`/voice` (including its `/voice confirm` sub-route and the
 * `/voiceconfirm` alias)/`/assist`/`/default`/`/router` fleet
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
  /** `/default permission|answer` (bypass-and-autoanswer-plan.md §0.4). Both halves, like mode/effort
   * above: this module writes them, and `sendDefaultStatusCard` needs to *read* them live to render
   * each toggle row's label and its inverse-valued `callback_data`. */
  getDefaultBypassEnabled: () => boolean;
  setDefaultBypassEnabled: (value: boolean) => void;
  getDefaultAutoAnswerEnabled: () => boolean;
  setDefaultAutoAnswerEnabled: (value: boolean) => void;
  getNlRouterBackend: () => "api" | "cli";
  setNlRouterBackend: (backend: "api" | "cli") => void;
  nlRouterApiKeyConfigured: boolean;
  supergroupChatId: string;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
  /** Injectable in place of the real `setTimeout`, same convention as `pty-io.ts` - lets
   * `writeModeKeystrokes`' spaced presses be asserted without real waits. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

/** Gap between consecutive Shift+Tab presses. Comfortably longer than a TUI render frame without
 * making a three-step switch feel laggy; `sendEffortCommand`'s own 200ms inter-write delay for the
 * same class of problem is the precedent. */
export const MODE_KEYSTROKE_GAP_MS = 150;

export interface VoiceModeCommands {
  applyModelSwitch(slug: string, topicId: number, model: string): void;
  writeModeKeystrokes(slug: string, mode: Mode): void;
  applyModeSwitch(slug: string, topicId: number, mode: Mode): void;
  applyEffortSwitch(slug: string, topicId: number, effort: Effort): void;
  handleVoiceModelCommand(cmd: Extract<FleetCommand, { kind: "voice"; category: "model" }>, topicId: number | undefined): void;
  applyVoiceModelSwitch(topicId: number | undefined, name: string, voiceDir: string, models: readonly string[], currentName: string): Promise<void>;
  handleAssistCommand(cmd: Extract<FleetCommand, { kind: "assist" }>, topicId: number | undefined): void;
  handleVoiceConfirmCommand(cmd: Extract<FleetCommand, { kind: "voice"; category: "confirm" }>, topicId: number | undefined): void;
  handleVoiceCommand(cmd: Extract<FleetCommand, { kind: "voice" }>, topicId: number | undefined): void;
  renderDefaultModeConfirmation(mode: Mode): string;
  sendDefaultStatusCard(topicId: number | undefined): void;
  sendDefaultCategoryPicker(topicId: number | undefined, category: DefaultPickerCategory): void;
  applyDefaultMode(mode: Mode): string;
  applyDefaultEffort(effort: Effort): string;
  applyDefaultAutoToggle(category: DefaultToggleCategory, value: boolean): string;
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
    getDefaultBypassEnabled,
    setDefaultBypassEnabled,
    getDefaultAutoAnswerEnabled,
    setDefaultAutoAnswerEnabled,
    getNlRouterBackend,
    setNlRouterBackend,
    nlRouterApiKeyConfigured,
    supergroupChatId,
    log,
  } = opts;
  const setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

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
    const steps = buildModeKeystrokeSteps(current, mode);
    // Already at the target mode: nothing to send, and a zero-length write would still be a
    // spurious keystroke at the prompt.
    const write = routing.getPtyWrite(slug);
    if (write) {
      // One press per tick, not `SHIFT_TAB.repeat(n)` in a single write. Live-reproduced 2026-08-10:
      // a three-press burst for manual->auto advanced the picker exactly once (`manual` -> `accept
      // edits on`), because the TUI consumes one key per render frame and drops the rest of the
      // buffer - the same class of PTY-timing hazard as `sendEffortCommand`'s confirming `\r`
      // arriving before its dialog has rendered, and fixed the same way. New sessions no longer
      // depend on this at all (they get `--permission-mode` at launch); this path is the live
      // `/mode` switch, which has no CLI equivalent mid-session.
      steps.forEach((keystroke, i) => {
        if (i === 0) write(keystroke);
        else setTimeoutFn(() => write(keystroke), MODE_KEYSTROKE_GAP_MS * i);
      });
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
  function handleVoiceModelCommand(cmd: Extract<FleetCommand, { kind: "voice"; category: "model" }>, topicId: number | undefined): void {
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
        ? "Natural-language destructive-command confirmation is now on - kill/remove/restart/merge/ship/repos-rm matched from plain text or voice will ask first."
        : "Natural-language destructive-command confirmation is now off - kill/remove/restart/merge/ship/repos-rm matched from plain text or voice will run immediately.",
    );
  }

  /** `/voice confirm [on|off]` (plus its `/voiceconfirm [on|off]` alias) - whether a transcribed
   * voice note shows a Send/Re-record/Type-instead card first (voice-confirm.ts) or is auto-sent
   * straight through. Same in-memory-for-reads, persisted-on-write shape as `handleAssistCommand`. */
  function handleVoiceConfirmCommand(cmd: Extract<FleetCommand, { kind: "voice"; category: "confirm" }>, topicId: number | undefined): void {
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
        : "Voice-note send confirmation is now off - a transcribed voice note is sent straight through, with the transcript still shown so you can see what was sent - /voice confirm on to review before sending again.",
    );
  }

  /** `/voice`'s own dispatch: `command-dispatch.ts`'s single entry point for the whole unified
   * command, routed on to whichever facet-specific handler above actually owns it - same
   * exhaustive-`switch`-over-a-real-discriminant shape as `handleDefaultCommand`, for the same
   * reason (a future third `/voice` facet fails to compile here instead of silently falling
   * through to one of these two). */
  function handleVoiceCommand(cmd: Extract<FleetCommand, { kind: "voice" }>, topicId: number | undefined): void {
    switch (cmd.category) {
      case "model":
        handleVoiceModelCommand(cmd, topicId);
        return;
      case "confirm":
        handleVoiceConfirmCommand(cmd, topicId);
        return;
      default: {
        const _exhaustive: never = cmd;
        throw new Error(`unhandled /voice category: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /** Text shown by both bare `/default` and the "Cancel"-free result of applying a mode change -
   * kept as one function so the two spots that need "what are the defaults right now" (the status
   * card and the mode-change confirmation) can't drift apart. */
  function renderDefaultModeConfirmation(mode: Mode): string {
    // The old text claimed auto mode meant "no permission prompts at all for any tool call,
    // including git commit/push". That is false, per Claude Code's own current docs: auto mode still
    // forces a prompt for every `permissions.ask` rule match - and `settings.ts` deliberately puts
    // git commit/push there (CLAUDE.md decision 3) - and it falls back to full manual prompting
    // after 3 consecutive or 20 total classifier blocks. Overstating this is worse than saying
    // nothing: an operator who believes it stops expecting the cards that will still arrive, and
    // reaches for the wrong control when they do. `/auto permission` is the one that actually makes
    // that promise, so it's named here rather than left to be discovered.
    return mode === "auto"
      ? "New sessions will now start in auto mode - most tool calls run without a prompt, but anything on the ask list (git commit/push, PR merge, npm publish) still asks, and Claude Code falls back to prompting for everything after repeated classifier blocks. /default mode manual to revert. For genuinely no prompts at all, use /default permission on instead - that's a Bridge-level auto-allow and isn't subject to either limit."
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
    const defaultBypass = getDefaultBypassEnabled();
    const defaultAutoAnswer = getDefaultAutoAnswerEnabled();
    const autoNote = defaultBypass || defaultAutoAnswer ? ` Auto-permission ${defaultBypass ? "on" : "off"}, auto-answer ${defaultAutoAnswer ? "on" : "off"}.` : "";
    controlBot
      .sendMessage(
        supergroupChatId,
        topicId,
        `New sessions currently start in ${defaultSessionMode} mode at ${defaultSessionEffort} effort.${autoNote} Tap one to change it:`,
        { inline_keyboard: buildDefaultCategoryKeyboard(defaultSessionMode, defaultSessionEffort, defaultBypass, defaultAutoAnswer) },
      )
      .catch((err) => log("WARN", `sendMessage (/default status) failed: ${(err as Error).message}`));
  }

  /** `/default mode` / `/default effort` with no value (typed, or reached by tapping a category
   * button from `sendDefaultStatusCard`'s keyboard): shows that category's own value picker, current
   * value marked, under the `defmode:`/`defeffort:` namespace (`session-commands.ts` - deliberately
   * not `mode:`/`effort:`, which resolve against `currentSlug` and would silently no-op here). */
  function sendDefaultCategoryPicker(topicId: number | undefined, category: DefaultPickerCategory): void {
    // Exhaustive, and typed to the picker categories only: `permission`/`answer` are booleans with
    // no picker to show, so they can't reach here at all rather than being silently handed the
    // effort screen the way a two-way ternary over a widened union would have done.
    const [prompt, keyboard] = ((): [string, InlineKeyboardButton[][]] => {
      switch (category) {
        case "mode":
          return [`Choose the default permission mode for new sessions (current: ${getDefaultSessionMode()}):`, buildDefaultModeKeyboard(getDefaultSessionMode())];
        case "effort":
          return [`Choose the default effort level for new sessions (current: ${getDefaultSessionEffort()}):`, buildDefaultEffortKeyboard(getDefaultSessionEffort())];
        default: {
          const _exhaustive: never = category;
          throw new Error(`unhandled /default picker category: ${_exhaustive}`);
        }
      }
    })();
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

  /** The two boolean categories' per-category differences, resolved once behind a single `never`
   * arm - same descriptor discipline as `session-lifecycle-commands.ts`'s `autoCategorySpec`, and
   * for the same reason: every consumer here (`handleDefaultCommand`'s status form, its set form,
   * and the callback router's tap) reads this rather than switching again. */
  function defaultToggleSpec(category: DefaultToggleCategory): { label: string; get: () => boolean; set: (value: boolean) => void; settingsKey: string; confirmation: (value: boolean) => string } {
    switch (category) {
      case "permission":
        return {
          label: "auto-permission",
          get: getDefaultBypassEnabled,
          set: setDefaultBypassEnabled,
          settingsKey: "default_bypass_enabled",
          confirmation: (value) =>
            value
              ? "New sessions will now start with auto-permission ON - every permission prompt they'd otherwise raise, including git commit/push, is auto-allowed from their very first turn. /default permission off to revert (only affects sessions created after that point - see /auto permission --all off to also flip already-running ones)."
              : "New sessions will now start with auto-permission off - they'll ask before anything outside the allowlist. Already-running sessions keep whatever they're set to (/auto permission --all off to flip those too).",
        };
      case "answer":
        return {
          label: "auto-answer",
          get: getDefaultAutoAnswerEnabled,
          set: setDefaultAutoAnswerEnabled,
          settingsKey: "default_autoanswer_enabled",
          confirmation: (value) =>
            value
              ? "New sessions will now start with auto-answer ON - from their first turn, a question where Claude marked exactly one option as recommended is answered automatically, with no card posted. Anything less clear still shows you the real buttons. /default answer off to revert (only affects sessions created after that point)."
              : "New sessions will now start with auto-answer off - questions show you the real buttons. Already-running sessions keep whatever they're set to (/auto answer --all off to flip those too).",
        };
      default: {
        const _exhaustive: never = category;
        throw new Error(`unhandled /default toggle category: ${_exhaustive}`);
      }
    }
  }

  /** Shared by the typed `/default permission on` path and the status card's own toggle-row taps,
   * so the two can't drift - and doing the three-part write-through the persisted fleet defaults all
   * need: the in-memory `let` (via the injected setter, which is what `handleNewCommand` reads) *and*
   * the settings row that rehydrates it on the next Bridge start. */
  function applyDefaultAutoToggle(category: DefaultToggleCategory, value: boolean): string {
    const spec = defaultToggleSpec(category);
    spec.set(value);
    settingsStore.set(spec.settingsKey, String(value));
    return spec.confirmation(value);
  }

  /**
   * An exhaustive `switch`, not the `if`/`if`/implicit-tail shape this replaced. That tail treated
   * "anything that isn't status or mode" as effort, so `/default permission on` used to reach
   * `applyDefaultEffort(true)` - writing a boolean into `default_session_effort`, reporting "New
   * sessions will now start at true effort", leaving `permission` untouched, and corrupting a
   * persisted setting the operator never asked to change (one `index.ts` reads back at every
   * startup). With four categories the root fix is exhaustiveness: a fifth fails to compile here
   * instead of silently landing in someone else's branch.
   */
  function handleDefaultCommand(cmd: Extract<FleetCommand, { kind: "default" }>, topicId: number | undefined): void {
    switch (cmd.category) {
      case "status":
        sendDefaultStatusCard(topicId);
        return;
      case "mode":
        if (cmd.value === undefined) sendDefaultCategoryPicker(topicId, "mode");
        else confirmSessionCommand(topicId, applyDefaultMode(cmd.value));
        return;
      case "effort":
        if (cmd.value === undefined) sendDefaultCategoryPicker(topicId, "effort");
        else confirmSessionCommand(topicId, applyDefaultEffort(cmd.value));
        return;
      case "permission":
      case "answer": {
        // Bare = reports, never toggles (same rule as `/auto`'s own bare form): a status read must
        // not flip a safety gate. No value picker either - there's nothing to pick between.
        const spec = defaultToggleSpec(cmd.category);
        if (cmd.value === undefined) {
          confirmSessionCommand(topicId, `New sessions currently start with ${spec.label} ${spec.get() ? "on" : "off"}. /default ${cmd.category} ${spec.get() ? "off" : "on"} to change it.`);
          return;
        }
        confirmSessionCommand(topicId, applyDefaultAutoToggle(cmd.category, cmd.value));
        return;
      }
      default: {
        const _exhaustive: never = cmd;
        throw new Error(`unhandled /default category: ${JSON.stringify(_exhaustive)}`);
      }
    }
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
    handleVoiceCommand,
    renderDefaultModeConfirmation,
    sendDefaultStatusCard,
    sendDefaultCategoryPicker,
    applyDefaultMode,
    applyDefaultEffort,
    applyDefaultAutoToggle,
    handleDefaultCommand,
    handleRouterBackendCommand,
  };
}
