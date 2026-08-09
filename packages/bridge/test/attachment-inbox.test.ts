import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attachmentKindLabel,
  buildAttachmentAnnouncement,
  buildInboxFilename,
  forgetInboxGitignoreCache,
  guessAttachmentFilename,
  INBOX_DIR_NAME,
  sanitizeAttachmentFilename,
  writeAttachmentToInbox,
} from "../src/attachment-inbox.ts";

describe("sanitizeAttachmentFilename", () => {
  test("passes through an ordinary filename unchanged", () => {
    expect(sanitizeAttachmentFilename("screenshot.png")).toBe("screenshot.png");
  });

  test("strips a POSIX path-traversal prefix down to the basename - scenario 36", () => {
    expect(sanitizeAttachmentFilename("../../etc/passwd")).toBe("passwd");
  });

  test("strips a Windows path-traversal prefix down to the basename", () => {
    expect(sanitizeAttachmentFilename("..\\..\\Windows\\System32\\evil.dll")).toBe("evil.dll");
  });

  test("collapses exotic/control characters to underscores rather than passing them through", () => {
    expect(sanitizeAttachmentFilename("weird<>:\"|?*name.txt")).toBe("weird_______name.txt");
  });

  test("falls back to a default name for an empty or all-traversal input", () => {
    expect(sanitizeAttachmentFilename("")).toBe("file");
    expect(sanitizeAttachmentFilename("../../..")).toBe("file");
  });

  test("truncates an absurdly long filename rather than writing it verbatim", () => {
    const long = `${"a".repeat(300)}.png`;
    expect(sanitizeAttachmentFilename(long).length).toBeLessThanOrEqual(100);
  });

  test("strips a leading dot run so the result can't become a hidden file", () => {
    expect(sanitizeAttachmentFilename("...hidden")).toBe("hidden");
  });
});

describe("guessAttachmentFilename", () => {
  test("prefers a real filename when Telegram provided one", () => {
    expect(guessAttachmentFilename("document", "report.pdf", "application/pdf")).toBe("report.pdf");
  });

  test("derives an extension from a known mime type when no filename is given", () => {
    expect(guessAttachmentFilename("document", undefined, "application/pdf")).toBe("document.pdf");
    expect(guessAttachmentFilename("video", undefined, "video/mp4")).toBe("video.mp4");
    expect(guessAttachmentFilename("audio", undefined, "audio/mpeg")).toBe("audio.mp3");
  });

  test("falls back to a plain default for an unrecognised or missing mime type", () => {
    expect(guessAttachmentFilename("document", undefined, "application/x-unknown")).toBe("document.bin");
    expect(guessAttachmentFilename("image", undefined, undefined)).toBe("image.jpg");
  });

  test("video notes never carry a filename/mime - always the hyphenated default", () => {
    expect(guessAttachmentFilename("video note", undefined, undefined)).toBe("video-note.mp4");
  });
});

describe("buildInboxFilename", () => {
  test("prefixes a timestamp + short random id ahead of the sanitized name", () => {
    const result = buildInboxFilename("screenshot.png");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9]{6}-screenshot\.png$/);
  });

  test("two calls in the same tick don't collide", () => {
    const a = buildInboxFilename("x.png");
    const b = buildInboxFilename("x.png");
    expect(a).not.toBe(b);
  });
});

describe("writeAttachmentToInbox", () => {
  test("lands the file under <worktree>/.aibridge-inbox/, creating the directory if missing", async () => {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-attach-test-"));
    try {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const fullPath = await writeAttachmentToInbox(worktreePath, "photo.jpg", bytes);

      expect(fullPath.startsWith(path.join(worktreePath, INBOX_DIR_NAME))).toBe(true);
      const written = await fs.readFile(fullPath);
      expect(new Uint8Array(written)).toEqual(bytes);
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  test("a hostile filename never escapes the inbox directory", async () => {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-attach-test-"));
    try {
      const fullPath = await writeAttachmentToInbox(worktreePath, "../../../etc/passwd", new Uint8Array([9]));
      const inboxDir = path.join(worktreePath, INBOX_DIR_NAME);
      expect(path.dirname(fullPath)).toBe(inboxDir);
      expect(path.basename(fullPath)).toContain("passwd");
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  test("not a git repo at all - the write still succeeds (best-effort gitignore, never blocking)", async () => {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-attach-test-"));
    try {
      const fullPath = await writeAttachmentToInbox(worktreePath, "photo.jpg", new Uint8Array([1]));
      expect(new Uint8Array(await fs.readFile(fullPath))).toEqual(new Uint8Array([1]));
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  describe("in a real git repo", () => {
    test("appends .aibridge-inbox/ to the shared info/exclude, never a tracked .gitignore", async () => {
      const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-attach-git-test-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: repoPath });
        await writeAttachmentToInbox(repoPath, "photo.jpg", new Uint8Array([1]));

        const excludePath = path.join(repoPath, ".git", "info", "exclude");
        const excludeContent = await fs.readFile(excludePath, "utf8");
        expect(excludeContent).toContain(`${INBOX_DIR_NAME}/`);
        await expect(fs.access(path.join(repoPath, ".gitignore"))).rejects.toThrow();
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    });

    test("two attachments in the same repo don't duplicate the exclude line", async () => {
      const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-attach-git-test-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: repoPath });
        await writeAttachmentToInbox(repoPath, "a.jpg", new Uint8Array([1]));
        await writeAttachmentToInbox(repoPath, "b.jpg", new Uint8Array([2]));

        const excludeContent = await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8");
        const occurrences = excludeContent.split("\n").filter((line) => line.trim() === `${INBOX_DIR_NAME}/`).length;
        expect(occurrences).toBe(1);
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    });

    // Code-review finding on an earlier version of this cache: it was keyed by the resolved common
    // dir, which `gitCommonDir` has to be *called* to even learn - so it only skipped the
    // info/exclude file I/O, not `gitCommonDir`'s own synchronous git subprocess spawn, meaning a
    // second attachment still shelled out to git every time. Proven here by wiping the exclude file
    // out-of-band between two writes to the same repo: if the second `writeAttachmentToInbox` call
    // actually re-ran the "ensure" logic (whether via a live subprocess or not), it would see the
    // line missing and re-add it - it doesn't, because the per-worktree/per-common-dir caches
    // short-circuit before that logic runs at all on the second call.
    test("a second attachment to the same repo is a true no-op - an externally-cleared exclude file is not re-populated", async () => {
      const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-attach-git-test-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: repoPath });
        await writeAttachmentToInbox(repoPath, "a.jpg", new Uint8Array([1]));

        const excludePath = path.join(repoPath, ".git", "info", "exclude");
        await fs.writeFile(excludePath, ""); // simulate the exclude file having been reset out-of-band

        await writeAttachmentToInbox(repoPath, "b.jpg", new Uint8Array([2]));

        expect(await fs.readFile(excludePath, "utf8")).toBe("");
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    });

    // Code-review finding: worktreePath is always <worktreesRoot>/<slug> (session-launcher.ts), and
    // `/rm` frees a slug's name - and therefore that exact path - for a later /new to hand to a
    // completely different repo. Without invalidating the cache, the new repo's own info/exclude
    // would never get the line at all, since the stale cache would report "already gitignored" for
    // what is now a different repo's common dir.
    test("forgetInboxGitignoreCache lets a reused worktreePath re-resolve for a different repo after /rm frees it", async () => {
      const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-attach-reuse-test-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: worktreePath });
        await writeAttachmentToInbox(worktreePath, "a.jpg", new Uint8Array([1]));
        const firstExclude = await fs.readFile(path.join(worktreePath, ".git", "info", "exclude"), "utf8");
        expect(firstExclude).toContain(`${INBOX_DIR_NAME}/`);

        // Simulate /rm: the worktree (and its .git) is torn down, the slug/path freed for reuse.
        await fs.rm(path.join(worktreePath, ".git"), { recursive: true, force: true });
        forgetInboxGitignoreCache(worktreePath);

        // A later /new hands the identical path to an unrelated repo.
        execFileSync("git", ["init", "-q"], { cwd: worktreePath });
        await writeAttachmentToInbox(worktreePath, "b.jpg", new Uint8Array([2]));

        const secondExclude = await fs.readFile(path.join(worktreePath, ".git", "info", "exclude"), "utf8");
        expect(secondExclude).toContain(`${INBOX_DIR_NAME}/`);
      } finally {
        await fs.rm(worktreePath, { recursive: true, force: true });
      }
    });
  });
});

describe("buildAttachmentAnnouncement", () => {
  test("names the path with no caption", () => {
    expect(buildAttachmentAnnouncement("image", "C:\\state\\sessions\\x\\inbox\\a.png")).toBe(
      "operator sent an image: C:\\state\\sessions\\x\\inbox\\a.png",
    );
  });

  test("appends a trimmed caption on its own line when present", () => {
    expect(buildAttachmentAnnouncement("document", "/inbox/report.pdf", "  this is the Q3 report  ")).toBe(
      "operator sent a document: /inbox/report.pdf\nthis is the Q3 report",
    );
  });

  test("an all-whitespace caption is treated as absent", () => {
    expect(buildAttachmentAnnouncement("video", "/inbox/clip.mp4", "   ")).toBe("operator sent a video: /inbox/clip.mp4");
  });

  test("covers every attachment kind's label", () => {
    expect(attachmentKindLabel("image")).toBe("an image");
    expect(attachmentKindLabel("document")).toBe("a document");
    expect(attachmentKindLabel("video")).toBe("a video");
    expect(attachmentKindLabel("audio")).toBe("an audio file");
    expect(attachmentKindLabel("video note")).toBe("a video note");
  });
});
