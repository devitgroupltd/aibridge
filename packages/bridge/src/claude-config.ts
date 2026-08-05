import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * §2.4 correction: `~/.claude.json` has no top-level `mcpServers` - registration is nested at
 * `projects["<canonical-path>"].mcpServers`, alongside `hasTrustDialogAccepted` at the same
 * level. "Register user-level, not in a worktree's `.mcp.json`" means the Bridge writes this
 * per-worktree entry into `~/.claude.json` itself, silently, before spawning (§9 scenario 28's
 * ordering assertion) - it is not a one-time global registration.
 *
 * The file also holds a lot of the operator's own unrelated daily-use state (tips history,
 * cached feature flags, other projects), so a write here must touch only the one project entry
 * this session needs and leave everything else byte-for-byte equivalent in structure.
 */

/**
 * Uppercase the drive letter and use forward slashes - the one consistent form this project
 * writes and reads, since `~/.claude.json` has been observed to hold both
 * `c:/data/projects/seowrite` and `C:/data/projects/seowrite` as distinct keys (§2.4's documented
 * hazard, confirmed live on this machine). Uppercase (not lowercase) was confirmed as Claude
 * Code's own convention empirically during Stage 7's manual verification: it wrote its own
 * `"C:/data/projects/aibridge"` project entry with an uppercase drive letter for a cwd it
 * navigated itself, and a lowercase-keyed registration was silently invisible to it (§9 scenario
 * 28 depends on this matching exactly, or the channel server never gets spawned at all).
 */
export function canonicalizeWindowsPath(p: string): string {
  const forwardSlashes = p.replace(/\\/g, "/");
  return forwardSlashes.replace(/^([A-Za-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`);
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ProjectEntry {
  mcpServers?: Record<string, McpServerEntry>;
  hasTrustDialogAccepted?: boolean;
  [key: string]: unknown;
}

interface ClaudeJsonDoc {
  projects?: Record<string, ProjectEntry>;
  [key: string]: unknown;
}

export interface EnsureRegistrationResult {
  changed: boolean;
}

/**
 * Ensures `projects[canonicalWorktreePath].hasTrustDialogAccepted` is true, writing the file only
 * if it isn't already (idempotent). Takes a one-time backup copy before the first write ever made
 * to this path.
 *
 * §10.1.2 correction (2026-08-03): this used to also write `mcpServers.aibridge` here, on the
 * theory that "register user-level, not in a worktree's `.mcp.json`" (§2.4) applied to the channel
 * server too. Confirmed live it does not:
 * `--dangerously-load-development-channels server:aibridge` resolves its argument against the
 * worktree's own `.mcp.json`, never against this file's per-project `mcpServers`, so a channel
 * registered only here produces Claude Code's "no MCP server configured with that name" warning
 * and the server is never spawned at all. See `ensureMcpJsonRegistration` below for where the
 * channel entry actually has to live.
 */
/**
 * §5.8: registers the official Microsoft Playwright MCP server (`@playwright/mcp`) at
 * `projects[canonicalWorktreePath].mcpServers.playwright` - an *ordinary* MCP tool, not the
 * `aibridge` channel, so (per the correction above) it genuinely does work registered here rather
 * than needing the worktree's own `.mcp.json`: confirmed by this project's own prior observation
 * that SeoWrite's `playwright`/`chrome-devtools` entries in `~/.claude.json` work with no
 * `.mcp.json` at all. `--output-dir` is pointed at this session's own outbox so a screenshot
 * Claude takes lands exactly where `send_file` is allowed to read from, with no extra "move it
 * into the outbox" step. Idempotent like `ensureTrustDialogAccepted` - only writes if the entry
 * would actually change.
 */
export function ensurePlaywrightRegistration(
  claudeJsonPath: string,
  canonicalWorktreePath: string,
  outboxDir: string,
): EnsureRegistrationResult {
  const doc = JSON.parse(readFileSync(claudeJsonPath, "utf8")) as ClaudeJsonDoc;
  doc.projects ??= {};
  const existing = doc.projects[canonicalWorktreePath];

  const serverEntry: McpServerEntry = {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--output-dir", outboxDir],
  };

  if (JSON.stringify(existing?.mcpServers?.playwright) === JSON.stringify(serverEntry)) {
    return { changed: false };
  }

  doc.projects[canonicalWorktreePath] = {
    ...existing,
    mcpServers: { ...existing?.mcpServers, playwright: serverEntry },
  };

  writeFileSync(claudeJsonPath, JSON.stringify(doc, null, 2));
  return { changed: true };
}

export function ensureTrustDialogAccepted(
  claudeJsonPath: string,
  canonicalWorktreePath: string,
): EnsureRegistrationResult {
  const doc = JSON.parse(readFileSync(claudeJsonPath, "utf8")) as ClaudeJsonDoc;
  doc.projects ??= {};
  const existing = doc.projects[canonicalWorktreePath];

  if (existing?.hasTrustDialogAccepted === true) {
    return { changed: false };
  }

  const backupPath = `${claudeJsonPath}.aibridge-backup`;
  if (!existsSync(backupPath)) {
    copyFileSync(claudeJsonPath, backupPath);
  }

  doc.projects[canonicalWorktreePath] = {
    ...existing,
    hasTrustDialogAccepted: true,
  };

  writeFileSync(claudeJsonPath, JSON.stringify(doc, null, 2));
  return { changed: true };
}

interface McpJsonDoc {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/**
 * Ensures `<worktreePath>/.mcp.json` declares the `aibridge` server matching `serverEntry`,
 * writing the file only if something needs to change (idempotent). This is what
 * `--dangerously-load-development-channels server:aibridge` actually resolves against (see the
 * correction above) - it also means the "New MCP server found in this project" consent dialog
 * fires on every `/new`, which §2.4's original design specifically tried to avoid and could not,
 * for this specific feature.
 */
export function ensureMcpJsonRegistration(worktreePath: string, serverEntry: McpServerEntry): EnsureRegistrationResult {
  const mcpJsonPath = `${worktreePath}/.mcp.json`;
  const doc: McpJsonDoc = existsSync(mcpJsonPath) ? (JSON.parse(readFileSync(mcpJsonPath, "utf8")) as McpJsonDoc) : {};

  const alreadyRegistered = JSON.stringify(doc.mcpServers?.aibridge) === JSON.stringify(serverEntry);
  if (alreadyRegistered) {
    return { changed: false };
  }

  doc.mcpServers = { ...doc.mcpServers, aibridge: serverEntry };
  writeFileSync(mcpJsonPath, JSON.stringify(doc, null, 2));
  return { changed: true };
}
