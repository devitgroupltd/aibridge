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

/** Kills `slug`'s PTY without touching `ptyProcessBySlug` - returns whether there was anything to
 * kill (`false` means it's already gone: a manual `/kill`/`/rm`, or a real crash, raced the wedged
 * detection that called this). */
export function recoverWedgedPty(ptyProcessBySlug: Map<string, KillablePty>, slug: string): boolean {
  const ptyProcess = ptyProcessBySlug.get(slug);
  if (!ptyProcess) return false;
  ptyProcess.kill();
  return true;
}
