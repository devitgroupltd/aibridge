import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalizeWindowsPath, ensureMcpJsonRegistration, ensureTrustDialogAccepted } from "../src/claude-config.ts";

describe("canonicalizeWindowsPath", () => {
  test("uppercases the drive letter and normalises slashes", () => {
    expect(canonicalizeWindowsPath("C:\\data\\worktrees\\test-session")).toBe(
      "C:/data/worktrees/test-session",
    );
    expect(canonicalizeWindowsPath("c:/data/worktrees/test-session")).toBe(
      "C:/data/worktrees/test-session",
    );
  });

  // §2.4's documented hazard: both casings must collapse to the same key.
  test("the observed duplicate-key example collapses to one form", () => {
    expect(canonicalizeWindowsPath("C:/data/projects/seowrite")).toBe(
      canonicalizeWindowsPath("c:/data/projects/seowrite"),
    );
  });
});

describe("ensureTrustDialogAccepted", () => {
  let dir: string;
  let claudeJsonPath: string;

  function seed(doc: unknown) {
    writeFileSync(claudeJsonPath, JSON.stringify(doc, null, 2));
  }

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates the projects entry when none exists, preserving unrelated top-level keys", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-claude-json-"));
    claudeJsonPath = path.join(dir, ".claude.json");
    seed({ numStartups: 2, tipsHistory: { foo: 1 } });

    const result = ensureTrustDialogAccepted(claudeJsonPath, "c:/data/worktrees/test-session");
    expect(result.changed).toBe(true);

    const doc = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    expect(doc.numStartups).toBe(2);
    expect(doc.tipsHistory).toEqual({ foo: 1 });
    expect(doc.projects["c:/data/worktrees/test-session"]).toMatchObject({
      hasTrustDialogAccepted: true,
    });
  });

  test("preserves unrelated fields on an existing project entry (mcpServers, allowedTools)", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-claude-json-"));
    claudeJsonPath = path.join(dir, ".claude.json");
    seed({
      projects: {
        "c:/data/worktrees/test-session": {
          allowedTools: ["Bash"],
          mcpServers: { playwright: { command: "npx", args: ["playwright-mcp"] } },
          hasTrustDialogAccepted: false,
        },
      },
    });

    ensureTrustDialogAccepted(claudeJsonPath, "c:/data/worktrees/test-session");

    const doc = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    const project = doc.projects["c:/data/worktrees/test-session"];
    expect(project.allowedTools).toEqual(["Bash"]);
    expect(project.mcpServers.playwright).toEqual({ command: "npx", args: ["playwright-mcp"] });
    expect(project.hasTrustDialogAccepted).toBe(true);
  });

  test("is idempotent: a second call with identical inputs is a no-op", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-claude-json-"));
    claudeJsonPath = path.join(dir, ".claude.json");
    seed({ projects: {} });

    const first = ensureTrustDialogAccepted(claudeJsonPath, "c:/data/worktrees/test-session");
    expect(first.changed).toBe(true);
    const afterFirstWrite = readFileSync(claudeJsonPath, "utf8");

    const second = ensureTrustDialogAccepted(claudeJsonPath, "c:/data/worktrees/test-session");
    expect(second.changed).toBe(false);
    expect(readFileSync(claudeJsonPath, "utf8")).toBe(afterFirstWrite);
  });

  test("takes exactly one backup copy across repeated calls", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-claude-json-"));
    claudeJsonPath = path.join(dir, ".claude.json");
    seed({ projects: {} });
    const backupPath = `${claudeJsonPath}.aibridge-backup`;

    expect(existsSync(backupPath)).toBe(false);
    ensureTrustDialogAccepted(claudeJsonPath, "c:/data/worktrees/test-session");
    expect(existsSync(backupPath)).toBe(true);
    const backupAfterFirst = readFileSync(backupPath, "utf8");

    // A second, different registration must not overwrite the original pre-aibridge backup.
    ensureTrustDialogAccepted(claudeJsonPath, "c:/data/worktrees/other-session");
    expect(readFileSync(backupPath, "utf8")).toBe(backupAfterFirst);
  });
});

// §10.1.2: --dangerously-load-development-channels resolves server:aibridge against the
// worktree's own .mcp.json, not ~/.claude.json's per-project registration - confirmed live.
describe("ensureMcpJsonRegistration", () => {
  let dir: string;

  const serverEntry = { command: "bun.exe", args: ["run", "channel-server.ts"] };

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates .mcp.json when none exists", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-mcp-json-"));

    const result = ensureMcpJsonRegistration(dir, serverEntry);
    expect(result.changed).toBe(true);

    const doc = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    expect(doc.mcpServers.aibridge).toEqual(serverEntry);
  });

  test("preserves other servers already declared in .mcp.json", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-mcp-json-"));
    writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["playwright-mcp"] } } }, null, 2),
    );

    ensureMcpJsonRegistration(dir, serverEntry);

    const doc = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    expect(doc.mcpServers.playwright).toEqual({ command: "npx", args: ["playwright-mcp"] });
    expect(doc.mcpServers.aibridge).toEqual(serverEntry);
  });

  test("is idempotent: a second call with identical inputs is a no-op", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "aibridge-mcp-json-"));

    const first = ensureMcpJsonRegistration(dir, serverEntry);
    expect(first.changed).toBe(true);
    const afterFirstWrite = readFileSync(path.join(dir, ".mcp.json"), "utf8");

    const second = ensureMcpJsonRegistration(dir, serverEntry);
    expect(second.changed).toBe(false);
    expect(readFileSync(path.join(dir, ".mcp.json"), "utf8")).toBe(afterFirstWrite);
  });
});
