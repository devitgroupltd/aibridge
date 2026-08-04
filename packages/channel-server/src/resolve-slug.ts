import path from "node:path";

/**
 * Two ways this process learns its own slug, depending on how it was spawned (§10.1's plugin
 * packaging). When the Bridge registers this server directly in a worktree's `.mcp.json`
 * (session-launcher.ts's current default), it sets `AIBRIDGE_SLUG` explicitly - Claude Code
 * doesn't pass a registered MCP server its parent's env, so there's no other way for it to know.
 * When this same code is spawned instead via the `aibridge-telegram` plugin's static
 * `plugin.json` (shared across every worktree, so it can't hardcode a per-session slug), Claude
 * Code still exports `CLAUDE_PROJECT_DIR` to every MCP subprocess - and every worktree is named
 * exactly `<slug>` (session-launcher.ts's `worktreePath = path.join(worktreesRoot, opts.slug)`),
 * so the basename is the slug. `AIBRIDGE_SLUG` wins when both are present so existing
 * registrations and tests are unaffected.
 */
export function resolveSlug(env: Record<string, string | undefined>): string | undefined {
  if (env.AIBRIDGE_SLUG) return env.AIBRIDGE_SLUG;
  if (env.CLAUDE_PROJECT_DIR) return path.basename(env.CLAUDE_PROJECT_DIR);
  return undefined;
}
