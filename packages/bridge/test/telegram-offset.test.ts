import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOffset, saveOffset } from "../src/telegram-offset.ts";

let dir: string;
let offsetPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-offset-"));
  offsetPath = path.join(dir, "telegram-offset.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadOffset/saveOffset", () => {
  test("round-trips a saved offset", () => {
    saveOffset(offsetPath, 123);
    expect(loadOffset(offsetPath)).toBe(123);
  });

  test("defaults to 0 when the file doesn't exist yet", () => {
    expect(loadOffset(offsetPath)).toBe(0);
  });

  test("defaults to 0 for malformed content rather than throwing", () => {
    writeFileSync(offsetPath, "not json");
    expect(loadOffset(offsetPath)).toBe(0);
  });

  test("defaults to 0 when the offset field is missing or the wrong type", () => {
    writeFileSync(offsetPath, JSON.stringify({ offset: "nope" }));
    expect(loadOffset(offsetPath)).toBe(0);
  });
});
