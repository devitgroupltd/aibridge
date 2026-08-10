import type { PermissionSettings } from "./settings.ts";

/**
 * 2026-08-10 follow-up to the "too many Bash prompts" investigation (see CLAUDE.md's permission
 * section and rule-derivation.ts's own doc comment): Claude Code's own permission engine matches a
 * Bash tool call's *entire* raw command string against each glob rule - it never decomposes a
 * `&&`/`;`/`|` chain into sub-commands and checks each independently (that's exactly why
 * `deriveAlwaysRule` below refuses to generalise a metacharacter command). The practical effect is
 * that a command built entirely out of pieces the generated settings.json already trusts
 * individually - e.g. `cd <worktree> && sed -i 's#a#b#g' file && grep -c a file; grep -c b file` -
 * still raises a Telegram prompt for every single invocation, because the whole string never
 * matches any one static glob.
 *
 * This module lets the Bridge pre-approve exactly that case, before ever rendering the permission
 * card - it never changes what Claude Code's own settings evaluation does, it only short-circuits
 * the Telegram round-trip for a compound command whose every piece was already going to be
 * silently allowed on its own.
 *
 * Deliberately conservative, same spirit as `rule-derivation.ts`'s own guard: `$(`, a backtick, or
 * a bare `&` (background) each bail out to "can't decide" (null) rather than guess through a
 * subshell that could hide anything. Quoted `&&`/`;`/`|` (inside a sed expression, say) are never
 * split on - only *unquoted*, top-level occurrences count as real separators.
 */

const UNSAFE_SUBSTRINGS = ["$(", "`"];
// A lone `&` (background) - not part of `&&` - is unsafe to decompose; checked separately from
// UNSAFE_SUBSTRINGS above since a plain `.includes("&")` would also (wrongly) flag every `&&`.
const BARE_AMPERSAND_RE = /(?<!&)&(?!&)/;

/** File-path substrings that make a command sensitive regardless of which sub-command carries
 * them - mirrors the `Read`/`Edit` deny globs in settings.ts (`.env`, `*.pem`, `*.key`, `*.pfx`,
 * `id_rsa*`, `~/**`), which only bind Claude's `Read`/`Edit` tools and so don't cover the same
 * paths reached via a Bash command (`sed -i`, `cp`, `mv`, ...). Checked against the *whole* raw
 * command string, not per sub-command, so a secret path smuggled into an argument of an otherwise
 * innocuous-looking piece of the chain still blocks the auto-approval. */
const SENSITIVE_PATH_RE = /\.env\b|\.pem\b|\.key\b|\.pfx\b|id_rsa|(^|[\s"'])~[/\\]/i;

export function containsSensitivePath(command: string): boolean {
  return SENSITIVE_PATH_RE.test(command);
}

/**
 * Splits on top-level (unquoted) `&&`, `||`, `;`, `|`. Returns `null` - "don't try" - if the
 * command contains a metacharacter this splitter can't safely reason about, or ends with an
 * unterminated quote (malformed/unparseable input; never guess toward "safe" on those).
 */
export function splitTopLevelCommands(command: string): string[] | null {
  if (UNSAFE_SUBSTRINGS.some((ch) => command.includes(ch)) || BARE_AMPERSAND_RE.test(command)) return null;

  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      parts.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converts one `Bash(...)`-shaped settings.ts glob into a real regex, rather than special-casing
 * "ends with ` *`" and treating everything else as an exact string - that first version silently
 * mis-parsed `Bash(rm -rf /*)` and `Bash(curl * | sh)` (both real settings.ts deny entries, wildcard
 * mid-string rather than at the very end) as literal strings requiring an actual `*` character to
 * ever match, i.e. as dead rules that could never fire. A trailing ` *` still gets its own case: it
 * means "this exact prefix, or this prefix plus more" (`git status` alone must match `Bash(git
 * status *)` too), which a bare `.*` substitution at the end wouldn't allow (`.*` still requires the
 * preceding literal space).
 */
function bashRulePattern(inner: string): RegExp {
  if (inner.endsWith(" *")) {
    const prefix = inner.slice(0, -2);
    return new RegExp(`^${escapeRegExp(prefix)}(\\s.*)?$`);
  }
  return new RegExp(`^${escapeRegExp(inner).replace(/\\\*/g, ".*")}$`);
}

/** `rule` is one `Bash(...)`-shaped entry from settings.ts's own deny/ask/allow lists. */
function subcommandMatchesBashRule(subcommand: string, rule: string): boolean {
  const match = rule.match(/^Bash\((.*)\)$/);
  if (!match) return false;
  return bashRulePattern(match[1]!).test(subcommand);
}

function subcommandMatchesAny(subcommand: string, rules: readonly string[]): boolean {
  return rules.some((rule) => subcommandMatchesBashRule(subcommand, rule));
}

/**
 * True when every sub-command of `command` is covered by `settings.permissions.allow` (plus
 * `extraAllowPrefixes`, the Bridge's own widened-beyond-Claude-Code's-static-list additions - see
 * `WIDENED_AUTO_APPROVE_PREFIXES`) and none is covered by `settings`'s own `ask`/`deny` lists -
 * i.e. this compound command is exactly as safe as if each piece had run on its own, no more.
 * Returns `false` (never guesses toward "safe") for anything the splitter declined to decompose,
 * for an empty command, or for a command carrying a sensitive path anywhere in the raw string.
 * `cd` is special-cased to always pass regardless of target: it only changes this Bash call's own
 * working directory, with no side effect the rest of the chain doesn't already have to earn
 * approval for on its own.
 */
export function isCompoundCommandFullyAllowed(command: string, settings: PermissionSettings, extraAllowPrefixes: readonly string[] = []): boolean {
  if (containsSensitivePath(command)) return false;

  const parts = splitTopLevelCommands(command);
  if (!parts || parts.length === 0) return false;

  const allow = [...settings.permissions.allow, ...extraAllowPrefixes];
  return parts.every((part) => {
    if (part === "cd" || part.startsWith("cd ")) return true;
    if (subcommandMatchesAny(part, settings.permissions.deny) || subcommandMatchesAny(part, settings.permissions.ask)) return false;
    return subcommandMatchesAny(part, allow);
  });
}

/**
 * The Bridge's own widened-beyond-Claude-Code's-static-list additions, used only inside this
 * compound-decomposition path - deliberately NOT added to settings.ts's own generated `allow`
 * list, so a lone freestanding `sed -i` (not part of an already-mostly-trusted chain) still prompts
 * normally. An in-place edit is Edit-tool-equivalent risk, so this stays scoped to exactly the
 * "every other piece of this chain was already going to be silently allowed" case the compound
 * check above requires, combined with the sensitive-path guard both functions share.
 */
export const WIDENED_AUTO_APPROVE_PREFIXES = ["Bash(sed -i *)"] as const;
