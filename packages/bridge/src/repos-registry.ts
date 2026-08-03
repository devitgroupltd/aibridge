import { readFileSync } from "node:fs";

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
