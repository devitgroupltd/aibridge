import { DEFAULT_EFFORT, DEFAULT_MODE, EFFORTS, MODES } from "./session-commands.ts";
import type { Effort, Mode } from "./session-commands.ts";

/**
 * The seven fleet-wide preferences that are read from memory, written through to `bridge_settings`,
 * and rehydrated at the next boot: `/assist`, `/voice confirm`, `/router`, and `/default`'s four
 * categories (mode, effort, permission, answer).
 *
 * Each of these used to be a mutable `let` in `index.ts` with three separate obligations spread
 * across three modules: a bespoke decode expression at load (four different shapes for what is the
 * same "unrecognised stored value falls back to the default" rule), a `get`/`set` closure pair
 * threaded into three or four consumers (~110 references between them), and - at every write site,
 * in `voice-mode-commands.ts` and `callback-query-router.ts` - a `settingsStore.set(key, ...)` call
 * that had to be remembered *alongside* calling the setter, with its own hand-written encoding.
 *
 * Nothing was wrong with any of the nine write sites as they stood. The problem was that the
 * encode/decode pair for a given key lived in two different files, and that "call the setter" and
 * "persist it" were two independent things a caller had to get right, enforced only by convention:
 * a setter called without its `settingsStore.set` would work perfectly until the next restart, then
 * silently revert. Here, setting a value *is* persisting it - there is no way to do one without the
 * other - and each key's encoding sits next to its decoding.
 *
 * `store` is the narrow two-method port `SettingsStore` already satisfies, so a test can back this
 * with a plain `Map` instead of a database.
 */
export interface SettingsStorePort {
  get(key: string, fallback: string): string;
  set(key: string, value: string): void;
}

/** How one setting crosses the text-only boundary `bridge_settings` stores values behind. Written
 * once per setting below, so encode and decode can't drift apart. */
interface Codec<T> {
  key: string;
  fallback: string;
  decode: (raw: string) => T;
  encode: (value: T) => string;
}

/**
 * A boolean whose stored form is `"true"`/`"false"`, and whose *default* decides which literal is
 * load-bearing: a default-on setting is only switched off by an explicit `"false"`, a default-off
 * one is only switched on by an explicit `"true"`. Either way an unrecognised value (a downgrade
 * past a format change, a hand-edited row) reads as the default rather than as its opposite.
 */
function boolSetting(key: string, defaultOn: boolean): Codec<boolean> {
  return {
    key,
    fallback: defaultOn ? "true" : "false",
    decode: (raw) => (defaultOn ? raw !== "false" : raw === "true"),
    encode: (value) => (value ? "true" : "false"),
  };
}

/** A value from a fixed set, re-validated on load: a stored value the current build no longer
 * recognises (a mode added, then removed) falls back to the default rather than being handed on to
 * a caller that will assume it is valid - the same defensive re-validation `isMode`/`isEffort`
 * already apply to callback data. */
function enumSetting<T extends string>(key: string, values: readonly string[], fallback: T): Codec<T> {
  return {
    key,
    fallback,
    decode: (raw) => (values.includes(raw) ? (raw as T) : fallback),
    encode: (value) => value,
  };
}

export type NlRouterBackend = "api" | "cli";

/** The seven values, named once so the codec table and the in-memory copy below can't drift out of
 * step with each other. */
interface RuntimeSettingValues {
  assist: boolean;
  voiceConfirm: boolean;
  defaultMode: Mode;
  defaultEffort: Effort;
  defaultBypass: boolean;
  defaultAutoAnswer: boolean;
  nlRouterBackend: NlRouterBackend;
}

type RuntimeSettingCodecs = { [K in keyof RuntimeSettingValues]: Codec<RuntimeSettingValues[K]> };

export class RuntimeSettings {
  private readonly store: SettingsStorePort;
  private readonly codecs: RuntimeSettingCodecs;
  private readonly values: RuntimeSettingValues;

  /**
   * `nlRouterBackendDefault` comes from `config.ts` rather than being hardcoded here: it is the one
   * setting whose out-of-the-box value is itself configurable (`NL_ROUTER_BACKEND`), and see that
   * field's own doc comment for why an API key's mere presence must never switch it on its own.
   *
   * The two "confirm first" toggles default *on* (Whisper's accuracy varies enough by language that
   * skipping the review step should be an explicit opt-in) while the two `/default` auto-toggles
   * default *off* - deliberately opposite, because the first pair defaults a confirmation on and the
   * second pair defaults one away, so fail-safe points in opposite directions for them.
   */
  constructor(store: SettingsStorePort, nlRouterBackendDefault: NlRouterBackend) {
    this.store = store;
    this.codecs = {
      assist: boolSetting("assist_enabled", true),
      voiceConfirm: boolSetting("voice_confirm_enabled", true),
      defaultMode: enumSetting<Mode>("default_session_mode", MODES, DEFAULT_MODE),
      defaultEffort: enumSetting<Effort>("default_session_effort", EFFORTS, DEFAULT_EFFORT),
      defaultBypass: boolSetting("default_bypass_enabled", false),
      defaultAutoAnswer: boolSetting("default_autoanswer_enabled", false),
      nlRouterBackend: enumSetting<NlRouterBackend>("nl_router_backend", ["api", "cli"], nlRouterBackendDefault),
    };
    this.values = {
      assist: this.load(this.codecs.assist),
      voiceConfirm: this.load(this.codecs.voiceConfirm),
      defaultMode: this.load(this.codecs.defaultMode),
      defaultEffort: this.load(this.codecs.defaultEffort),
      defaultBypass: this.load(this.codecs.defaultBypass),
      defaultAutoAnswer: this.load(this.codecs.defaultAutoAnswer),
      nlRouterBackend: this.load(this.codecs.nlRouterBackend),
    };
  }

  private load<T>(codec: Codec<T>): T {
    return codec.decode(this.store.get(codec.key, codec.fallback));
  }

  /** In-memory for reads, persisted on write - the shape `feed_detail`/`feed_verbose` already use
   * (session-store.ts). The store write happens first, so a throwing store can't leave memory
   * claiming a value that was never saved. */
  private write<K extends keyof RuntimeSettingValues>(name: K, value: RuntimeSettingValues[K]): void {
    const codec = this.codecs[name];
    this.store.set(codec.key, codec.encode(value));
    this.values[name] = value;
  }

  /** `/assist` - whether an NL-matched destructive command shows a confirm card first. */
  get assistEnabled(): boolean {
    return this.values.assist;
  }
  setAssistEnabled(value: boolean): void {
    this.write("assist", value);
  }

  /** `/voice confirm` - whether a transcribed voice note shows a Send/Re-record/Type-instead card
   * before it is dispatched. */
  get voiceConfirmEnabled(): boolean {
    return this.values.voiceConfirm;
  }
  setVoiceConfirmEnabled(value: boolean): void {
    this.write("voiceConfirm", value);
  }

  /** `/default mode` - the permission mode every *new* session starts in. Standing configuration
   * for sessions that don't exist yet, distinct from a live session's own per-slug `routing.ts`
   * value. */
  get defaultSessionMode(): Mode {
    return this.values.defaultMode;
  }
  setDefaultSessionMode(value: Mode): void {
    this.write("defaultMode", value);
  }

  /** `/default effort` - same "applies to new sessions only" scope as `defaultSessionMode`. */
  get defaultSessionEffort(): Effort {
    return this.values.defaultEffort;
  }
  setDefaultSessionEffort(value: Effort): void {
    this.write("defaultEffort", value);
  }

  /** `/default permission` - the new-session default for `/auto permission`. */
  get defaultBypassEnabled(): boolean {
    return this.values.defaultBypass;
  }
  setDefaultBypassEnabled(value: boolean): void {
    this.write("defaultBypass", value);
  }

  /** `/default answer` - the new-session default for `/auto answer`. */
  get defaultAutoAnswerEnabled(): boolean {
    return this.values.defaultAutoAnswer;
  }
  setDefaultAutoAnswerEnabled(value: boolean): void {
    this.write("defaultAutoAnswer", value);
  }

  /** `/router` - which backend natural-language routing uses. */
  get nlRouterBackend(): NlRouterBackend {
    return this.values.nlRouterBackend;
  }
  setNlRouterBackend(value: NlRouterBackend): void {
    this.write("nlRouterBackend", value);
  }
}

/** A `SettingsStorePort` backed by a plain `Map` - for tests, and for anything that wants the
 * in-memory half of this without a database file. */
export function memorySettingsStore(initial: Record<string, string> = {}): SettingsStorePort {
  const values = new Map(Object.entries(initial));
  return {
    get: (key, fallback) => values.get(key) ?? fallback,
    set: (key, value) => {
      values.set(key, value);
    },
  };
}
