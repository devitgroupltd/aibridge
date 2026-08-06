import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initFileLogging, log, resetFileLogging } from "../src/logger.ts";

let stateDir: string;

afterEach(() => {
  resetFileLogging();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

describe("log", () => {
  test("writes nothing to a file until initFileLogging has been called", () => {
    // No stateDir at all here - the point is that a bare log() call (every existing caller/test
    // before this feature) must never throw or need one.
    expect(() => log("INFO", "no sink yet")).not.toThrow();
  });

  test("appends a line to the configured log file once initialized", () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-logger-"));
    initFileLogging(stateDir);

    log("INFO", "hello");
    log("WARN", "world");

    const contents = readFileSync(path.join(stateDir, "bridge.log"), "utf8");
    expect(contents).toContain("INFO hello");
    expect(contents).toContain("WARN world");
  });

  // The gap that defeated this module's entire purpose exactly when it mattered: on a fresh machine
  // (or before config.ts has created anything) `stateDir` doesn't exist, so every appendFileSync threw
  // ENOENT and was swallowed by the best-effort catch. The first boot is the one most likely to fail,
  // and it was the one guaranteed to have no log.
  test("creates a missing stateDir so the very first boot still gets a log file", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "aibridge-logger-fresh-"));
    stateDir = path.join(parent, "does", "not", "exist", "yet");
    initFileLogging(stateDir);

    log("INFO", "first boot");

    const contents = readFileSync(path.join(stateDir, "bridge.log"), "utf8");
    expect(contents).toContain("INFO first boot");
    stateDir = parent; // afterEach cleans the whole tree
  });

  test("a logging failure (unwritable stateDir) never throws out of log()", () => {
    // `initFileLogging` now creates a missing directory, so a merely-absent path no longer exercises
    // this - it has to be a path that cannot exist at all. A directory under a *file* is one:
    // mkdir fails with ENOTDIR/EEXIST and the subsequent append fails too.
    stateDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-logger-unwritable-"));
    const blockingFile = path.join(stateDir, "not-a-dir");
    writeFileSync(blockingFile, "i am a file\n");

    initFileLogging(path.join(blockingFile, "nested"));

    expect(() => log("ERROR", "should degrade silently")).not.toThrow();
    expect(existsSync(path.join(blockingFile, "nested", "bridge.log"))).toBe(false);
  });
});

describe("log file rotation", () => {
  test("rotates to a single .1 backup once the file exceeds the size cap", () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-logger-rotate-"));
    initFileLogging(stateDir);
    const logPath = path.join(stateDir, "bridge.log");
    const rotatedPath = `${logPath}.1`;

    // Seed the file past the 10MB cap directly - three real log() calls' rotation cost isn't the
    // point here, only that the *next* call rotates once the file is already over the line.
    writeFileSync(logPath, "x".repeat(10 * 1024 * 1024 + 1));
    expect(existsSync(rotatedPath)).toBe(false);

    log("INFO", "triggers rotation");

    expect(existsSync(rotatedPath)).toBe(true);
    const rotatedContents = readFileSync(rotatedPath, "utf8");
    expect(rotatedContents.length).toBeGreaterThan(10 * 1024 * 1024);
    const currentContents = readFileSync(logPath, "utf8");
    expect(currentContents).toContain("INFO triggers rotation");
    expect(currentContents.length).toBeLessThan(1000);
  });

  test("rotating twice replaces the old .1 rather than accumulating", () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-logger-rotate-twice-"));
    initFileLogging(stateDir);
    const logPath = path.join(stateDir, "bridge.log");
    const rotatedPath = `${logPath}.1`;

    writeFileSync(logPath, "a".repeat(10 * 1024 * 1024 + 1));
    log("INFO", "first rotation");
    writeFileSync(logPath, "b".repeat(10 * 1024 * 1024 + 1));
    log("INFO", "second rotation");

    const rotatedContents = readFileSync(rotatedPath, "utf8");
    expect(rotatedContents).toContain("b");
    expect(rotatedContents).not.toContain("a");
  });
});
