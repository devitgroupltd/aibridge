import type { PermissionSettings } from "./settings.ts";

/**
 * §6.6: never generalise a command containing a shell metacharacter, since the "first two tokens"
 * heuristic below would otherwise scope a rule to only the first of several chained commands
 * while silently allow-listing whatever runs after the `|`/`;`/`&`/`$(`/backtick.
 */
const METACHARACTERS = ["|", ";", "&", "$(", "`"];

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

  let command: string;
  try {
    const parsed = JSON.parse(inputPreview) as { command?: unknown };
    command = typeof parsed.command === "string" ? parsed.command : inputPreview;
  } catch {
    command = inputPreview;
  }

  if (METACHARACTERS.some((ch) => command.includes(ch))) {
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
