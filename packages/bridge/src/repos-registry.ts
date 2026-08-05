import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * §7.5's repo registry: a minimal TOML subset (`[name]` sections, `key = "value"`/`key = 'value'`
 * string pairs, `#` comments, blank lines) - hand-rolled the same way `config.ts` hand-rolls its
 * own env-file format rather than pulling in a TOML library for three fields.
 */
export interface RepoEntry {
  name: string;
  path: string;
  base?: string;
  model?: string;
}

const SECTION_RE = /^\[([A-Za-z0-9_-]+)\]$/;
const KV_RE = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/;

function parseValue(raw: string, lineNo: number): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  throw new Error(`malformed line ${lineNo} in repos.toml: "${raw}" (expected a quoted string)`);
}

/** Parses repos.toml's contents into an ordered list of repo entries, keyed by section name. */
export function parseReposToml(contents: string): RepoEntry[] {
  const entries: RepoEntry[] = [];
  const byName = new Map<string, RepoEntry>();
  let current: RepoEntry | null = null;

  const lines = contents.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const withoutComment = raw.split(/(?<!\\)#/)[0] ?? "";
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) continue;

    const sectionMatch = trimmed.match(SECTION_RE);
    if (sectionMatch) {
      const name = sectionMatch[1] as string;
      if (byName.has(name)) {
        throw new Error(`duplicate repo name "${name}" in repos.toml (line ${i + 1})`);
      }
      current = { name, path: "" };
      byName.set(name, current);
      entries.push(current);
      continue;
    }

    const kvMatch = trimmed.match(KV_RE);
    if (!kvMatch) {
      throw new Error(`malformed line ${i + 1} in repos.toml: "${raw}"`);
    }
    if (!current) {
      throw new Error(`line ${i + 1} in repos.toml appears before any [section] header: "${raw}"`);
    }
    const key = kvMatch[1] as string;
    const value = parseValue(kvMatch[2] as string, i + 1);
    if (key === "path") current.path = value;
    else if (key === "base") current.base = value;
    else if (key === "model") current.model = value;
    // Unrecognised keys are ignored rather than rejected - forward compatible with fields this
    // pass doesn't consume yet (e.g. a future per-repo hook override).
  }

  for (const entry of entries) {
    if (!entry.path) {
      throw new Error(`repo "${entry.name}" in repos.toml has no "path"`);
    }
  }

  return entries;
}

export class ReposRegistry {
  private readonly byName: Map<string, RepoEntry>;

  constructor(entries: RepoEntry[]) {
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  get(name: string): RepoEntry | undefined {
    return this.byName.get(name);
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  /** Every entry, in registration order - the `/repos`/`/settings` listing form; both used to
   * rebuild this list by hand from `names()`/`get()` before this existed. */
  all(): RepoEntry[] {
    return [...this.byName.values()];
  }
}

/** Same `[A-Za-z0-9_-]+` a `[section]` header accepts (`SECTION_RE`) - re-checked here so
 * `/repos add` rejects a bad name before it ever reaches `parseReposToml`/the file on disk. */
export function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

function quote(field: string, value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) {
    throw new Error(`repos.toml ${field} "${value}" can't contain a double quote or newline`);
  }
  return `"${value}"`;
}

/** The inverse of `parseReposToml` - round-trips through the same `[name]`/`key = "value"` subset,
 * so a file this writes parses back to the same entries. */
export function serializeReposToml(entries: readonly RepoEntry[]): string {
  return entries
    .map((e) => {
      const lines = [`[${e.name}]`, `path = ${quote("path", e.path)}`];
      if (e.base) lines.push(`base = ${quote("base", e.base)}`);
      if (e.model) lines.push(`model = ${quote("model", e.model)}`);
      return lines.join("\n");
    })
    .join("\n\n") + (entries.length > 0 ? "\n" : "");
}

/** scheme URLs (`https://`, `git://`, `ssh://`), scp-style `user@host:path`, or a bare `...repo.git`
 * - distinguishes a clone source from a local filesystem path in `/repos add <name> <path-or-url>`.
 * A Windows drive path (`C:\...`) never matches: no `@` before its colon, and no `.git` suffix. */
const GIT_URL_RE = /^(https?:\/\/|git:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/i;

export function isGitUrl(value: string): boolean {
  return GIT_URL_RE.test(value) || /\.git\/?$/i.test(value);
}

/**
 * §7.5's "if not provided, suggest one" ask: when every already-registered repo lives directly
 * under the same parent folder, `/repos add <name>` (no path) or `/repos add <name> <url>` (clone)
 * can infer `<that shared parent>\<name>` instead of requiring an explicit path every time. Returns
 * `null` (caller must fall back to asking for an explicit path/`--dest`) when there are no repos yet
 * to infer from, or when their parents don't already agree.
 */
export function inferDefaultRepoPath(existing: readonly RepoEntry[], name: string): string | null {
  if (existing.length === 0) return null;
  const parents = new Set(existing.map((e) => path.dirname(e.path)));
  if (parents.size !== 1) return null;
  const [parent] = parents;
  return path.join(parent as string, name);
}

/** `/repos add <name> <url>`'s clone step - runs before `addRepoEntry`'s own checks, so a clone
 * failure (bad URL, network, `destPath` already occupied) never touches repos.toml. `git clone`'s
 * own stderr is already operator-legible ("repository not found", "already exists and is not an
 * empty directory", ...) so it's surfaced close to verbatim rather than re-wrapped. */
export function cloneRepo(url: string, destPath: string, branch?: string): void {
  const args = ["clone", ...(branch ? ["--branch", branch] : []), url, destPath];
  try {
    execFileSync("git", args, { stdio: "pipe" });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new Error(`git clone failed: ${stderr || (err as Error).message}`);
  }
}

/**
 * `/repos add`'s write path (§7.5's registry made mutable from Telegram instead of only by hand):
 * validates the name, rejects a duplicate, checks the path exists and looks like a git repo/worktree
 * (a `.git` entry present - a file for a worktree, a directory for a full clone, `existsSync` covers
 * both), then rewrites the whole file. A missing repos.toml is treated as an empty registry rather
 * than an error, so `/repos add` also works as the very first registration.
 */
export function addRepoEntry(reposTomlPath: string, entry: RepoEntry): void {
  if (!isValidRepoName(entry.name)) {
    throw new Error(`repo name "${entry.name}" must match [A-Za-z0-9_-]+`);
  }
  let existing: RepoEntry[] = [];
  try {
    existing = parseReposToml(readFileSync(reposTomlPath, "utf8"));
  } catch {
    // No repos.toml yet - /repos add creates it fresh.
  }
  if (existing.some((e) => e.name === entry.name)) {
    throw new Error(`repo "${entry.name}" is already registered`);
  }
  if (!existsSync(entry.path)) {
    throw new Error(`path "${entry.path}" does not exist on this machine`);
  }
  if (!existsSync(path.join(entry.path, ".git"))) {
    throw new Error(`"${entry.path}" doesn't look like a git repo or worktree (no .git found)`);
  }
  writeFileSync(reposTomlPath, serializeReposToml([...existing, entry]), "utf8");
}

/** `/repos rm`'s write path - rejects an unknown name rather than silently no-oping, same "for us,
 * but invalid" discipline as `fleet-commands.ts`'s parsers. Only edits repos.toml; any worktree
 * already cut for a session against this repo is untouched (§7.5 - removing a project registration
 * doesn't retroactively touch running sessions). */
export function removeRepoEntry(reposTomlPath: string, name: string): void {
  const existing = parseReposToml(readFileSync(reposTomlPath, "utf8"));
  if (!existing.some((e) => e.name === name)) {
    throw new Error(`repo "${name}" is not registered`);
  }
  writeFileSync(reposTomlPath, serializeReposToml(existing.filter((e) => e.name !== name)), "utf8");
}

/** Throws naming the file, not a generic ENOENT, since a missing registry means every `/new` fails
 * with no obvious cause otherwise. */
export function loadReposRegistry(reposTomlPath: string): ReposRegistry {
  let contents: string;
  try {
    contents = readFileSync(reposTomlPath, "utf8");
  } catch {
    throw new Error(`repos.toml not found at ${reposTomlPath} - register at least one repo before using /new (§7.5)`);
  }
  return new ReposRegistry(parseReposToml(contents));
}
