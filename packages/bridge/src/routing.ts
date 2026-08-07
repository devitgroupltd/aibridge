import { DEFAULT_EFFORT, DEFAULT_MODE, type Effort, type Mode } from "./session-commands.ts";

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
  // the operator cycles modes by hand at the desk; see the plan's honest caveat.
  private readonly modeBySlug = new Map<string, Mode>();
  // Same "Bridge's own optimistic belief, no ack exists" caveat as modeBySlug above - the
  // keyboard-current-value display (session-commands.ts's buildEffortKeyboard) is the only
  // consumer, so drift here is cosmetic, not something any command's actual effect relies on.
  private readonly effortBySlug = new Map<string, Effort>();
  private readonly ringBufferBySlug = new Map<string, string>();

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
  }

  getEffort(slug: string): Effort {
    return this.effortBySlug.get(slug) ?? DEFAULT_EFFORT;
  }

  setEffort(slug: string, effort: Effort): void {
    this.effortBySlug.set(slug, effort);
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
