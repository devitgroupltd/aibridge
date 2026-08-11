/**
 * Shared by `compound-permission.ts` (splitting a chain into sub-commands) and `rule-derivation.ts`
 * (deciding whether a command is safe to generalise into an "Always allow" rule) - both need the
 * same answer to "does this command contain a subshell or background job this code can't safely
 * reason about", and having two copies is exactly how the bare-`&` false positive shipped in one
 * without the other (found live 2026-08-10, see compound-permission.ts's own history): a command
 * like `... 2>&1 | tail -N` was rejected outright because a bare `.includes("&")`-style check
 * flagged the `&` in `2>&1` as a job-control background operator.
 */

const UNSAFE_SUBSTRINGS = ["$(", "`"];
// A lone `&` (background) - not part of `&&` - is unsafe to reason about; checked separately from
// UNSAFE_SUBSTRINGS above since a plain `.includes("&")` would also (wrongly) flag every `&&`.
// Also excludes `&` immediately adjacent to `>` - `2>&1`, `>&2`, `&>file` are fd-duplication/
// redirect syntax, not job control, and are extremely common in exactly the trusted
// `cmd 2>&1 | tail -N` shape this exists to unblock.
const BARE_AMPERSAND_RE = /(?<![&>])&(?![&>])/;

/** True for a `$(`, a backtick, or a bare (non-redirect, non-`&&`) `&` - a subshell or background
 * job neither caller can safely decompose or generalise past. */
export function containsUnsafeSubshellOrBackground(command: string): boolean {
  return UNSAFE_SUBSTRINGS.some((ch) => command.includes(ch)) || BARE_AMPERSAND_RE.test(command);
}
