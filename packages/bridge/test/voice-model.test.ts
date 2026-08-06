import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildVoiceModelKeyboard, listAvailableVoiceModels, resolveVoiceModelCallback } from "../src/voice-model.ts";

async function withVoiceDir(files: string[], run: (dir: string) => void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-voice-model-test-"));
  try {
    for (const name of files) await fs.writeFile(path.join(dir, name), "");
    run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("listAvailableVoiceModels", () => {
  test("finds ggml-<name>.bin files and strips the prefix/suffix", async () => {
    await withVoiceDir(["ggml-small.bin", "ggml-medium.bin", "not-a-model.txt"], (dir) => {
      expect(listAvailableVoiceModels(dir)).toEqual(["medium", "small"]);
    });
  });

  test("returns an empty list, not a throw, for a directory that doesn't exist", () => {
    expect(listAvailableVoiceModels("C:\\definitely\\does\\not\\exist")).toEqual([]);
  });

  test("returns an empty list for an empty directory", async () => {
    await withVoiceDir([], (dir) => {
      expect(listAvailableVoiceModels(dir)).toEqual([]);
    });
  });

  test("ignores files that don't match the ggml-<name>.bin shape", async () => {
    await withVoiceDir(["whisper-server.exe", "ggml-small.bin.tmp", "ggml.bin"], (dir) => {
      expect(listAvailableVoiceModels(dir)).toEqual([]);
    });
  });
});

describe("buildVoiceModelKeyboard / resolveVoiceModelCallback", () => {
  test("one button per model, each round-tripping through resolveVoiceModelCallback", () => {
    const keyboard = buildVoiceModelKeyboard(["small", "medium"], "small");
    const flat = keyboard.flat();
    expect(flat).toHaveLength(2);
    expect(flat.map((btn) => resolveVoiceModelCallback(btn.callback_data!))).toEqual(["small", "medium"]);
  });

  test("the current model's button is checkmarked, others are plain", () => {
    const keyboard = buildVoiceModelKeyboard(["small", "medium"], "medium");
    const labels = keyboard.flat().map((btn) => btn.text);
    expect(labels).toEqual(["small", "✅ medium"]);
  });

  test("rejects a different namespace", () => {
    expect(resolveVoiceModelCallback("vc:abcde123:s")).toBeNull();
    expect(resolveVoiceModelCallback("d:slug:1")).toBeNull();
    expect(resolveVoiceModelCallback("garbage")).toBeNull();
  });
});
