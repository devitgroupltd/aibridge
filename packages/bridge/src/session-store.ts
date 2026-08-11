import { createRequire } from "node:module";

/**
 * §4.3's routing table, persisted so the fleet survives a Bridge restart - `slug` is the primary
 * key (not `session_id`, which is unknown at topic-creation time and changes on `--resume`).
 * `repo_path`/`model` aren't in the plan's literal schema but are needed by `/rm` (which repo a
 * worktree was cut from) and `/ls` (the model column §4.2 lists); both are pragmatic additions,
 * not scope creep - deferred fields (session cost/tokens, §5.7) are left out entirely rather than
 * stubbed.
 *
 * The SQLite binding is chosen at runtime rather than statically importing `bun:sqlite`: a
 * node-pty (Windows ConPTY) write that succeeds against a perfectly healthy child process still
 * throws an unhandled "Socket is closed" from node-pty's internal stream on the very next tick
 * when the Bridge itself runs under Bun (confirmed live, 2026-08-03, with a minimal repro outside
 * this codebase) - so production keeps running under plain Node (`node:sqlite`), while `bun test`
 * (§9's test runner) picks up `bun:sqlite` instead. Both expose the same `.exec`/`.prepare(sql)
 * .run/.get/.all`/`.close` shape, confirmed live against this exact Bun version.
 */
interface SqliteStatementLike {
  run(params?: Record<string, unknown>): unknown;
  get(params?: Record<string, unknown>): unknown;
  all(params?: Record<string, unknown>): unknown[];
}
interface SqliteHandleLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}
type DatabaseCtor = new (path: string) => SqliteHandleLike;

// `createRequire` rather than a dynamic `import()` so this stays a synchronous constructor -
// both `bun:sqlite` and `node:sqlite` are built-ins reachable through either runtime's CJS
// interop, so there's no need to make `SessionStore` construction (and every caller of `new
// SessionStore(...)`) async just to pick one of two built-in modules.
function loadDatabaseCtor(): DatabaseCtor {
  const req = createRequire(import.meta.url);
  if (typeof Bun !== "undefined") {
    return (req("bun:sqlite") as { Database: DatabaseCtor }).Database;
  }
  return (req("node:sqlite") as { DatabaseSync: DatabaseCtor }).DatabaseSync;
}
export type SessionState = "starting" | "idle" | "working" | "awaiting_input" | "quota_stopped" | "dead";

/** §5.9's `/detail`: "compact" is today's 80-char one-liner/8-line-cap card; "full" wraps each
 * line's untruncated input (and, if `feedVerbose`, its tool output) in a collapsed
 * `<blockquote expandable>` instead - detail on demand, one tap away, without changing the card's
 * default footprint. */
export type FeedDetailLevel = "compact" | "full";

export interface SessionRow {
  slug: string;
  topicId: number;
  sessionId: string | null;
  worktreePath: string;
  branch: string;
  repoPath: string;
  model: string;
  ptyPid: number;
  state: SessionState;
  turnCardMsg: number | null;
  paused: boolean;
  /** §4.4's rename-once cap: flips true the first time the topic is renamed off its provisional
   * `/new`-prompt title, so a later Bridge restart or a second reply doesn't re-trigger it. */
  renamed: boolean;
  /** §5.9's `/detail <compact|full>` - per session, defaults to "compact". */
  feedDetail: FeedDetailLevel;
  /** §5.9's `/verbose <on|off>` - independent of `feedDetail`: whether a tool's actual output
   * (not just its input) is captured and shown, only visible at all once `feedDetail` is "full".
   * Defaults off - real tool output can contain arbitrary file content (the same §8.2 concern
   * that already governs `feedDetail`'s truncation), so showing it is opt-in, not the default. */
  feedVerbose: boolean;
  /** `/auto permission` (bypass-and-autoanswer-plan.md §0.2, revised 2026-08-11): mirrors
   * `routing.ts`'s in-memory `bypassBySlug` so the toggle survives a Bridge restart instead of
   * silently resetting to off. `routing.ts` remains the single read path during a live process -
   * this column only exists to re-hydrate that map on `resumeSession` (session-supervisor.ts). */
  bypassPermission: boolean;
  /** `/auto answer` - same restart-survival column as `bypassPermission` above, mirroring
   * `routing.ts`'s `autoAnswerBySlug`. */
  autoAnswer: boolean;
  /** `/mode` (revised 2026-08-11, same restart-survival motive as the two toggles above, found by
   * the same audit): mirrors `routing.ts`'s in-memory `modeBySlug`. Unlike `feedVerbose`/the two
   * toggles above, this one isn't cosmetic - `session-supervisor.ts`'s `resumeSession` reads
   * `routing.getMode(slug)` to build the real `--permission-mode` relaunch flag, so losing it on a
   * Bridge restart silently relaunched every non-`manual` session back in `manual` mode. Stored as
   * a plain string, not `Mode`, so this file doesn't need to import `session-commands.ts`'s type -
   * `routing.ts`'s `hydrateFromRow` re-validates against `MODES` the same way `index.ts`'s own
   * settingsStore-backed defaults do, in case a value was written by a build that later removed a
   * mode. */
  mode: string;
  createdUtc: string;
  lastEventUtc: string;
}

interface SessionRowSql {
  slug: string;
  topic_id: number;
  session_id: string | null;
  worktree_path: string;
  branch: string;
  repo_path: string;
  model: string;
  pty_pid: number;
  state: string;
  turn_card_msg: number | null;
  paused: number;
  renamed: number;
  feed_detail: string;
  feed_verbose: number;
  bypass_permission: number;
  auto_answer: number;
  mode: string;
  created_utc: string;
  last_event_utc: string;
}

function fromSql(row: SessionRowSql): SessionRow {
  return {
    slug: row.slug,
    topicId: row.topic_id,
    sessionId: row.session_id,
    worktreePath: row.worktree_path,
    branch: row.branch,
    repoPath: row.repo_path,
    model: row.model,
    ptyPid: row.pty_pid,
    state: row.state as SessionState,
    turnCardMsg: row.turn_card_msg,
    paused: row.paused !== 0,
    renamed: row.renamed !== 0,
    feedDetail: row.feed_detail === "full" ? "full" : "compact",
    feedVerbose: row.feed_verbose !== 0,
    bypassPermission: row.bypass_permission !== 0,
    autoAnswer: row.auto_answer !== 0,
    mode: row.mode,
    createdUtc: row.created_utc,
    lastEventUtc: row.last_event_utc,
  };
}

/**
 * §4.3's state table, exhaustive - no transition is implicit. Returns null for a transition not
 * in the table (e.g. `starting -> working`), so a caller can reject a bad hook-driven transition
 * instead of silently applying it (§9 scenario 40).
 */
const ALLOWED_TRANSITIONS: Record<SessionState, SessionState[]> = {
  starting: ["idle", "dead"],
  idle: ["working", "quota_stopped", "dead"],
  working: ["awaiting_input", "idle", "quota_stopped", "dead"],
  awaiting_input: ["working", "quota_stopped", "dead"],
  // §10.5 point 3: a quota stop can hit mid-turn from either signal (the OTLP `api_error` log event
  // or a `StopFailure` hook carrying a rate-limit error) - recoverable back to `working` once the
  // window resets and the operator (or a retried turn) picks the session back up, same as any other
  // `awaiting_input`-style pause rather than a dead end.
  quota_stopped: ["working", "idle", "dead"],
  dead: [], // terminal until /rm removes the row entirely
};

export function isValidTransition(from: SessionState, to: SessionState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** One entry per column added after the table's initial `CREATE TABLE IF NOT EXISTS` shape - see
 * `SessionStore.migrate`'s own doc comment. Order doesn't matter (each is independently guarded),
 * but is kept in the order the columns were actually added. */
const COLUMN_MIGRATIONS: readonly { column: string; ddl: string }[] = [
  { column: "renamed", ddl: "ALTER TABLE sessions ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0;" },
  { column: "feed_detail", ddl: "ALTER TABLE sessions ADD COLUMN feed_detail TEXT NOT NULL DEFAULT 'compact';" },
  { column: "feed_verbose", ddl: "ALTER TABLE sessions ADD COLUMN feed_verbose INTEGER NOT NULL DEFAULT 0;" },
  // Both default 0/off on an existing pre-2026-08-11 row, same fail-closed default the toggles
  // themselves have always had - an upgrade never silently grants a session either toggle it didn't
  // already have live in routing.ts's in-memory maps at the moment of the upgrade.
  { column: "bypass_permission", ddl: "ALTER TABLE sessions ADD COLUMN bypass_permission INTEGER NOT NULL DEFAULT 0;" },
  { column: "auto_answer", ddl: "ALTER TABLE sessions ADD COLUMN auto_answer INTEGER NOT NULL DEFAULT 0;" },
  // Defaults to the CLI's own real spawn default (session-commands.ts's DEFAULT_MODE) - an existing
  // pre-2026-08-11 row predates per-session mode tracking entirely, so "manual" is the only value
  // that was ever actually true for it.
  { column: "mode", ddl: "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual';" },
];

export class SessionStore {
  private readonly db: SqliteHandleLike;
  /** Caches each distinct SQL string's prepared statement rather than re-preparing (re-parsing) it
   * on every call - §9, found live 2026-08-09: every accessor/mutator below called
   * `this.db.prepare(sql)` fresh on every single invocation, needlessly re-parsing identical SQL on
   * every session read/write across a daemon meant to run for weeks. The set of distinct queries
   * this class issues is small and fixed (one per method below), so this cache can only ever hold a
   * handful of entries - never unbounded. */
  private readonly preparedCache = new Map<string, SqliteStatementLike>();

  constructor(dbPath: string) {
    const Database = loadDatabaseCtor();
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        slug           TEXT PRIMARY KEY,
        topic_id       INTEGER NOT NULL UNIQUE,
        session_id     TEXT UNIQUE,
        worktree_path  TEXT NOT NULL,
        branch         TEXT NOT NULL,
        repo_path      TEXT NOT NULL,
        model          TEXT NOT NULL,
        pty_pid        INTEGER NOT NULL,
        state          TEXT NOT NULL,
        turn_card_msg  INTEGER,
        paused         INTEGER NOT NULL DEFAULT 0,
        renamed        INTEGER NOT NULL DEFAULT 0,
        feed_detail    TEXT NOT NULL DEFAULT 'compact',
        feed_verbose   INTEGER NOT NULL DEFAULT 0,
        bypass_permission INTEGER NOT NULL DEFAULT 0,
        auto_answer    INTEGER NOT NULL DEFAULT 0,
        mode           TEXT NOT NULL DEFAULT 'manual',
        created_utc    TEXT NOT NULL,
        last_event_utc TEXT NOT NULL
      );
    `);
    this.migrate();
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` only helps a brand-new `$STATE/aibridge.db` - an existing one from
   * before a column was added (confirmed live 2026-08-03: `renamed` landing after this table had
   * already been created by an earlier Bridge run) keeps its old schema forever and throws "table
   * sessions has no column named X" on the next insert. `ALTER TABLE ... ADD COLUMN` is the SQLite
   * way to catch it up, guarded by `PRAGMA table_info` so it only runs once per missing column -
   * driven by `COLUMN_MIGRATIONS` (§9, found live 2026-08-09: this used to be one hand-written
   * `if (!columns.has(...)) exec(...)` block per column, so a new column cost a new copy-pasted
   * if-block here rather than one new table entry).
   */
  private migrate(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(sessions)").all() as unknown as { name: string }[]).map((c) => c.name));
    for (const { column, ddl } of COLUMN_MIGRATIONS) {
      if (!columns.has(column)) this.db.exec(ddl);
    }
  }

  private prepare(sql: string): SqliteStatementLike {
    let stmt = this.preparedCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.preparedCache.set(sql, stmt);
    }
    return stmt;
  }

  insert(row: SessionRow): void {
    this.prepare(
      `INSERT INTO sessions
       (slug, topic_id, session_id, worktree_path, branch, repo_path, model, pty_pid, state, turn_card_msg, paused, renamed, feed_detail, feed_verbose, bypass_permission, auto_answer, mode, created_utc, last_event_utc)
       VALUES ($slug, $topic_id, $session_id, $worktree_path, $branch, $repo_path, $model, $pty_pid, $state, $turn_card_msg, $paused, $renamed, $feed_detail, $feed_verbose, $bypass_permission, $auto_answer, $mode, $created_utc, $last_event_utc)`,
    ).run({
        $slug: row.slug,
        $topic_id: row.topicId,
        $session_id: row.sessionId,
        $worktree_path: row.worktreePath,
        $branch: row.branch,
        $repo_path: row.repoPath,
        $model: row.model,
        $pty_pid: row.ptyPid,
        $state: row.state,
        $turn_card_msg: row.turnCardMsg,
        $paused: row.paused ? 1 : 0,
        $renamed: row.renamed ? 1 : 0,
        $feed_detail: row.feedDetail,
        $feed_verbose: row.feedVerbose ? 1 : 0,
        $bypass_permission: row.bypassPermission ? 1 : 0,
        $auto_answer: row.autoAnswer ? 1 : 0,
        $mode: row.mode,
        $created_utc: row.createdUtc,
        $last_event_utc: row.lastEventUtc,
      });
  }

  get(slug: string): SessionRow | undefined {
    const row = this.prepare("SELECT * FROM sessions WHERE slug = $slug").get({ $slug: slug }) as unknown as SessionRowSql | undefined;
    return row ? fromSql(row) : undefined;
  }

  getByTopicId(topicId: number): SessionRow | undefined {
    const row = this.prepare("SELECT * FROM sessions WHERE topic_id = $topic_id").get({ $topic_id: topicId }) as unknown as SessionRowSql | undefined;
    return row ? fromSql(row) : undefined;
  }

  /** Joins an OTLP event's `session.id` (§5.7) back to a slug - `session_id` is unique but nullable
   * (unset until the first hook fires), so a lookup before that point is a legitimate miss, not an
   * error. */
  getBySessionId(sessionId: string): SessionRow | undefined {
    const row = this.prepare("SELECT * FROM sessions WHERE session_id = $session_id").get({ $session_id: sessionId }) as unknown as SessionRowSql | undefined;
    return row ? fromSql(row) : undefined;
  }

  all(): SessionRow[] {
    const rows = this.prepare("SELECT * FROM sessions ORDER BY created_utc ASC").all() as unknown as SessionRowSql[];
    return rows.map(fromSql);
  }

  /** §9, found live 2026-08-09: this used to go through the full `all()` - every column of every
   * row, plus `fromSql`'s field-by-field mapping - just to throw all of it away except the slugs.
   * A dedicated single-column query does exactly what's needed. */
  slugs(): Set<string> {
    const rows = this.prepare("SELECT slug FROM sessions").all() as unknown as { slug: string }[];
    return new Set(rows.map((r) => r.slug));
  }

  /** Throws on a transition not present in §4.3's table - callers should check
   * `isValidTransition` first when the transition is driven by untrusted/external input rather
   * than a code path that's already known to be safe. */
  setState(slug: string, state: SessionState, nowIso: string): void {
    const current = this.get(slug);
    if (!current) throw new Error(`setState: unknown slug "${slug}"`);
    if (!isValidTransition(current.state, state)) {
      throw new Error(`invalid session state transition for "${slug}": ${current.state} -> ${state}`);
    }
    this.prepare("UPDATE sessions SET state = $state, last_event_utc = $now WHERE slug = $slug").run({ $state: state, $now: nowIso, $slug: slug });
  }

  setModel(slug: string, model: string): void {
    this.prepare("UPDATE sessions SET model = $model WHERE slug = $slug").run({ $model: model, $slug: slug });
  }

  setSessionId(slug: string, sessionId: string): void {
    this.prepare("UPDATE sessions SET session_id = $session_id WHERE slug = $slug").run({ $session_id: sessionId, $slug: slug });
  }

  setTurnCardMsg(slug: string, messageId: number | null): void {
    this.prepare("UPDATE sessions SET turn_card_msg = $msg WHERE slug = $slug").run({ $msg: messageId, $slug: slug });
  }

  setPaused(slug: string, paused: boolean): void {
    this.prepare("UPDATE sessions SET paused = $paused WHERE slug = $slug").run({ $paused: paused ? 1 : 0, $slug: slug });
  }

  setRenamed(slug: string): void {
    this.prepare("UPDATE sessions SET renamed = 1 WHERE slug = $slug").run({ $slug: slug });
  }

  setFeedDetail(slug: string, level: FeedDetailLevel): void {
    this.prepare("UPDATE sessions SET feed_detail = $level WHERE slug = $slug").run({ $level: level, $slug: slug });
  }

  setFeedVerbose(slug: string, verbose: boolean): void {
    this.prepare("UPDATE sessions SET feed_verbose = $verbose WHERE slug = $slug").run({ $verbose: verbose ? 1 : 0, $slug: slug });
  }

  /** `routing.ts`'s `setBypass` write-through target - see that method's own doc comment for why
   * this is a mirror of the in-memory map, not the source of truth during a live process. */
  setBypassPermission(slug: string, on: boolean): void {
    this.prepare("UPDATE sessions SET bypass_permission = $on WHERE slug = $slug").run({ $on: on ? 1 : 0, $slug: slug });
  }

  /** `routing.ts`'s `setAutoAnswer` write-through target - same mirror relationship as
   * `setBypassPermission` above. */
  setAutoAnswer(slug: string, on: boolean): void {
    this.prepare("UPDATE sessions SET auto_answer = $on WHERE slug = $slug").run({ $on: on ? 1 : 0, $slug: slug });
  }

  /** `routing.ts`'s `setMode` write-through target - same mirror relationship as the two above,
   * except this one backs a value `resumeSession` actually relaunches with, not just a display. */
  setMode(slug: string, mode: string): void {
    this.prepare("UPDATE sessions SET mode = $mode WHERE slug = $slug").run({ $mode: mode, $slug: slug });
  }

  setPtyPid(slug: string, ptyPid: number): void {
    this.prepare("UPDATE sessions SET pty_pid = $pty_pid WHERE slug = $slug").run({ $pty_pid: ptyPid, $slug: slug });
  }

  remove(slug: string): void {
    this.prepare("DELETE FROM sessions WHERE slug = $slug").run({ $slug: slug });
  }

  close(): void {
    this.db.close();
  }
}
