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
  /** Phase-1-only hardcoded test session (§12 Phase 1) - superseded by /new + repos.toml in Phase 5. */
  phase1: {
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
    phase1: {
      slug: parsed.PHASE1_SLUG || "test-session",
      topicId: Number(parsed.PHASE1_TOPIC_ID || "3"),
      repoPath: parsed.PHASE1_REPO_PATH || path.resolve(import.meta.dirname, "../../.."),
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
  };
}

export { SECRETS_DIR, STATE_DIR };
