/**
 * `/browse` and `/find` (Telegram file browser + search, session-scoped to a session's own
 * worktree). Not placed in `session-commands.ts` despite the name - that module is specifically for
 * commands that inject literal keystrokes into the PTY (`/model`/`/mode`/`/effort` have no backing
 * markdown file, no Bridge-owned rendering of their own). `/browse`/`/find` are the opposite: purely
 * Bridge-rendered, same shape as `/commands`/`/skills` (`fleet-commands.ts`'s `parseCommandsQuery`,
 * `commands.ts`'s listing helpers) - this module is their equivalent home.
 *
 * Registry pattern copied from `fleet-confirm.ts`/`permission-registry.ts`: a `Map<id, entry>` with
 * TTL, ids minted via `randomUUID().slice(0, 8)` (same convention `postFleetConfirm` uses in
 * index.ts). One deliberate difference from every other registry in this codebase: `get()` is
 * non-consuming (a `resolve()`-style pop would delete a folder's own id the first time its Prev/Next
 * button is tapped, breaking the second tap) and there's no stored `messageId` - a `/browse` tap
 * edits whichever message it came from, read straight off `callback_query.message.message_id`
 * (telegram.ts), not looked up from a registry entry per rendered message.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { monotonicNowMs } from "./monotonic-clock.ts";
import type { InlineKeyboardButton } from "./telegram.ts";
import { PAGE_SIZE, type DirListing, type SearchHit, type SearchResult } from "./worktree-fs.ts";

export type BrowseEntry =
  | { kind: "dir"; relPath: string }
  | { kind: "file"; relPath: string; matchLine?: number }
  | { kind: "hitset"; query: string; hits: SearchHit[]; truncated: boolean; contentSearchSkipped: boolean };

interface StoredEntry {
  slug: string;
  entry: BrowseEntry;
  createdAt: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export interface BrowseRegistryOptions {
  ttlMs?: number;
  /** Clock injection for expiry tests - defaults to `monotonicNowMs` (§7.4), never `Date.now()`
   * directly, for the same reason every other registry in this codebase avoids it: this only ever
   * computes a duration across a possible sleep. */
  now?: () => number;
}

export class BrowseRegistry {
  private readonly pending = new Map<string, StoredEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: BrowseRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? monotonicNowMs;
  }

  add(slug: string, entry: BrowseEntry): string {
    const id = randomUUID().slice(0, 8);
    this.pending.set(id, { slug, entry, createdAt: this.now() });
    return id;
  }

  /** Non-consuming and lazily expiring - an id may be tapped many times (paging through a folder,
   * revisiting a file's action menu) before its TTL runs out. */
  get(id: string): StoredEntry | undefined {
    const stored = this.pending.get(id);
    if (!stored) return undefined;
    if (this.now() - stored.createdAt > this.ttlMs) {
      this.pending.delete(id);
      return undefined;
    }
    return stored;
  }

  /** Periodic sweep (mirrors `permission-registry.ts`'s `sweepExpiredPermissions` shape, minus the
   * "unblock a waiting caller" step that doesn't apply here - nothing is waiting on a browse tap). */
  sweep(): void {
    const now = this.now();
    for (const [id, stored] of this.pending) {
      if (now - stored.createdAt > this.ttlMs) this.pending.delete(id);
    }
  }
}

/** `/browse [<path>]` - no path starts at the worktree root. Session-scoped only by construction:
 * `index.ts` only reaches this parser when a `route` (and thus a worktree) exists for the topic. */
export function parseBrowseCommand(text: string): { path: string } | null {
  const match = text.trim().match(/^\/browse(?:\s+(.+))?$/);
  if (!match) return null;
  return { path: (match[1] ?? "").trim() };
}

/** `/find <query>` - unlike `/browse`, a bare `/find` with no query isn't "search everything", it's
 * a malformed command (there's nothing useful to list) - returns `null`, same "not for us, or for us
 * but invalid" ambiguity the caller resolves the way `session-commands.ts` already does. */
export function parseFindCommand(text: string): { query: string } | null {
  const match = text.trim().match(/^\/find\s+(\S.*)$/);
  if (!match) return null;
  return { query: (match[1] ?? "").trim() };
}

/** `/diff` - no arguments in v1 (always the whole working tree). Boolean rather than a parsed struct
 * since there's nothing to extract - kept alongside `/browse`/`/find` as the third session-worktree-
 * native command, not because it shares their rendering (it doesn't page/browse anything) but because
 * it's the third command gated the same way: only reachable once a session's worktree exists. */
export function parseDiffCommand(text: string): boolean {
  return /^\/diff\s*$/.test(text.trim());
}

function paginationRow(prefix: string, id: string, page: number, totalPages: number): InlineKeyboardButton[] {
  const row: InlineKeyboardButton[] = [];
  if (page > 0) row.push({ text: "◀ Prev", callback_data: `${prefix}:${id}:${page - 1}` });
  if (page < totalPages - 1) row.push({ text: "Next ▶", callback_data: `${prefix}:${id}:${page + 1}` });
  return row;
}

/** Renders one `listDirectory` page as a folder-navigation keyboard - a row per entry (folders mint
 * a fresh `br:` id, files mint a fresh `bf:` id, sharing one mint per row since a row is never both),
 * a `⬆️ ..` row when not at the worktree root, and Prev/Next when paginated. */
export function buildDirKeyboard(registry: BrowseRegistry, slug: string, listing: DirListing): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  if (listing.relPath !== "") {
    const parentRel = path.posix.dirname(listing.relPath);
    const parentId = registry.add(slug, { kind: "dir", relPath: parentRel === "." ? "" : parentRel });
    rows.push([{ text: "⬆️ ..", callback_data: `br:${parentId}:0` }]);
  }
  for (const entry of listing.entries) {
    const childRel = listing.relPath === "" ? entry.name : `${listing.relPath}/${entry.name}`;
    if (entry.isDir) {
      const id = registry.add(slug, { kind: "dir", relPath: childRel });
      rows.push([{ text: `📁 ${entry.name}`, callback_data: `br:${id}:0` }]);
    } else {
      const id = registry.add(slug, { kind: "file", relPath: childRel });
      rows.push([{ text: `📄 ${entry.name}`, callback_data: `bf:${id}` }]);
    }
  }
  const pagination = paginationRow("br", registry.add(slug, { kind: "dir", relPath: listing.relPath }), listing.page, listing.totalPages);
  if (pagination.length > 0) rows.push(pagination);
  return rows;
}

export function renderDirText(listing: DirListing): string {
  const label = listing.relPath === "" ? "/ (worktree root)" : `/${listing.relPath}`;
  const pageSuffix = listing.totalPages > 1 ? ` - page ${listing.page + 1}/${listing.totalPages}` : "";
  const empty = listing.entries.length === 0 && listing.totalPages === 1 ? "\n(empty)" : "";
  return `📁 ${label}${pageSuffix}${empty}`;
}

const HITS_PAGE_SIZE = PAGE_SIZE;

function hitLabel(hit: SearchHit): string {
  return hit.reason === "content" ? `📄 ${hit.relPath}:${hit.line}` : `📄 ${hit.relPath}`;
}

/** Renders one page of a stored `/find` hit-set. The hit list itself is a snapshot taken at search
 * time, not re-run per page - re-querying on every Prev/Next tap could return a different set if the
 * worktree changes mid-browse, which would make "page 2" not actually follow from "page 1" the
 * operator just saw. */
export function buildHitsKeyboard(registry: BrowseRegistry, slug: string, hitsetId: string, hits: SearchHit[], page: number): InlineKeyboardButton[][] {
  const totalPages = Math.max(1, Math.ceil(hits.length / HITS_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = hits.slice(clampedPage * HITS_PAGE_SIZE, (clampedPage + 1) * HITS_PAGE_SIZE);
  const rows: InlineKeyboardButton[][] = slice.map((hit) => {
    const id = registry.add(slug, { kind: "file", relPath: hit.relPath, matchLine: hit.line });
    return [{ text: hitLabel(hit), callback_data: `bf:${id}` }];
  });
  const pagination = paginationRow("bs", hitsetId, clampedPage, totalPages);
  if (pagination.length > 0) rows.push(pagination);
  return rows;
}

export function renderHitsText(query: string, result: Pick<SearchResult, "hits" | "truncated" | "contentSearchSkipped">, page: number): string {
  if (result.hits.length === 0) {
    return `No matches for "${query}".${result.contentSearchSkipped ? " (content search unavailable - rg not found; showed filename matches only.)" : ""}`;
  }
  const totalPages = Math.max(1, Math.ceil(result.hits.length / HITS_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(0, page), totalPages - 1);
  const pageSuffix = totalPages > 1 ? ` - page ${clampedPage + 1}/${totalPages}` : "";
  const truncNote = result.truncated ? ` (showing first ${result.hits.length} - narrow your query for more)` : "";
  const skipNote = result.contentSearchSkipped ? " Content search unavailable (rg not found) - filename matches only." : "";
  return `🔍 "${query}"${pageSuffix}${truncNote}${skipNote}`;
}

/** The small action menu shown after tapping a file row from either `/browse` or `/find`. `githubUrl`
 * is `null` whenever `resolveGithubLink` couldn't produce one (see its own doc comment) - the button
 * is omitted rather than shown disabled/broken. */
export function buildFileActionKeyboard(id: string, githubUrl: string | null): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [
    [{ text: "👁 View", callback_data: `bv:${id}:view` }],
    [{ text: "📄 Send file", callback_data: `bv:${id}:send` }],
  ];
  if (githubUrl) rows.push([{ text: "🔗 GitHub", url: githubUrl }]);
  return rows;
}

export type BrowseCallback =
  | { kind: "dir"; id: string; page: number }
  | { kind: "file_menu"; id: string }
  | { kind: "file_action"; id: string; action: "view" | "send" }
  | { kind: "hits"; id: string; page: number };

/**
 * Parses `br:<id>:<page>` / `bf:<id>` / `bv:<id>:<view|send>` / `bs:<id>:<page>`, re-validating the
 * shape rather than trusting the tap - same defensive pattern every other `resolve*Callback` in this
 * codebase follows, since callback_data is attacker-shaped input in principle.
 */
export function resolveBrowseCallback(data: string): BrowseCallback | null {
  const dir = data.match(/^br:([A-Za-z0-9-]{1,40}):(\d+)$/);
  if (dir) return { kind: "dir", id: dir[1] ?? "", page: Number(dir[2]) };
  const fileMenu = data.match(/^bf:([A-Za-z0-9-]{1,40})$/);
  if (fileMenu) return { kind: "file_menu", id: fileMenu[1] ?? "" };
  const fileAction = data.match(/^bv:([A-Za-z0-9-]{1,40}):(view|send)$/);
  if (fileAction) return { kind: "file_action", id: fileAction[1] ?? "", action: fileAction[2] as "view" | "send" };
  const hits = data.match(/^bs:([A-Za-z0-9-]{1,40}):(\d+)$/);
  if (hits) return { kind: "hits", id: hits[1] ?? "", page: Number(hits[2]) };
  return null;
}
