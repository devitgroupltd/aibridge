import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Parses a `KEY=VALUE` env file's contents. Blank lines and lines starting with `#` are
 * skipped. A line with no `=` is a silent-wrong risk (a typo'd line would otherwise vanish with
 * no signal) so it throws naming the offending line, rather than being quietly ignored.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = contents.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      throw new Error(`malformed line ${i + 1} in env file: "${line}" (expected KEY=VALUE)`);
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key.length === 0) {
      throw new Error(`malformed line ${i + 1} in env file: "${line}" (empty key)`);
    }
    result[key] = value;
  }
  return result;
}

export interface BridgeConfig {
  controlBotToken: string;
  feedBotToken: string;
  supergroupChatId: string;
  /** A permanent internal smoke-test session the Bridge always (re)launches at startup, on a fixed
   * hardcoded topic, to verify it can spawn a session at all - not an operator-created one, and not
   * discoverable as its own named Telegram topic (renamed 2026-08-07 from `phase1`/`PHASE1_*`, a
   * name left over from when this was the Phase-1 walking-skeleton's only session; the identifier
   * was confined to config.ts/index.ts and no PHASE1_* var was ever actually set in a live `.env`,
   * so the rename needed no migration). */
  selfCheck: {
    slug: string;
    topicId: number;
    repoPath: string;
  };
  /** Voice-input (self-hosted Whisper via whisper.cpp) - `enabled` is false unless
   * `scripts/setup-windows.ps1`'s voice step has actually installed ffmpeg + whisper-server +
   * a model, since none of that can be assumed present on a fresh machine. */
  voice: {
    enabled: boolean;
    ffmpegPath: string;
    whisperServerExe: string;
    modelPath: string;
    port: number;
    threads: number;
  };
  /**
   * Natural-language command routing (nl-router.ts). `enabled` defaults on, same convention as
   * `voice.enabled`. Two backends, live-measured 2026-08-06 (see the plan's changelog for the
   * numbers) - neither is a clear default for every operator (§4.1.1: each operator runs their own
   * independent instance with their own budget), so this is explicitly per-instance config, not a
   * fixed choice:
   *
   * - `"api"` - a direct `@anthropic-ai/sdk` call. ~200-500ms, real but small pay-per-token cost
   *   (a funded Anthropic Console API key, separate from the Claude Code subscription).
   * - `"cli"` - `claude -p --json-schema` using the operator's existing Claude Code subscription.
   *   No new billing, but measured live at 3.5-5.4s per call and ~20-30k tokens of the CLI's own
   *   fixed system-prompt/tool-schema overhead *even from an empty directory with nothing else to
   *   load* - that overhead is charged against the subscription's own usage/rate-limit budget
   *   (§10.5's `/budget`), not a separate dollar cost, but a real one nonetheless.
   *
   * `backend` **always defaults to `"cli"`**, even when `apiKey` is set - per explicit operator
   * direction (2026-08-06): configuring a key must never silently start spending real money: the
   * operator opts in to `"api"` deliberately, either via `NL_ROUTER_BACKEND=api` here or live via
   * `/router api` (index.ts, backed by `settings-store.ts` - no restart needed either direction,
   * and switching back to `/router cli` at any time is exactly as supported as switching to it).
   */
  nlRouter: {
    enabled: boolean;
    apiKey: string | undefined;
    model: string;
    backend: "api" | "cli";
    /** Control-topic free-form Q&A's history window (`plans/control-topic-nl-dialogue-plan.md`
     * §6-7) - the number of recent operator/bot exchange pairs fed as context into both the
     * classifier call and the new Q&A call. `0` disables the window entirely (no history sent).
     * Always CLI-side regardless of `backend` above - see `nl-router.ts`'s
     * `answerControlTopicQuestion` doc comment for why this feature never uses the API backend. */
    historyTurns: number;
  };
}

const SECRETS_DIR = path.join(process.env.APPDATA ?? "", "aibridge");
const STATE_DIR = path.join(process.env.LOCALAPPDATA ?? "", "aibridge");

export function loadConfig(envPath = path.join(SECRETS_DIR, ".env")): BridgeConfig {
  const parsed = parseEnvFile(readFileSync(envPath, "utf8"));

  const required = (key: string): string => {
    const value = parsed[key];
    if (!value) {
      throw new Error(`${key} is missing or empty in ${envPath}`);
    }
    return value;
  };

  return {
    controlBotToken: required("CONTROL_BOT_TOKEN"),
    feedBotToken: required("FEED_BOT_TOKEN"),
    supergroupChatId: required("SUPERGROUP_CHAT_ID"),
    selfCheck: {
      slug: parsed.SELF_CHECK_SLUG || "test-session",
      topicId: Number(parsed.SELF_CHECK_TOPIC_ID || "3"),
      repoPath: parsed.SELF_CHECK_REPO_PATH || path.resolve(import.meta.dirname, "../../.."),
    },
    voice: {
      // Defaults to enabled (unlike a real risk like the git-push SSH key, this is just a local
      // child process - startWhisperServer itself no-ops with a one-time WARN, not a crash loop,
      // if the setup step hasn't installed the binary/model yet). Set VOICE_ENABLED=false to opt out.
      enabled: parsed.VOICE_ENABLED !== "false",
      ffmpegPath: parsed.FFMPEG_PATH || "ffmpeg",
      // Live-verified 2026-08-05: whisper-bin-x64.zip extracts into its own Release\ subfolder,
      // not flat - see setup-windows.ps1's matching comment.
      whisperServerExe: parsed.WHISPER_SERVER_EXE || path.join(STATE_DIR, "voice", "Release", "whisper-server.exe"),
      // small, not medium: benchmarked live 2026-08-05 - medium/4t took 16.1s to transcribe an 8s
      // clip on a 6-core box, small/6t took 3.7s. Model size was the actual bottleneck; the
      // accuracy gap (small vs medium) is a modest cost given the transcript is always reviewed
      // before it's sent anyway (voice-confirm.ts) - see the plan's changelog entry for the numbers.
      modelPath: parsed.WHISPER_MODEL_PATH || path.join(STATE_DIR, "voice", "ggml-small.bin"),
      port: Number(parsed.WHISPER_SERVER_PORT || "8383"),
      // Defaults to every logical core - inference is brief (a few seconds) and infrequent enough
      // that saturating the CPU briefly beats a slow transcription. Override via WHISPER_THREADS
      // if this ever needs to leave headroom for other work happening at the same time.
      threads: Number(parsed.WHISPER_THREADS || String(os.cpus().length || 4)),
    },
    nlRouter: {
      enabled: parsed.NL_ROUTER_ENABLED !== "false",
      apiKey: parsed.ANTHROPIC_API_KEY || undefined,
      // Haiku tier: the router makes one forced-structured-output request per unmatched
      // message, so cost and latency both scale with fleet-wide message volume - see
      // nl-router.ts's own note.
      model: parsed.NL_ROUTER_MODEL || "claude-haiku-4-5-20251001",
      // Always "cli" unless explicitly forced - see this block's own doc comment for why an
      // API key's mere presence must never silently switch this. index.ts's `/router` command
      // is the live, restart-free way to actually switch, backed by settings-store.ts; this is
      // only the one-time startup default before any live override has been set.
      backend: parsed.NL_ROUTER_BACKEND === "api" ? "api" : "cli",
      // Default 4 - see plans/control-topic-nl-dialogue-plan.md §7 for the research behind this
      // number (a "sweet spot" between chatbot-memory conventions and intent-classification-
      // specific findings, which favor a short window over a long one). Set to 0 to disable.
      historyTurns: Number(parsed.NL_ROUTER_HISTORY_TURNS ?? "4"),
    },
  };
}

export { SECRETS_DIR, STATE_DIR };
