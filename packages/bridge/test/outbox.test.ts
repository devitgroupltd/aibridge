import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureOutboxDir, ensurePlaywrightSharedDir, isImagePath, outboxDir, playwrightSharedDir, resolveOutboxPath } from "../src/outbox.ts";

describe("isImagePath", () => {
  test("recognises Telegram's sendPhoto-eligible extensions, case-insensitively", () => {
    expect(isImagePath("shot.png")).toBe(true);
    expect(isImagePath("shot.PNG")).toBe(true);
    expect(isImagePath("shot.jpg")).toBe(true);
    expect(isImagePath("shot.jpeg")).toBe(true);
    expect(isImagePath("shot.webp")).toBe(true);
  });

  test("falls back to false (document) for anything else", () => {
    expect(isImagePath("shot.bmp")).toBe(false);
    expect(isImagePath("report.pdf")).toBe(false);
    expect(isImagePath("noextension")).toBe(false);
  });
});

describe("outboxDir / ensureOutboxDir", () => {
  test("computes <stateDir>/sessions/<slug>/outbox", () => {
    expect(outboxDir("C:\\state", "my-slug")).toBe(path.join("C:\\state", "sessions", "my-slug", "outbox"));
  });

  test("creates the directory if missing and returns its absolute path", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-outbox-test-"));
    try {
      const dir = ensureOutboxDir(stateDir, "my-slug");
      expect(dir).toBe(outboxDir(stateDir, "my-slug"));
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  test("is idempotent - a second call on an existing directory doesn't throw", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-outbox-test-"));
    try {
      ensureOutboxDir(stateDir, "my-slug");
      expect(() => ensureOutboxDir(stateDir, "my-slug")).not.toThrow();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("resolveOutboxPath", () => {
  test("accepts a file directly inside the session's own outbox", () => {
    const stateDir = "C:\\state";
    const requested = path.join(outboxDir(stateDir, "my-slug"), "shot.png");
    expect(resolveOutboxPath(stateDir, "my-slug", requested)).toBe(path.resolve(requested));
  });

  test("accepts a nested subdirectory inside the outbox", () => {
    const stateDir = "C:\\state";
    const requested = path.join(outboxDir(stateDir, "my-slug"), "nested", "shot.png");
    expect(resolveOutboxPath(stateDir, "my-slug", requested)).toBe(path.resolve(requested));
  });

  test("rejects a path escaping the outbox via ../ traversal", () => {
    const stateDir = "C:\\state";
    const requested = path.join(outboxDir(stateDir, "my-slug"), "..", "..", "etc", "passwd");
    expect(resolveOutboxPath(stateDir, "my-slug", requested)).toBeNull();
  });

  test("rejects a completely unrelated absolute path", () => {
    expect(resolveOutboxPath("C:\\state", "my-slug", "C:\\Users\\operator\\.ssh\\id_rsa")).toBeNull();
  });

  test("rejects another session's outbox - one slug can't read another's files", () => {
    const stateDir = "C:\\state";
    const requested = path.join(outboxDir(stateDir, "other-slug"), "shot.png");
    expect(resolveOutboxPath(stateDir, "my-slug", requested)).toBeNull();
  });

  // §5.8: a file sitting in playwrightSharedDir must never itself resolve as inside any
  // session's outbox - Claude has to move it there explicitly first (channel-server's own
  // instructions text), or send_file silently rejects it exactly like any other outside path.
  test("rejects a path inside the shared Playwright directory - it is not any session's outbox", () => {
    const stateDir = "C:\\state";
    const requested = path.join(playwrightSharedDir(stateDir), "page-12345.png");
    expect(resolveOutboxPath(stateDir, "my-slug", requested)).toBeNull();
  });

  // The slug is as untrusted as the path: `pipe-server.ts` takes it from the `send_file` message
  // itself and nothing binds a pipe connection to one slug, so a traversal *in the slug* built a
  // different session's outbox directory and then passed containment against it. The
  // "rejects another session's outbox" case above only ever covered a well-formed slug.
  test("rejects a slug that isn't a single safe path segment", () => {
    const stateDir = "C:\\state";
    const victim = path.join(outboxDir(stateDir, "victim"), "shot.png");

    expect(resolveOutboxPath(stateDir, "mine/../victim", victim)).toBeNull();
    expect(resolveOutboxPath(stateDir, "mine\\..\\victim", victim)).toBeNull();
    expect(resolveOutboxPath(stateDir, "..", "C:\\state\\sessions\\x")).toBeNull();
    expect(resolveOutboxPath(stateDir, "", victim)).toBeNull();
    // `slug.ts` only ever produces lowercase-alphanumeric-and-dash, so nothing legitimate is lost.
    expect(resolveOutboxPath(stateDir, "My-Slug", path.join(outboxDir(stateDir, "My-Slug"), "a.png"))).toBeNull();
  });

  test("a real slug still resolves normally", () => {
    const stateDir = "C:\\state";
    const requested = path.join(outboxDir(stateDir, "fix-the-login-bug"), "shot.png");
    expect(resolveOutboxPath(stateDir, "fix-the-login-bug", requested)).toBe(path.resolve(requested));
  });

  // Windows compares paths case-insensitively, and Claude writes a lowercase drive letter routinely -
  // a plain `startsWith` on the resolved strings rejected a perfectly legitimate file, and every
  // `send_file` rejection is log-only, so the operator just saw nothing arrive.
  test.skipIf(process.platform !== "win32")("accepts an outbox path differing only in case", () => {
    const stateDir = "C:\\state";
    const requested = path.join(outboxDir(stateDir, "my-slug"), "shot.png").replace("C:\\", "c:\\").toUpperCase();
    expect(resolveOutboxPath(stateDir, "my-slug", requested)).not.toBeNull();
  });
});

describe("playwrightSharedDir / ensurePlaywrightSharedDir", () => {
  test("computes <stateDir>/playwright-shared, independent of any session slug", () => {
    expect(playwrightSharedDir("C:\\state")).toBe(path.join("C:\\state", "playwright-shared"));
  });

  test("creates the directory if missing and returns its absolute path", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-outbox-test-"));
    try {
      const dir = ensurePlaywrightSharedDir(stateDir);
      expect(dir).toBe(playwrightSharedDir(stateDir));
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  test("is the same directory regardless of which session asks for it", () => {
    const stateDir = "C:\\state";
    expect(playwrightSharedDir(stateDir)).toBe(playwrightSharedDir(stateDir));
  });
});
