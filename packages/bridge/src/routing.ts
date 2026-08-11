import { DEFAULT_EFFORT, DEFAULT_MODE, MODES, type Effort, type Mode } from "./session-commands.ts";

/** Narrow slice of `session-store.ts`'s `SessionStore` that `Routing` needs for its restart-survival
 * write-throughs (`/auto permission`, `/auto answer`, `/mode`) - kept as an interface rather than
 * importing `SessionStore` directly so `routing.ts` doesn't need to know about SQLite, migrations, or
 * any of `SessionStore`'s other columns. */
export interface RoutingPersistence {
  setBypassPermission(slug: string, on: boolean): void;
  setAutoAnswer(slug: string, on: boolean): void;
  setMode(slug: string, mode: string): void;
}

/**
 * In-memory routing table (§4.3). Phase 1 keeps this in memory only, seeded once at startup with
 * the one hardcoded session - persistence via SQLite is explicitly Phase 5 work (§12).
 */
export interface SessionRoute {
  slug: string;
  topicId: number;
  worktreePath: string;
}

// §4.2's /attach: a bounded tail of raw PTY output, not the full scrollback - "best-effort read"
// per §4.2.1's convention, not a durable transcript (that's `claude --resume`'s job).
const RING_BUFFER_MAX_CHARS = 4000;

export class Routing {
  private readonly bySlug = new Map<string, SessionRoute>();
  private readonly slugByTopicId = new Map<number, string>();
  // §10.1.2: inbound delivery writes straight to the session's PTY rather than pushing through
  // the channel server, so the route needs a way to reach it. Kept separate from SessionRoute
  // itself since it's only known once launchSession() returns, after the route is already added.
  private readonly ptyWriteBySlug = new Map<string, (text: string) => void>();
  // §4.2.2: the protocol gives no ack for a Shift+Tab write, so this is the Bridge's own optimistic
  // belief about where the picker sits - not a verified read of the session's real state. Drifts if
  // the operator cycles modes by hand at the desk; see the plan's honest caveat. Revised 2026-08-11:
  // unlike that drift caveat, losing this map's value entirely (a fresh Bridge process) is not
  // cosmetic - `session-supervisor.ts`'s `resumeSession` reads `getMode` to build the real
  // `--permission-mode` relaunch flag, so `setMode` mirrors every write into `session-store.ts`'s
  // `mode` column and `hydrateFromRow` restores it before that relaunch, the same restart-survival
  // shape as the two toggles below.
  private readonly modeBySlug = new Map<string, Mode>();
  // Same "Bridge's own optimistic belief, no ack exists" caveat as modeBySlug above - the
  // keyboard-current-value display (session-commands.ts's buildEffortKeyboard) is the only
  // consumer, so drift here (including losing it entirely on a restart) is cosmetic, not something
  // any command's actual effect relies on - confirmed by audit 2026-08-11, unlike modeBySlug above.
  private readonly effortBySlug = new Map<string, Effort>();
  private readonly ringBufferBySlug = new Map<string, string>();
  // `/auto permission` / `/auto answer` (bypass-and-autoanswer-plan.md §0.2, revised 2026-08-11).
  // These maps are still the single read path for a live process - `getBypass`/`getAutoAnswer`
  // never touch `persistence` - but `setBypass`/`setAutoAnswer` mirror every write into
  // `session-store.ts`'s `bypass_permission`/`auto_answer` columns so the operator's standing
  // intent survives a Bridge restart instead of silently resetting to off with no visible signal
  // (the original design's tradeoff - see the plan's changelog for why it flipped). A restart still
  // starts every map empty; `hydrateFromRow` is what `session-supervisor.ts`'s `resumeSession` calls
  // to restore each slug's persisted values before its first post-restart permission request (and,
  // for mode, before the relaunch itself).
  private readonly bypassBySlug = new Map<string, boolean>();
  private readonly autoAnswerBySlug = new Map<string, boolean>();

  /** Optional - tests and the self-check route construct a `Routing` with no persistence at all,
   * getting the pre-2026-08-11 in-memory-only behavior (mode, auto-permission and auto-answer all
   * reset to their defaults on every restart). The live Bridge always passes `session-store.ts`'s
   * `SessionStore`.
   *
   * A plain field + body assignment, not a TS parameter property - found live 2026-08-11: the
   * Bridge runs under `node --experimental-strip-types` (§9, autostart.ts's `buildCreateArgs`),
   * which only erases type annotations and rejects parameter properties outright
   * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` - they need a real transform, synthesizing the field
   * assignment, not mere erasure). That crash happens at module-parse time, before `index.ts`'s
   * own `initFileLogging` call ever runs, so a scheduled-task `/restart` died silently: no log
   * line, no live Bridge, nothing but `schtasks`' own `Last Result: 1`. */
  private readonly persistence?: RoutingPersistence;

  constructor(persistence?: RoutingPersistence) {
    this.persistence = persistence;
  }

  add(route: SessionRoute): void {
    this.bySlug.set(route.slug, route);
    this.slugByTopicId.set(route.topicId, route.slug);
  }

  get(slug: string): SessionRoute | undefined {
    return this.bySlug.get(slug);
  }

  getByTopicId(topicId: number): SessionRoute | undefined {
    const slug = this.slugByTopicId.get(topicId);
    return slug ? this.bySlug.get(slug) : undefined;
  }

  all(): SessionRoute[] {
    return [...this.bySlug.values()];
  }

  /** Fleet-scoped `/kill`/`/rm` forget a session entirely - unlike a hook-driven state change,
   * which mutates the persisted row but leaves the route (and its worktree) in place. */
  remove(slug: string): void {
    const route = this.bySlug.get(slug);
    if (route) this.slugByTopicId.delete(route.topicId);
    this.bySlug.delete(slug);
    this.ptyWriteBySlug.delete(slug);
    this.modeBySlug.delete(slug);
    this.effortBySlug.delete(slug);
    this.ringBufferBySlug.delete(slug);
    // Safety-relevant, not bookkeeping: `uniqueSlug` (slug.ts) de-duplicates only against *live*
    // slugs, so `/rm fix-bug` frees that name for reuse. Leaving these set would have the next
    // session to claim it start fully auto-permitted, with nothing announcing that.
    this.bypassBySlug.delete(slug);
    this.autoAnswerBySlug.delete(slug);
  }

  setPtyWrite(slug: string, write: (text: string) => void): void {
    this.ptyWriteBySlug.set(slug, write);
  }

  /** `/kill` (§4.2): the process is gone, so its write function must stop being reachable, but the
   * route (topic mapping, ring buffer) stays so `/attach`/`/ls` still work against the dead row -
   * unlike `remove()`, which `/rm` uses to forget the session entirely. */
  clearPtyWrite(slug: string): void {
    this.ptyWriteBySlug.delete(slug);
  }

  getPtyWrite(slug: string): ((text: string) => void) | undefined {
    return this.ptyWriteBySlug.get(slug);
  }

  /** Phase 1 spawns every session with no `--permission-mode` flag, which defaults to `manual`
   * (confirmed live) - so that's the tracked starting value until the first `/mode` write. */
  getMode(slug: string): Mode {
    return this.modeBySlug.get(slug) ?? DEFAULT_MODE;
  }

  setMode(slug: string, mode: Mode): void {
    this.modeBySlug.set(slug, mode);
    this.persistence?.setMode(slug, mode);
  }

  getEffort(slug: string): Effort {
    return this.effortBySlug.get(slug) ?? DEFAULT_EFFORT;
  }

  setEffort(slug: string, effort: Effort): void {
    this.effortBySlug.set(slug, effort);
  }

  /** `/auto permission` - whether this session's permission requests are auto-allowed by the Bridge
   * before any card is posted (pipe-server.ts's `handlePermissionRequest`). Defaults to off. */
  getBypass(slug: string): boolean {
    return this.bypassBySlug.get(slug) ?? false;
  }

  setBypass(slug: string, on: boolean): void {
    this.bypassBySlug.set(slug, on);
    this.persistence?.setBypassPermission(slug, on);
  }

  /** `/auto answer` - whether this session's `AskUserQuestion` calls are auto-answered when Claude
   * marked exactly one option as recommended (pipe-server.ts's `handleAsk`). Defaults to off. */
  getAutoAnswer(slug: string): boolean {
    return this.autoAnswerBySlug.get(slug) ?? false;
  }

  setAutoAnswer(slug: string, on: boolean): void {
    this.autoAnswerBySlug.set(slug, on);
    this.persistence?.setAutoAnswer(slug, on);
  }

  /** `session-supervisor.ts`'s `resumeSession`, once per slug, from the persisted row - for `mode`
   * this must run *before* the relaunch (`getMode` feeds the real `--permission-mode` flag), so it's
   * one call covering all three rather than mode hydrated separately from the two toggles. Sets the
   * in-memory maps directly, without writing back through `persistence` - the values just came from
   * there, so a write-back would be a same-value no-op `UPDATE` on every single resume. Not
   * `setMode`/`setBypass`/`setAutoAnswer` for exactly that reason - this is a restore, not an
   * operator action, and shouldn't be confused with one in a log line or a future
   * `drainsOnEnable`-style side effect keyed off "the toggle just changed". Re-validates `mode`
   * against `MODES` the same way `index.ts`'s own settingsStore-backed defaults do, in case a value
   * was written by a build that later removed a mode - falls back to `DEFAULT_MODE` rather than
   * trusting the column's raw string. */
  hydrateFromRow(slug: string, row: { mode: string; bypassPermission: boolean; autoAnswer: boolean }): void {
    this.modeBySlug.set(slug, (MODES as readonly string[]).includes(row.mode) ? (row.mode as Mode) : DEFAULT_MODE);
    this.bypassBySlug.set(slug, row.bypassPermission);
    this.autoAnswerBySlug.set(slug, row.autoAnswer);
  }

  /** Appends raw PTY output to `/attach`'s ring buffer, trimmed to the last
   * `RING_BUFFER_MAX_CHARS` - a bounded tail, not a growing log. */
  appendOutput(slug: string, chunk: string): void {
    const current = this.ringBufferBySlug.get(slug) ?? "";
    const next = current + chunk;
    this.ringBufferBySlug.set(slug, next.length > RING_BUFFER_MAX_CHARS ? next.slice(-RING_BUFFER_MAX_CHARS) : next);
  }

  getOutputTail(slug: string): string {
    return this.ringBufferBySlug.get(slug) ?? "";
  }
}
