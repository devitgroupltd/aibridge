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
}
