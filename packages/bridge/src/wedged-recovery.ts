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

/** Kills `slug`'s PTY without touching `ptyProcessBySlug` - returns whether there was anything to
 * kill (`false` means it's already gone: a manual `/kill`/`/rm`, or a real crash, raced the wedged
 * detection that called this). */
export function recoverWedgedPty(ptyProcessBySlug: PtyLookup, slug: string): boolean {
  const ptyProcess = ptyProcessBySlug.get(slug);
  if (!ptyProcess) return false;
  ptyProcess.kill();
  return true;
}
