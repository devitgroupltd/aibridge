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
export type SessionState = "starting" | "idle" | "working" | "awaiting_input" | "dead";

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
  idle: ["working", "dead"],
  working: ["awaiting_input", "idle", "dead"],
  awaiting_input: ["working", "dead"],
  dead: [], // terminal until /rm removes the row entirely
};

export function isValidTransition(from: SessionState, to: SessionState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class SessionStore {
  private readonly db: SqliteHandleLike;

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
   * way to catch it up, guarded by `PRAGMA table_info` so it only runs once per missing column.
   */
  private migrate(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(sessions)").all() as unknown as { name: string }[]).map((c) => c.name));
    if (!columns.has("renamed")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0;");
    }
  }

  insert(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions
         (slug, topic_id, session_id, worktree_path, branch, repo_path, model, pty_pid, state, turn_card_msg, paused, renamed, created_utc, last_event_utc)
         VALUES ($slug, $topic_id, $session_id, $worktree_path, $branch, $repo_path, $model, $pty_pid, $state, $turn_card_msg, $paused, $renamed, $created_utc, $last_event_utc)`,
      )
      .run({
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
        $created_utc: row.createdUtc,
        $last_event_utc: row.lastEventUtc,
      });
  }

  get(slug: string): SessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE slug = $slug").get({ $slug: slug }) as unknown as SessionRowSql | undefined;
    return row ? fromSql(row) : undefined;
  }

  getByTopicId(topicId: number): SessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE topic_id = $topic_id").get({ $topic_id: topicId }) as unknown as SessionRowSql | undefined;
    return row ? fromSql(row) : undefined;
  }

  all(): SessionRow[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_utc ASC").all() as unknown as SessionRowSql[];
    return rows.map(fromSql);
  }

  slugs(): Set<string> {
    return new Set(this.all().map((r) => r.slug));
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
    this.db
      .prepare("UPDATE sessions SET state = $state, last_event_utc = $now WHERE slug = $slug")
      .run({ $state: state, $now: nowIso, $slug: slug });
  }

  setModel(slug: string, model: string): void {
    this.db.prepare("UPDATE sessions SET model = $model WHERE slug = $slug").run({ $model: model, $slug: slug });
  }

  setSessionId(slug: string, sessionId: string): void {
    this.db.prepare("UPDATE sessions SET session_id = $session_id WHERE slug = $slug").run({ $session_id: sessionId, $slug: slug });
  }

  setTurnCardMsg(slug: string, messageId: number | null): void {
    this.db.prepare("UPDATE sessions SET turn_card_msg = $msg WHERE slug = $slug").run({ $msg: messageId, $slug: slug });
  }

  setPaused(slug: string, paused: boolean): void {
    this.db.prepare("UPDATE sessions SET paused = $paused WHERE slug = $slug").run({ $paused: paused ? 1 : 0, $slug: slug });
  }

  setRenamed(slug: string): void {
    this.db.prepare("UPDATE sessions SET renamed = 1 WHERE slug = $slug").run({ $slug: slug });
  }

  setPtyPid(slug: string, ptyPid: number): void {
    this.db.prepare("UPDATE sessions SET pty_pid = $pty_pid WHERE slug = $slug").run({ $pty_pid: ptyPid, $slug: slug });
  }

  remove(slug: string): void {
    this.db.prepare("DELETE FROM sessions WHERE slug = $slug").run({ $slug: slug });
  }

  close(): void {
    this.db.close();
  }
}
