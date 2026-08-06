import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSecretShaped,
  listDirectory,
  looksBinary,
  prepareFileForSend,
  readForPreview,
  resolveGithubLink,
  resolveWorktreeRelPath,
  searchWorktree,
  shouldSkip,
} from "../src/worktree-fs.ts";

// Windows only allows unprivileged symlink creation with Developer Mode / SeCreateSymbolicLinkPrivilege
// enabled - probe once so the escape test degrades to skipped rather than failing the whole suite on a
// host where it can't run, same "don't assume the environment" caution as monotonic-clock.ts's own note.
function probeSymlinkSupport(root: string): boolean {
  try {
    const target = path.join(root, "probe-target");
    mkdirSync(target);
    symlinkSync(target, path.join(root, "probe-link"), "junction");
    return true;
  } catch {
    return false;
  }
}

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aibridge-worktree-fs-"));
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "src", "nested"));
  mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, "README.md"), "hello world\n");
  writeFileSync(path.join(root, "src", "index.ts"), "export const needle = 1;\nconsole.log('nothing here');\n");
  writeFileSync(path.join(root, "src", "nested", "deep.ts"), "// line1\n// line2\nconst secretLookingButNot = 'needle';\n");
  writeFileSync(path.join(root, ".env"), "SECRET=nope\n");
  writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  writeFileSync(path.join(root, "binary.dat"), Buffer.from([0, 1, 2, 3, 0, 5]));
  return root;
}

describe("resolveWorktreeRelPath", () => {
  test("resolves the root itself", () => {
    const root = makeFixture();
    try {
      const resolved = resolveWorktreeRelPath(root, "");
      expect(resolved?.rel).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves a normal nested path", () => {
    const root = makeFixture();
    try {
      const resolved = resolveWorktreeRelPath(root, "src/index.ts");
      expect(resolved?.rel).toBe("src/index.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a ../ traversal outright, not clamped to the root", () => {
    const root = makeFixture();
    try {
      expect(resolveWorktreeRelPath(root, "../../etc/passwd")).toBeNull();
      expect(resolveWorktreeRelPath(root, "src/../../outside")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an absolute path", () => {
    const root = makeFixture();
    try {
      expect(resolveWorktreeRelPath(root, "C:\\Windows\\System32")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a path that doesn't exist", () => {
    const root = makeFixture();
    try {
      expect(resolveWorktreeRelPath(root, "nope/nothing.ts")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a NUL byte in the requested path", () => {
    const root = makeFixture();
    try {
      expect(resolveWorktreeRelPath(root, "src/index.ts\0.png")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlink inside the worktree that points outside it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aibridge-worktree-fs-symlink-"));
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "aibridge-outside-"));
    try {
      if (!probeSymlinkSupport(mkdtempSync(path.join(os.tmpdir(), "aibridge-symlink-probe-")))) return;
      writeFileSync(path.join(outsideDir, "secret.txt"), "top secret\n");
      symlinkSync(outsideDir, path.join(root, "escape"), "junction");
      expect(resolveWorktreeRelPath(root, "escape/secret.txt")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("isSecretShaped / shouldSkip", () => {
  test("flags .env-shaped and key-shaped filenames", () => {
    expect(isSecretShaped(".env")).toBe(true);
    expect(isSecretShaped(".env.local")).toBe(true);
    expect(isSecretShaped("server.pem")).toBe(true);
    expect(isSecretShaped("private.key")).toBe(true);
    expect(isSecretShaped("id_rsa")).toBe(true);
    expect(isSecretShaped("id_rsa.pub")).toBe(true);
    expect(isSecretShaped("client.pfx")).toBe(true);
  });

  test("leaves ordinary filenames alone", () => {
    expect(isSecretShaped("index.ts")).toBe(false);
    expect(isSecretShaped("README.md")).toBe(false);
    expect(isSecretShaped("monkey.txt")).toBe(false);
  });

  test("skips .git and generated-directory names, and secret-shaped files", () => {
    expect(shouldSkip(".git", true)).toBe(true);
    expect(shouldSkip("node_modules", true)).toBe(true);
    expect(shouldSkip(".env", false)).toBe(true);
    expect(shouldSkip("src", true)).toBe(false);
    expect(shouldSkip("index.ts", false)).toBe(false);
  });
});

describe("listDirectory", () => {
  test("lists the root, folders before files, never .git/node_modules/.env", () => {
    const root = makeFixture();
    try {
      const listing = listDirectory(root, "");
      expect(listing).not.toBeNull();
      const names = listing!.entries.map((e) => e.name);
      expect(names).not.toContain(".git");
      expect(names).not.toContain("node_modules");
      expect(names).not.toContain(".env");
      expect(names).toContain("src");
      expect(names).toContain("README.md");
      // folders sorted before files
      const firstFileIndex = listing!.entries.findIndex((e) => !e.isDir);
      const lastDirIndex = listing!.entries.map((e) => e.isDir).lastIndexOf(true);
      expect(lastDirIndex).toBeLessThan(firstFileIndex === -1 ? Infinity : firstFileIndex);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("paginates when there are more entries than one page", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aibridge-worktree-fs-page-"));
    try {
      for (let i = 0; i < 20; i++) writeFileSync(path.join(root, `file-${String(i).padStart(2, "0")}.txt`), "x");
      const page0 = listDirectory(root, "", 0);
      const page1 = listDirectory(root, "", 1);
      expect(page0!.totalPages).toBe(2);
      expect(page0!.entries.length).toBe(15);
      expect(page1!.entries.length).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null for a path that resolves outside the worktree", () => {
    const root = makeFixture();
    try {
      expect(listDirectory(root, "../")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("searchWorktree", () => {
  test("matches filenames and, when rg is available, file content, and shows why", () => {
    const root = makeFixture();
    try {
      const result = searchWorktree(root, "index");
      expect(result.hits.some((h) => h.relPath === "src/index.ts" && h.reason === "name")).toBe(true);
      expect(result.hits.some((h) => h.relPath.includes("node_modules"))).toBe(false);

      const contentResult = searchWorktree(root, "needle");
      if (!contentResult.contentSearchSkipped) {
        const contentHit = contentResult.hits.find((h) => h.reason === "content");
        expect(contentHit).toBeDefined();
        expect(contentHit?.relPath).toBe("src/index.ts");
        expect(contentHit?.line).toBe(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never surfaces a hit inside a secret-shaped file even if the content matches", () => {
    const root = makeFixture();
    try {
      const result = searchWorktree(root, "SECRET");
      expect(result.hits.some((h) => h.relPath === ".env")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("caps results and reports truncated rather than dropping silently", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aibridge-worktree-fs-search-cap-"));
    try {
      for (let i = 0; i < 30; i++) writeFileSync(path.join(root, `needle-${i}.txt`), "x");
      const result = searchWorktree(root, "needle", 5);
      expect(result.hits.length).toBe(5);
      expect(result.truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("looksBinary", () => {
  test("detects a NUL byte in the sample as binary", () => {
    expect(looksBinary(Buffer.from([1, 2, 0, 3]))).toBe(true);
  });

  test("ordinary text is not binary", () => {
    expect(looksBinary(Buffer.from("hello world", "utf8"))).toBe(false);
  });
});

describe("readForPreview", () => {
  test("reads a small text file whole", () => {
    const root = makeFixture();
    try {
      const preview = readForPreview(root, "README.md");
      expect(preview?.text.trim()).toBe("hello world");
      expect(preview?.truncated).toBe(false);
      expect(preview?.binary).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports binary instead of returning garbage bytes", () => {
    const root = makeFixture();
    try {
      const preview = readForPreview(root, "binary.dat");
      expect(preview?.binary).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("with a focusLine, windows the excerpt around the matched line instead of the top of the file", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aibridge-worktree-fs-focus-"));
    try {
      const lines = Array.from({ length: 200 }, (_, i) => (i === 150 ? "TARGET LINE" : `filler ${i}`));
      writeFileSync(path.join(root, "big.ts"), lines.join("\n"));
      const preview = readForPreview(root, "big.ts", 151); // 1-indexed
      expect(preview?.text).toContain("TARGET LINE");
      expect(preview?.truncated).toBe(true);
      // a naive "truncate from the top" preview would have cut this line out entirely
      expect(preview?.text).not.toContain("filler 0\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("redacts a planted secret before it's ever placed in preview text", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aibridge-worktree-fs-scrub-"));
    try {
      writeFileSync(path.join(root, "config.json"), '{"key": "AKIAABCDEFGHIJKLMNOP"}');
      const preview = readForPreview(root, "config.json");
      expect(preview?.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
      expect(preview?.text).toContain("[redacted:aws-access-key]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null for a file that doesn't exist", () => {
    const root = makeFixture();
    try {
      expect(readForPreview(root, "nope.ts")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prepareFileForSend", () => {
  test("scrubs a planted secret in a plausibly-named text file before it's sent, not just filename-filtered", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aibridge-worktree-fs-send-scrub-"));
    try {
      writeFileSync(path.join(root, "backup.sql"), "INSERT INTO users VALUES ('AKIAABCDEFGHIJKLMNOP');\n");
      const prep = prepareFileForSend(root, "backup.sql");
      const text = new TextDecoder().decode(prep!.bytes);
      expect(text).not.toContain("AKIAABCDEFGHIJKLMNOP");
      expect(text).toContain("[redacted:aws-access-key]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sends binary content as-is - scrubbing doesn't apply to it", () => {
    const root = makeFixture();
    try {
      const original = Buffer.from([0, 1, 2, 3, 0, 5]);
      const prep = prepareFileForSend(root, "binary.dat");
      expect(Buffer.from(prep!.bytes)).toEqual(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a secret-shaped filename outright even by direct path, defense-in-depth on top of listDirectory/searchWorktree already hiding it", () => {
    const root = makeFixture();
    try {
      expect(prepareFileForSend(root, ".env")).toBeNull();
      expect(readForPreview(root, ".env")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null for a file that doesn't exist", () => {
    const root = makeFixture();
    try {
      expect(prepareFileForSend(root, "nope.ts")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveGithubLink", () => {
  test("returns null when there's no git repo at all", () => {
    const root = makeFixture();
    try {
      expect(resolveGithubLink(root, "README.md")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
