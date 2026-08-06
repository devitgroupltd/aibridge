import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../src/settings-store.ts";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    // Windows can hold the sqlite WAL file's handle open a beat past close() - same non-fatal
    // best-effort cleanup as voice-transcribe.ts's own temp-dir teardown, not a real assertion.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = undefined;
  }
});

async function freshDbPath(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-settings-test-"));
  return path.join(tmpDir, "aibridge.db");
}

describe("SettingsStore", () => {
  test("an absent key returns the caller's fallback, not undefined/null", async () => {
    const store = new SettingsStore(await freshDbPath());
    expect(store.get("nl_confirm_enabled", "true")).toBe("true");
    store.close();
  });

  test("set/get round-trips within the same instance", async () => {
    const store = new SettingsStore(await freshDbPath());
    store.set("nl_confirm_enabled", "false");
    expect(store.get("nl_confirm_enabled", "true")).toBe("false");
    store.close();
  });

  test("a value survives across a fresh SettingsStore instance against the same db file", async () => {
    const dbPath = await freshDbPath();
    const first = new SettingsStore(dbPath);
    first.set("nl_confirm_enabled", "false");
    first.close();

    const second = new SettingsStore(dbPath);
    expect(second.get("nl_confirm_enabled", "true")).toBe("false");
    second.close();
  });

  test("setting the same key twice overwrites rather than erroring on the primary key", async () => {
    const store = new SettingsStore(await freshDbPath());
    store.set("k", "1");
    store.set("k", "2");
    expect(store.get("k", "fallback")).toBe("2");
    store.close();
  });
});
