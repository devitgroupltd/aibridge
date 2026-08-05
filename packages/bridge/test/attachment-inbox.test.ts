import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attachmentKindLabel,
  buildAttachmentAnnouncement,
  buildInboxFilename,
  guessAttachmentFilename,
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
  test("lands the file under $STATE/sessions/<slug>/inbox/, creating the directory if missing", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-attach-test-"));
    try {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const fullPath = writeAttachmentToInbox(stateDir, "my-slug", "photo.jpg", bytes);

      expect(fullPath.startsWith(path.join(stateDir, "sessions", "my-slug", "inbox"))).toBe(true);
      const written = await fs.readFile(fullPath);
      expect(new Uint8Array(written)).toEqual(bytes);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  test("a hostile filename never escapes the session's inbox directory", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "aibridge-attach-test-"));
    try {
      const fullPath = writeAttachmentToInbox(stateDir, "my-slug", "../../../etc/passwd", new Uint8Array([9]));
      const inboxDir = path.join(stateDir, "sessions", "my-slug", "inbox");
      expect(path.dirname(fullPath)).toBe(inboxDir);
      expect(path.basename(fullPath)).toContain("passwd");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
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
