import { describe, expect, test } from "bun:test";
import type * as pty from "node-pty";
import { stripAnsi, waitForStartupPrompt } from "../src/session-launcher.ts";

/** A minimal stand-in for `pty.IPty` - `waitForStartupPrompt` only ever calls `.onData`. */
class FakePty {
  private handler: ((data: string) => void) | undefined;
  onData(fn: (data: string) => void): { dispose: () => void } {
    this.handler = fn;
    return { dispose: () => {} };
  }
  emit(data: string): void {
    this.handler?.(data);
  }
}

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

describe("waitForStartupPrompt", () => {
  test("resolves resumeFailed: false once the settle markers appear", async () => {
    const fake = new FakePty();
    const result = waitForStartupPrompt(fake as unknown as pty.IPty, () => {});
    fake.emit("some banner\r\n  ⏸ manual mode on · ? for shortcuts · ← for agents◐ medium · /effort  ");
    expect(await result).toEqual({ resumeFailed: false });
  });

  // The live 2026-08-07 regression: `claude --resume <id>` failing doesn't exit the process or throw
  // - it prints this line and falls through to a fresh conversation - so `resumeSession` had no way
  // to tell "resumed" from "silently gave up and started over" without this check.
  test("resolves resumeFailed: true when a resume was requested and Claude reports no matching conversation", async () => {
    const fake = new FakePty();
    const result = waitForStartupPrompt(fake as unknown as pty.IPty, () => {}, "4885934b-a516-49b3-8c38-306373f27ba0");
    fake.emit("No conversation found with session ID: 4885934b-a516-49b3-8c38-306373f27ba0\r\n");
    expect(await result).toEqual({ resumeFailed: true });
  });

  test("the same failure text is ignored when no resume was requested - a fresh /new session's prompt could plausibly echo similar wording without it meaning anything", async () => {
    const fake = new FakePty();
    const result = waitForStartupPrompt(fake as unknown as pty.IPty, () => {});
    fake.emit("No conversation found with session ID: whatever\r\n");
    fake.emit("  ⏸ manual mode on · ? for shortcuts · ← for agents◐ medium · /effort  ");
    expect(await result).toEqual({ resumeFailed: false });
  });
});
