import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * What aibridge does about a *target repo's own* `.mcp.json`.
 *
 * §2.4 covers aibridge's own MCP server by registering it user-level (`~/.claude.json`) rather than
 * per-worktree, specifically so a "new MCP server found" consent dialog doesn't fire on every `/new`
 * - every worktree is a new project directory to Claude Code. That reasoning only ever covered
 * aibridge's own server. A registered repo that ships its *own* project-scoped `.mcp.json` puts the
 * dialog straight back, in every worktree cut from it, and nothing in aibridge had an answer.
 *
 * Found live 2026-08-16 on the first `/new` against a repo other than aibridge itself. SeoWrite
 * declares eight project-scoped servers, so Claude Code opened its consent dialog and sat there; the
 * startup gates timed out, the operator's first prompt was written into the open modal, and its
 * trailing `\r` selected the highlighted "Use this MCP server". A consent dialog answered by
 * accident, and a prompt that never ran. (`startup-gate-notice.ts` is the other half of that fix -
 * the part that makes such a write loud rather than silent.)
 *
 * **The policy is closed by default.** A repo's servers are rejected unless its `repos.toml` entry
 * opts in with `projectMcp = true`. Registering a repo already means running its code - its own
 * `.claude/` hooks execute unmodified inside every worktree (§9 scenario 13), which is the whole
 * basis of §13 check 5 - so this is not a new trust boundary in kind. It is one in degree: hooks
 * fire per tool call, while MCP servers are long-lived processes that hold credentials and reach the
 * network (SeoWrite's own `⚠ 1 MCP server needs authentication` is exactly that difference showing
 * up). Closed-by-default keeps the widening deliberate and per-project, which is also how §7.5 says
 * every other repo-specific decision is made: by editing that TOML file, not by touching aibridge.
 *
 * **Mechanism, and why this one.** Claude Code's settings schema has three relevant keys -
 * `enableAllProjectMcpServers`, `enabledMcpjsonServers` ("List of approved MCP servers from
 * .mcp.json") and `disabledMcpjsonServers` ("List of rejected MCP servers from .mcp.json"). A
 * rejected server is never started and never prompts. Names are matched exactly, not by glob
 * (the client's own matcher special-cases only a `plugin:` prefix), so the list has to be built from
 * the repo's actual `.mcp.json` rather than a wildcard.
 *
 * Verified against the pinned client (2.1.233) on 2026-08-16, on a scratch directory holding a copy
 * of SeoWrite's `.mcp.json`, with the folder pre-trusted so nothing else could block:
 *   - no policy: the real TUI opens "8 new MCP servers found in this project".
 *   - the same names in `disabledMcpjsonServers`, passed through the `--settings` file aibridge
 *     already writes per session: no dialog, straight to the prompt.
 * The `--settings` half matters on its own. `claude mcp list` proved the key works from a project's
 * `.claude/settings.local.json`, but that is a write into the target repo's worktree, which aibridge
 * does not do; the generated per-session file is aibridge's own, outside the repo entirely.
 */

/** The two settings keys this module ever emits - a subset of Claude Code's settings schema, merged
 * into the generated per-session `--settings` file. Both absent means "say nothing", which is the
 * right answer for a repo with no `.mcp.json` at all. */
export interface ProjectMcpPolicy {
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
}

/**
 * The server names a repo's own `.mcp.json` declares, in file order.
 *
 * Every failure returns `[]` rather than throwing: no `.mcp.json` is the common case (aibridge's own
 * repo has none), and a malformed one is the target repo's problem, not a reason to refuse to launch
 * a session against it. `[]` also happens to be the safe answer - `buildProjectMcpPolicy` then emits
 * nothing, and Claude Code's own dialog remains the backstop.
 */
export function readProjectMcpServerNames(repoPath: string, log?: (level: "WARN", message: string) => void): string[] {
  let contents: string;
  try {
    contents = readFileSync(path.join(repoPath, ".mcp.json"), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(contents) as { mcpServers?: Record<string, unknown> };
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object") return [];
    return Object.keys(servers);
  } catch (err) {
    log?.("WARN", `could not parse ${path.join(repoPath, ".mcp.json")} - leaving its MCP servers to Claude Code's own consent dialog: ${(err as Error).message}`);
    return [];
  }
}

/**
 * `allow` is the repo's `projectMcp` opt-in. Note that the allowed form lists the names explicitly
 * rather than setting `enableAllProjectMcpServers` - so what is approved is what the repo declared
 * at launch time, and a server added to `.mcp.json` later still raises a dialog on the next `/new`
 * rather than being approved retroactively by a decision nobody made about it.
 */
export function buildProjectMcpPolicy(names: readonly string[], allow: boolean): ProjectMcpPolicy {
  if (names.length === 0) return {};
  return allow ? { enabledMcpjsonServers: [...names] } : { disabledMcpjsonServers: [...names] };
}
