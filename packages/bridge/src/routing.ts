import { DEFAULT_MODE, type Mode } from "./session-commands.ts";

/**
 * In-memory routing table (§4.3). Phase 1 keeps this in memory only, seeded once at startup with
 * the one hardcoded session - persistence via SQLite is explicitly Phase 5 work (§12).
 */
export interface SessionRoute {
  slug: string;
  topicId: number;
  worktreePath: string;
}

export class Routing {
  private readonly bySlug = new Map<string, SessionRoute>();
  // §10.1.2: inbound delivery writes straight to the session's PTY rather than pushing through
  // the channel server, so the route needs a way to reach it. Kept separate from SessionRoute
  // itself since it's only known once launchSession() returns, after the route is already added.
  private readonly ptyWriteBySlug = new Map<string, (text: string) => void>();
  // §4.2.2: the protocol gives no ack for a Shift+Tab write, so this is the Bridge's own optimistic
  // belief about where the picker sits - not a verified read of the session's real state. Drifts if
  // the operator cycles modes by hand at the desk; see the plan's honest caveat.
  private readonly modeBySlug = new Map<string, Mode>();

  add(route: SessionRoute): void {
    this.bySlug.set(route.slug, route);
  }

  get(slug: string): SessionRoute | undefined {
    return this.bySlug.get(slug);
  }

  all(): SessionRoute[] {
    return [...this.bySlug.values()];
  }

  setPtyWrite(slug: string, write: (text: string) => void): void {
    this.ptyWriteBySlug.set(slug, write);
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
}
