import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../src/session-launcher.ts";

describe("stripAnsi", () => {
  test("collapses CSI-coloured words back into contiguous plain text", () => {
    // A trimmed real capture (2026-08-03) of the dev-channels dialog banner - "development" and
    // "channels" render as two separate colour spans, which is exactly what broke a plain
    // substring match against the raw PTY stream before this existed.
    const raw =
      "\x1b[1m\x1b[38;2;255;107;128mWARNING:\x1b[m \x1b[1m\x1b[38;2;255;107;128mLoading\x1b[m \x1b[1m\x1b[38;2;255;107;128mdevelopment\x1b[m \x1b[1m\x1b[38;2;255;107;128mchannels\x1b[m\x1b[K\n" +
      "\x1b[3m\x1b[38;2;153;153;153mEnter\x1b[23m\x1b[m \x1b[3m\x1b[38;2;153;153;153mto\x1b[23m\x1b[m \x1b[3m\x1b[38;2;153;153;153mconfirm\x1b[23m\x1b[m";
    const plain = stripAnsi(raw);
    expect(plain).toContain("development channels");
    expect(plain).toContain("Enter to confirm");
  });

  test("passes plain text through untouched", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  test("strips an OSC window-title sequence", () => {
    expect(stripAnsi("\x1b]0;claude\x07hello")).toBe("hello");
  });

  test("collapses the 'New MCP server found' consent dialog's own banner", () => {
    // Captured live 2026-08-04: a genuinely fresh worktree shows this dialog before the
    // dev-channels one, which the auto-confirm logic must recognise separately from it.
    const raw =
      "\r\n  New MCP server found in this project: aibridge\r\n\r\n  ❱ 1. Use this MCP server\r\n    2. Use this and all future MCP servers in this project\r\n\r\n  Enter to confirm · Esc to cancel";
    const plain = stripAnsi(raw);
    expect(plain).toContain("New MCP server found in this project");
    expect(plain).toContain("Enter to confirm");
  });
});
