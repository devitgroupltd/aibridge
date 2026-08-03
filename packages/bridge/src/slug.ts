/**
 * §9 scenario 27: slugs are the routing table's primary key and double as the worktree directory
 * name under `c:\data\worktrees\<slug>` (§7.5), so they must be both unique across the fleet and
 * safe as a single path segment - no `..`, no path separators, no reserved Windows device names.
 */

const MAX_SLUG_LENGTH = 40;
const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Lowercases, keeps `[a-z0-9-]` only, collapses/trims dashes - a prompt like "Fix `../etc/passwd`
 * traversal!!" becomes "fix-etc-passwd-traversal", never a literal path-traversal fragment. */
function sanitize(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  if (cleaned.length === 0 || WINDOWS_RESERVED_NAMES.has(cleaned)) {
    return "session";
  }
  return cleaned;
}

/** First up-to-5 words of the prompt, sanitized. Falls back to "session" for an empty/all-symbol
 * prompt so `/new` never produces an empty or unsafe path segment. */
export function slugFromPrompt(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 5).join(" ");
  return sanitize(words);
}

/** Appends `-2`, `-3`, ... until the result isn't already in `existingSlugs` - identical prompts
 * (or prompts that sanitize to the same base) get distinct, safe slugs rather than colliding on
 * the routing table's primary key or the worktree path derived from it. */
export function uniqueSlug(base: string, existingSlugs: ReadonlySet<string> | readonly string[]): string {
  const existing = existingSlugs instanceof Set ? existingSlugs : new Set(existingSlugs);
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
