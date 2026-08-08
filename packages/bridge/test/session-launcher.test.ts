import { describe, expect, test } from "bun:test";
import type * as pty from "node-pty";
import { buildClaudeSpawnArgs, firstNonEmptyLine, stripAnsi, waitForStartupPrompt } from "../src/session-launcher.ts";

// 0.100.0: the resolveNodeExecutable/resolveBunExecutable/resolveClaudeExecutable trio all parse
// `where.exe`'s output through this exact logic - pulled out and tested on its own, since the exec
// call itself stays untestable I/O but this parsing is pure, decidable, and the one place a wrong
// pick (e.g. a shim ahead of the real binary on PATH) would silently misresolve which binary the
// Bridge respawns itself as.
describe("firstNonEmptyLine (where.exe output parsing)", () => {
  test("a single match, no trailing newline", () => {
    expect(firstNonEmptyLine("C:\\nvm4w\\nodejs\\node.exe")).toBe("C:\\nvm4w\\nodejs\\node.exe");
  });

  test("a single match with where.exe's usual CRLF trailing newline", () => {
    expect(firstNonEmptyLine("C:\\nvm4w\\nodejs\\node.exe\r\n")).toBe("C:\\nvm4w\\nodejs\\node.exe");
  });

  test("multiple matches (a shim earlier on PATH than the real binary) - takes the first, PATH order", () => {
    expect(firstNonEmptyLine("C:\\Users\\me\\shims\\node.exe\r\nC:\\nvm4w\\nodejs\\node.exe\r\n")).toBe("C:\\Users\\me\\shims\\node.exe");
  });

  test("a blank line ahead of a real match is skipped, not treated as the answer", () => {
    expect(firstNonEmptyLine("\r\nC:\\nvm4w\\nodejs\\node.exe\r\n")).toBe("C:\\nvm4w\\nodejs\\node.exe");
  });

  test("whitespace-only output is no match, not a blank-string match", () => {
    expect(firstNonEmptyLine("   \r\n\t\r\n")).toBeUndefined();
  });

  test("empty output is no match", () => {
    expect(firstNonEmptyLine("")).toBeUndefined();
  });

  test("a line is trimmed of its own leading/trailing whitespace", () => {
    expect(firstNonEmptyLine("   C:\\nvm4w\\nodejs\\node.exe   \r\n")).toBe("C:\\nvm4w\\nodejs\\node.exe");
  });
});

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

describe("buildClaudeSpawnArgs", () => {
  test("always includes --model, --settings, and a language-mirroring --append-system-prompt", () => {
    const args = buildClaudeSpawnArgs({ model: "sonnet", settingsPath: "C:\\state\\sessions\\foo\\settings.json" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args).toContain("--settings");
    expect(args[args.indexOf("--settings") + 1]).toBe("C:\\state\\sessions\\foo\\settings.json");
    const systemPromptIdx = args.indexOf("--append-system-prompt");
    expect(systemPromptIdx).toBeGreaterThan(-1);
    expect(args[systemPromptIdx + 1]).toContain("Always reply in the same language as the operator's most recent message");
  });

  test("omits --resume when no resumeSessionId is given", () => {
    const args = buildClaudeSpawnArgs({ model: "sonnet", settingsPath: "settings.json" });
    expect(args).not.toContain("--resume");
  });

  test("appends --resume <id> when resumeSessionId is given", () => {
    const args = buildClaudeSpawnArgs({ model: "opus", settingsPath: "settings.json", resumeSessionId: "abc-123" });
    const resumeIdx = args.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args[resumeIdx + 1]).toBe("abc-123");
  });
});
