import { containsSensitivePath } from "./compound-permission.ts";
import type { PermissionSettings } from "./settings.ts";
import { containsUnsafeSubshellOrBackground } from "./shell-metacharacters.ts";

/**
 * §6.6: never generalise a command containing a shell metacharacter, since the "first two tokens"
 * heuristic below would otherwise scope a rule to only the first of several chained commands
 * while silently allow-listing whatever runs after the `|`/`;`/a background `&`/`$(`/backtick.
 * Pipe, semicolon, and `&&` are always unsafe to generalise past (checked directly below, since
 * unlike compound-permission.ts this module never splits on them - it only ever wants "is there a
 * chain at all"); `$(`/backtick/a genuine background `&` are shared with compound-permission.ts's
 * own metacharacter check so a fix to one (e.g. excluding `2>&1`-style fd-duplication from "bare
 * `&`") can't silently fail to apply to the other - that exact drift shipped live 2026-08-10 before
 * this was shared.
 */
function containsUngeneralisableMetacharacter(command: string): boolean {
  return command.includes("|") || command.includes(";") || command.includes("&&") || containsUnsafeSubshellOrBackground(command);
}

/**
 * A permission message's `input_preview` is normally `{"command": "..."}` JSON, but this is the
 * one boundary where that's an assumption rather than a guarantee (a hook/channel-server version
 * mismatch, say) - shared by every caller that needs the real Bash command string rather than
 * the raw preview field, so there's exactly one place that decides how to fail: returns `null`
 * for anything that isn't valid JSON with a string `command` field, never throws.
 */
export function extractBashCommand(inputPreview: string): string | null {
  try {
    const parsed = JSON.parse(inputPreview) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : null;
  } catch {
    return null;
  }
}

/**
 * §6.6's "Always allow" rule derivation: non-`Bash` tools generalise to the bare tool name;
 * `Bash` generalises to its first two tokens plus `*` (`git commit *`, `npm run *`) and no
 * further. Returns `null` (fall back to allow-once) for a metacharacter command or an empty one -
 * this function must never return a rule that generalises to a bare `Bash(*)`.
 */
export function deriveAlwaysRule(toolName: string, inputPreview: string): string | null {
  if (toolName !== "Bash") {
    return toolName;
  }

  // Unlike compound-permission.ts's caller, this one has no "safe to skip" fallback - an
  // unparsed input_preview here still needs *some* command string to run the metacharacter/token
  // check against, so it falls back to the raw preview itself rather than giving up outright.
  const command = extractBashCommand(inputPreview) ?? inputPreview;

  if (containsUngeneralisableMetacharacter(command)) {
    return null;
  }

  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  const prefix = tokens.slice(0, 2).join(" ");
  return `Bash(${prefix} *)`;
}

/**
 * §9 scenario 10: an `Always` tap can never add a rule a `deny` or `ask` entry already covers -
 * deny wins by precedence anyway, but an ask rule silently accumulating an allow twin would be a
 * confusing no-op the operator never asked for.
 */
export function ruleAlreadyCovered(rule: string, settings: PermissionSettings): boolean {
  return (
    settings.permissions.deny.includes(rule) ||
    settings.permissions.ask.includes(rule) ||
    settings.permissions.allow.includes(rule)
  );
}

/** True when any rule in `rules` targets `toolName` at all - bare (`Write`) or scoped
 * (`Write(...)`). Not "does this rule match this call": the caller uses it to *refuse* to decide,
 * so it deliberately over-matches. */
function rulesMentionTool(rules: readonly string[], toolName: string): boolean {
  return rules.some((rule) => rule === toolName || rule.startsWith(`${toolName}(`));
}

/**
 * `codebase-hardening-plan.md` P0-7: the non-`Bash` counterpart to
 * `compound-permission.ts`'s `isCompoundCommandFullyAllowed`, and the exact mirror of
 * `deriveAlwaysRule` above - what that function *writes* for a non-Bash tool (the bare tool name),
 * this function *recognises*.
 *
 * It exists because measuring §12 Phase 2's open question live (2026-08-12) showed the running
 * Claude Code process does not act on a rule appended to its `--settings` file mid-conversation: the
 * next matching call escalates anyway. `Bash` never looked broken only because the compound path
 * above re-reads that file per request and short-circuits it; every other tool had nothing in front
 * of it, so an `♾️ Always` tap on a `Write` promised a session-wide grant and then raised a fresh
 * card on the very next `Write`.
 *
 * **Why this is deliberately conservative, and what it therefore does not fix.** It refuses unless
 * the tool is allow-listed *and* no `deny`/`ask` entry mentions that tool in any form. So an
 * `♾️ Always` on `Edit` still re-prompts, because the generated baseline carries `Edit(.env)`,
 * `Edit(.env.*)` and `Edit(~/**)`. Honouring those correctly would mean deciding whether *this
 * call's* path matches a scoped glob - i.e. reimplementing Claude Code's own path-glob semantics
 * (`~` expansion, `**`, Windows case-insensitivity and separator quirks) - and a subtle mistake
 * there silently auto-approves a read of the very secrets those deny rules exist to protect. That
 * trade is not worth taking for a prompt: refusing leaves `Edit`/`Read` exactly as they behave
 * today, while `Write`, `NotebookEdit`, `WebFetch`, MCP tools and everything else with no scoped
 * entry get the grant the operator was already told they had.
 *
 * `containsSensitivePath` is applied to the raw input preview as well - the same belt-and-braces
 * guard the Bash path uses, and the reason a `Write` to `~/.ssh/config` is refused even though
 * nothing in `deny` mentions `Write`.
 */
export function isCoveredByBareToolRule(toolName: string, inputPreview: string, settings: PermissionSettings): boolean {
  // Bash has its own, richer path (`isCompoundCommandFullyAllowed`), which understands command
  // decomposition; a bare `Bash` allow rule is not something `deriveAlwaysRule` can even produce.
  if (toolName === "Bash") return false;
  if (toolName.length === 0) return false;
  if (!settings.permissions.allow.includes(toolName)) return false;
  if (rulesMentionTool(settings.permissions.deny, toolName)) return false;
  if (rulesMentionTool(settings.permissions.ask, toolName)) return false;
  return !containsSensitivePath(inputPreview);
}
