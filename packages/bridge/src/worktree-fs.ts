/**
 * The one scoping chokepoint for the Telegram file browser/search feature (`/browse`, `/find`) -
 * everything in `browse-nav.ts` and its wiring in `index.ts` calls through `resolveWorktreeRelPath`
 * before touching disk. This is Bridge-native code, not a Claude tool call, so it gets its own
 * independent containment rather than relying on `settings.ts`'s Claude-facing `deny` list at all -
 * that list only ever binds Claude's own Read/Edit tools (§8.3's already-accepted gap), and this
 * feature never goes through Claude.
 *
 * Modelled on `outbox.ts`'s `resolveOutboxPath` (`path.resolve` + `startsWith(dir + sep)`), extended
 * with a real-path check so a symlink/junction inside the worktree that points outside it is also
 * rejected, not just a `../` in the request. Every exported helper here takes/returns relative paths
 * as POSIX-style strings (forward slashes) - stable, backslash-free text for Telegram callback_data
 * and message display; only the actual filesystem calls convert to the native separator.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { scrubSecrets } from "./secret-scrub.ts";

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Directories never listed or descended into - build/vendor output that would otherwise dominate
 * every listing and search, plus `.git` (never useful here, and its internals aren't "the project"). */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target", "bin", "obj", ".venv"]);

/** Filename shapes denied independently of `settings.ts`'s Claude-facing `Read(.env)`/`Read(~/**)`
 * rules (§6.2) - this feature never goes through Claude's own permission engine, so it needs its own
 * copy of the same judgment call, not a reference to rules that don't bind it. Matching entries are
 * hidden from listings/search and rejected outright from view/send, regardless of extension case. */
const SECRET_NAME_PATTERNS: RegExp[] = [/^\.env(\..+)?$/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /\.pfx$/i];

export function isSecretShaped(name: string): boolean {
  return SECRET_NAME_PATTERNS.some((p) => p.test(name));
}

/** One shared exclusion rule for both `listDirectory` and `searchWorktree`'s walker - no duplicated
 * ignore logic between the two. */
export function shouldSkip(name: string, isDir: boolean): boolean {
  if (isDir) return SKIP_DIRS.has(name);
  return isSecretShaped(name);
}

export interface ResolvedWorktreePath {
  /** Native absolute path, symlink-resolved - safe to pass to `fs` calls. */
  abs: string;
  /** POSIX-style path relative to the worktree root, `""` at the root itself. */
  rel: string;
}

/**
 * Resolves a browse/search request's relative path against `worktreeRoot`, returning the real
 * (symlink-resolved) absolute path and its POSIX-style relative form if - and only if - it names
 * something that actually exists inside that root, or `null` otherwise. `path.resolve` collapses any
 * `../` before the string-level containment check runs (same as `outbox.ts`'s `resolveOutboxPath`),
 * and `realpathSync` on top of that catches the case `resolveOutboxPath` doesn't need to: a
 * symlink/junction that sits inside the worktree but points somewhere else on disk. Rejects rather
 * than clamping - a crafted traversal path is refused outright, never silently redirected to the root.
 */
export function resolveWorktreeRelPath(worktreeRoot: string, relPath: string): ResolvedWorktreePath | null {
  if (relPath.includes("\0")) return null;
  const nativeRel = relPath.split("/").join(path.sep);
  const rootResolved = path.resolve(worktreeRoot);
  const candidate = path.resolve(rootResolved, nativeRel);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) return null;
  if (!existsSync(candidate)) return null;

  let rootReal: string;
  let candidateReal: string;
  try {
    rootReal = realpathSync(rootResolved);
    candidateReal = realpathSync(candidate);
  } catch {
    return null;
  }
  if (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + path.sep)) return null;

  const rel = candidateReal === rootReal ? "" : toPosix(path.relative(rootReal, candidateReal));
  return { abs: candidateReal, rel };
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface DirListing {
  relPath: string;
  entries: DirEntry[];
  page: number;
  totalPages: number;
}

export const PAGE_SIZE = 15;

/**
 * Lists one directory's immediate children, folders sorted before files, paginated. Symlinked
 * entries are never followed and never shown - the simplest safe policy, avoiding both an escape and
 * an infinite-cycle risk in the same move, at the cost of hiding a legitimate symlink if a project
 * happens to keep one in its worktree (accepted; not a case this feature needs to support).
 */
export function listDirectory(worktreeRoot: string, relPath: string, page = 0): DirListing | null {
  const resolved = resolveWorktreeRelPath(worktreeRoot, relPath);
  if (!resolved) return null;
  let dirents;
  try {
    dirents = readdirSync(resolved.abs, { withFileTypes: true });
  } catch {
    return null;
  }
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue;
    const isDir = d.isDirectory();
    if (shouldSkip(d.name, isDir)) continue;
    entries.push({ name: d.name, isDir });
  }
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = entries.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);
  return { relPath: resolved.rel, entries: slice, page: clampedPage, totalPages };
}

export type SearchHitReason = "name" | "content";

export interface SearchHit {
  relPath: string;
  reason: SearchHitReason;
  line?: number;
  snippet?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  /** `rg` wasn't spawnable (missing binary, or any other spawn-time failure) - content search was
   * skipped, filename matches are still real. Shown to the operator, not swallowed silently. */
  contentSearchSkipped: boolean;
}

export const SEARCH_CAP = 20;

/** How many lines of a matched line's own text are kept in the result list - a preview, not the
 * point of truth (that's `readForPreview`'s `focusLine` window once the operator taps the result). */
const SNIPPET_MAX_CHARS = 200;

/**
 * Collects up to `limit` hits, not `cap` - one deliberate item past the caller's real cap, purely so
 * `searchWorktree` can tell "found cap, and there's at least one more" apart from "found cap, that's
 * everything" without walking the whole tree to completion. Stopping exactly at `cap` would make
 * `truncated` always false the moment name matches alone reached the cap - a real bug caught by this
 * feature's own test suite before it shipped.
 */
function walkFilenames(root: string, needle: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  function walk(dir: string): void {
    if (hits.length >= limit) return;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (hits.length >= limit) return;
      if (d.isSymbolicLink()) continue;
      const isDir = d.isDirectory();
      if (shouldSkip(d.name, isDir)) continue;
      const abs = path.join(dir, d.name);
      if (!isDir && d.name.toLowerCase().includes(needle)) {
        hits.push({ relPath: toPosix(path.relative(root, abs)), reason: "name" });
      }
      if (isDir) walk(abs);
    }
  }
  walk(root);
  return hits;
}

/**
 * Filename substring match plus content match via a spawned `rg`, both scoped and filtered the same
 * way `listDirectory` is. If `rg` fails to spawn (`ENOENT` - it's allow-listed for *Claude's own* bash
 * tool in `settings.ts`, which is no guarantee this Bridge-native code has it on `PATH`), this
 * degrades to filename-only results and reports `contentSearchSkipped: true` rather than throwing -
 * same "fail open" posture as `nl-router.ts`/`secret-scrub.ts` elsewhere in this codebase. Directory
 * names are never matched - a search result is always a file, so every hit can go straight into the
 * same file-action menu `/browse` uses.
 */
export function searchWorktree(worktreeRoot: string, query: string, cap = SEARCH_CAP): SearchResult {
  const root = path.resolve(worktreeRoot);
  const needle = query.toLowerCase();
  // Both loops below collect up to cap + 1, not cap - see walkFilenames's own doc comment for why:
  // that one extra hit is what lets the final truncated check tell "exactly cap" apart from "cap,
  // and there's more".
  const nameHits = walkFilenames(root, needle, cap + 1);

  const contentHits: SearchHit[] = [];
  let contentSearchSkipped = false;
  try {
    const globArgs = [...SKIP_DIRS].flatMap((d) => ["--glob", `!${d}`]);
    const out = execFileSync("rg", ["--line-number", "--no-heading", "--max-count", "1", ...globArgs, "-e", query, "."], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    for (const line of out.split("\n")) {
      if (contentHits.length >= cap + 1) break;
      if (!line.trim()) continue;
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (!match) continue;
      const [, filePath, lineStr, snippet] = match as [string, string, string, string];
      const relPath = toPosix(filePath.replace(/^\.[/\\]/, ""));
      if (isSecretShaped(path.basename(relPath))) continue;
      contentHits.push({ relPath, reason: "content", line: Number(lineStr), snippet: snippet.trim().slice(0, SNIPPET_MAX_CHARS) });
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    const status = (err as { status?: number }).status;
    if (status === 1) {
      // `rg` exits 1 for "ran fine, no matches" - not a failure, nothing to add.
    } else if (code === "ENOENT") {
      contentSearchSkipped = true;
    } else {
      contentSearchSkipped = true;
    }
  }

  const all = [...nameHits, ...contentHits];
  return { hits: all.slice(0, cap), truncated: all.length > cap, contentSearchSkipped };
}

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_SEND_BYTES = 45 * 1024 * 1024; // under sendDocument's ~50MB multipart limit
const PREVIEW_WINDOW_LINES = 20;
/** Leaves room for a fenced code block's own wrapper text within Telegram's 4096-char message cap. */
const PREVIEW_TEXT_CAP = 3500;

/** No NUL byte in the first 8KB - the same cheap "looks like text" heuristic used elsewhere for this
 * kind of check; false positives/negatives on exotic encodings are an accepted cost, not a promise. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export interface PreviewResult {
  text: string;
  truncated: boolean;
  binary: boolean;
  tooLarge: boolean;
}

/**
 * Reads a file for the `👁 View` action: UTF-8, scrubbed through `secret-scrub.ts` before it's ever
 * placed into a message (defense-in-depth on top of `isSecretShaped`'s filename filter - a secret can
 * live in an innocuously-named file), and windowed. When `focusLine` is given (opened from a
 * content-search hit) the excerpt is centred on that line instead of truncated from the top - the top
 * of a large file frequently wouldn't even include the line that actually matched.
 */
export function readForPreview(worktreeRoot: string, relPath: string, focusLine?: number): PreviewResult | null {
  const resolved = resolveWorktreeRelPath(worktreeRoot, relPath);
  if (!resolved) return null;
  // Defense-in-depth: `listDirectory`/`searchWorktree` already exclude secret-shaped names so a
  // browse/find UI never mints an id pointing at one, but this checks again rather than trusting
  // that every future caller reaches this only through those two paths.
  if (isSecretShaped(path.basename(resolved.abs))) return null;
  let stat;
  try {
    stat = statSync(resolved.abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_PREVIEW_BYTES) return { text: "", truncated: false, binary: false, tooLarge: true };
  const buf = readFileSync(resolved.abs);
  if (looksBinary(buf)) return { text: "", truncated: false, binary: true, tooLarge: false };

  const scrubbed = scrubSecrets(buf.toString("utf8")).text;
  const lines = scrubbed.split("\n");
  let windowLines = lines;
  let truncated = false;
  if (focusLine !== undefined) {
    const start = Math.max(0, focusLine - 1 - PREVIEW_WINDOW_LINES);
    const end = Math.min(lines.length, focusLine + PREVIEW_WINDOW_LINES);
    truncated = start > 0 || end < lines.length;
    windowLines = lines.slice(start, end);
  }
  let text = windowLines.join("\n");
  if (text.length > PREVIEW_TEXT_CAP) {
    text = text.slice(0, PREVIEW_TEXT_CAP);
    truncated = true;
  }
  return { text, truncated, binary: false, tooLarge: false };
}

export interface SendPrep {
  bytes: Uint8Array;
  filename: string;
  tooLarge: boolean;
}

/**
 * Prepares a file for the `📄 Send file` action. Text-shaped files are scrubbed through
 * `secret-scrub.ts` in memory before being handed to `sendDocumentFile` - the residual gap this
 * closes: `isSecretShaped` only filters by *filename*, so a secret embedded in a plausibly-named text
 * file (`config.json`, `backup.sql`, ...) would otherwise reach Telegram completely unscrubbed, since
 * raw bytes bypass `readForPreview` entirely on this path. Genuine binaries (images, archives,
 * compiled output) skip scrubbing and send as-is - text-pattern scrubbing doesn't apply to binary
 * content anyway, so `isSecretShaped`'s filename denylist remains the only defence for that narrower
 * case, the same residual-gap shape §8.2/§8.3 already document elsewhere in the plan.
 */
export function prepareFileForSend(worktreeRoot: string, relPath: string): SendPrep | null {
  const resolved = resolveWorktreeRelPath(worktreeRoot, relPath);
  if (!resolved) return null;
  if (isSecretShaped(path.basename(resolved.abs))) return null;
  let stat;
  try {
    stat = statSync(resolved.abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const filename = path.basename(resolved.abs);
  if (stat.size > MAX_SEND_BYTES) return { bytes: new Uint8Array(0), filename, tooLarge: true };
  const buf = readFileSync(resolved.abs);
  if (looksBinary(buf)) return { bytes: buf, filename, tooLarge: false };
  const scrubbed = scrubSecrets(buf.toString("utf8")).text;
  return { bytes: new TextEncoder().encode(scrubbed), filename, tooLarge: false };
}

/**
 * Parses `origin`'s configured URL for a `github.com` owner/repo pair. `null` on any failure (no
 * `origin`, not a `github.com` remote, not a git repo at all) - shared by `resolveGithubLink` below
 * and `diff-review.ts`'s compare-link builder, so the regex lives in exactly one place. Reads via
 * `git config --get remote.origin.url` rather than `git remote get-url origin` deliberately - the
 * latter applies any local `url.<x>.insteadOf` rewrite before returning, which would silently report
 * a different host than what's actually configured (harmless in practice today, but this function's
 * whole job is "what host is this," so it should read the literal configured value).
 */
export function parseGithubOwnerRepo(worktreeRoot: string): { owner: string; repo: string } | null {
  const root = path.resolve(worktreeRoot);
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: root, encoding: "utf8" }).trim();
    const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (!m) return null;
    const [, owner, repo] = m as [string, string, string];
    return { owner, repo };
  } catch {
    return null;
  }
}

/**
 * `git branch -r --contains <sha>` - is this commit already reachable from some pushed remote branch?
 * Returns the first matching branch's short name (the `origin/` remote prefix stripped) or `null` if
 * none contain it (expected early in a session per the plan's §2.3 session model - a session's own
 * branch is only pushed after an explicit, ask-gated `git push`, not a bug to work around). Shared by
 * `resolveGithubLink` below and `diff-review.ts`'s compare-link builder (which uses a positive result
 * as its base ref, avoiding an unnecessary throwaway branch). Never throws - `null` on any git failure.
 */
export function findRemoteBranchContaining(worktreeRoot: string, sha: string): string | null {
  const root = path.resolve(worktreeRoot);
  try {
    const containing = execFileSync("git", ["branch", "-r", "--contains", sha], { cwd: root, encoding: "utf8" }).trim();
    if (containing.length === 0) return null;
    const first = containing.split("\n")[0]?.trim().replace(/^\*\s*/, "") ?? "";
    const slash = first.indexOf("/");
    return slash === -1 ? first : first.slice(slash + 1);
  } catch {
    return null;
  }
}

/**
 * Best-effort GitHub blob link - `null` (button omitted) on any failure rather than a link that might
 * show stale content: no `github.com` remote, uncommitted local changes to this file, or the current
 * commit not yet pushed anywhere. Never throws.
 */
export function resolveGithubLink(worktreeRoot: string, relPath: string): string | null {
  const resolved = resolveWorktreeRelPath(worktreeRoot, relPath);
  if (!resolved) return null;
  const root = path.resolve(worktreeRoot);
  try {
    const owned = parseGithubOwnerRepo(root);
    if (!owned) return null;
    const status = execFileSync("git", ["status", "--porcelain", "--", resolved.rel], { cwd: root, encoding: "utf8" }).trim();
    if (status.length > 0) return null;
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    if (!findRemoteBranchContaining(root, head)) return null;
    return `https://github.com/${owned.owner}/${owned.repo}/blob/${head}/${resolved.rel}`;
  } catch {
    return null;
  }
}
