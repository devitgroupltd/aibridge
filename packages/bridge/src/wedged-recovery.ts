/**
 * The one decidable piece of `index.ts`'s `autoRecoverWedgedSession`, pulled out so it's
 * unit-testable without spinning up a real node-pty process. The behavior that actually matters -
 * and the one regression that would silently defeat the whole fix - is *not* removing `slug` from
 * `ptyProcessBySlug` before killing it: `/kill`/`/rm` deliberately clear that entry first specifically
 * so `handleUnexpectedExit` (index.ts) treats the exit as deliberate and skips resuming it (see that
 * function's own doc comment). Leaving the entry in place here is what makes a wedged-session kill
 * indistinguishable from a real crash, so the existing `claude --resume <session_id>` path picks it
 * up automatically instead of the session being left dead.
 */
export interface KillablePty {
  kill(): void;
}

/** Only a lookup is needed - narrowed from `Map<string, KillablePty>` (the type this took before
 * `session-supervisor.ts` took over owning `ptyProcessBySlug`) so a real `Map` still satisfies it
 * structurally, but so does `session-supervisor.ts`'s `getPtyProcess` accessor wrapped in a plain
 * object literal - no need to leak the map itself out of the module that owns it. */
export interface PtyLookup {
  get(slug: string): KillablePty | undefined;
}

/**
 * How long a recovery mark keeps suppressing `SessionEnd`'s mark-dead (P0-8). Only has to span
 * `kill()` -> the dying process's own `SessionEnd` -> `onExit` -> the backoff wait -> the
 * successor's `SessionStart`, which was 33ms end to end for the first two steps in the live capture
 * and is dominated by `RESUME_BACKOFF_MS`'s first rung after that. Generous rather than tight, but
 * bounded on purpose: a mark that never expired would suppress the *genuine* `SessionEnd` of a
 * session whose recovery quietly never happened (e.g. `handleUnexpectedExit` returned early because
 * a newer PTY had already claimed the slug), leaving a dead session showing as live forever.
 */
export const WEDGED_RECOVERY_MARK_TTL_MS = 30_000;

/**
 * P0-8's "say what the Bridge is doing rather than make the exit handler infer it". The inference
 * this replaces - "the map entry is still there, so this exit must be a crash" - is defeated by a
 * channel `recoverWedgedPty`'s original reasoning never considered: **the killed `claude` runs its
 * own `SessionEnd` hook on the way out** (a real crash dies too fast to run hooks, which is exactly
 * why the asymmetry went unnoticed), and `feed-wiring.ts` marks the row `dead` off that hook 33ms
 * later - before `onExit` fires. `handleUnexpectedExit` then finds a `dead` row and bails, per
 * P0-1's own guard, so the resume this kill exists to trigger never happens and every subsequent
 * operator message is dropped with `no live session for slug "..."`.
 */
export interface WedgedRecoveryMarks {
  /** Set immediately before a Bridge-initiated recovery `kill()`, so the `SessionEnd` that kill is
   * about to provoke is recognizable as ours rather than as the session genuinely ending. */
  mark(slug: string): void;
  isRecovering(slug: string): boolean;
  /** Called once the successor process's `SessionStart` proves the recovery landed - the mark has
   * done its job, and a genuine exit after this point must be free to mark the row dead again. */
  clear(slug: string): void;
}

export function createWedgedRecoveryMarks(opts: { now?: () => number; ttlMs?: number } = {}): WedgedRecoveryMarks {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? WEDGED_RECOVERY_MARK_TTL_MS;
  const markedAt = new Map<string, number>();
  return {
    mark(slug: string): void {
      markedAt.set(slug, now());
    },
    isRecovering(slug: string): boolean {
      const at = markedAt.get(slug);
      if (at === undefined) return false;
      if (now() - at <= ttlMs) return true;
      // Expired marks are dropped on read rather than by a sweep of their own - this is the only
      // reader, and leaving them would grow the map by one per recovery for the daemon's lifetime.
      markedAt.delete(slug);
      return false;
    },
    clear(slug: string): void {
      markedAt.delete(slug);
    },
  };
}

/** Kills `slug`'s PTY without touching `ptyProcessBySlug` - returns whether there was anything to
 * kill (`false` means it's already gone: a manual `/kill`/`/rm`, or a real crash, raced the wedged
 * detection that called this). Marks the recovery *before* the kill, never after: the dying
 * process's `SessionEnd` hook can land in the same tick (33ms in the live capture), and a mark
 * written afterwards would lose that race exactly as reliably as having no mark at all. */
export function recoverWedgedPty(ptyProcessBySlug: PtyLookup, slug: string, marks: WedgedRecoveryMarks): boolean {
  const ptyProcess = ptyProcessBySlug.get(slug);
  if (!ptyProcess) return false;
  marks.mark(slug);
  ptyProcess.kill();
  return true;
}
