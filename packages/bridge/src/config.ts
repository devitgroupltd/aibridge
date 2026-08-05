import { readFileSync } from "node:fs";
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
      enabled: parsed.VOICE_ENABLED === "true",
      ffmpegPath: parsed.FFMPEG_PATH || "ffmpeg",
      whisperServerExe: parsed.WHISPER_SERVER_EXE || path.join(STATE_DIR, "voice", "whisper-server.exe"),
      modelPath: parsed.WHISPER_MODEL_PATH || path.join(STATE_DIR, "voice", "ggml-medium.bin"),
      port: Number(parsed.WHISPER_SERVER_PORT || "8383"),
    },
  };
}

export { SECRETS_DIR, STATE_DIR };
