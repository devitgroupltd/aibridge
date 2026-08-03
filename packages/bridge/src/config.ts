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
  };
}

export { SECRETS_DIR, STATE_DIR };
