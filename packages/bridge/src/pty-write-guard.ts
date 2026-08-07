/**
 * Every write to a session's PTY has to survive that PTY having already gone away - found live
 * 2026-08-06 crashing the whole daemon on a brand-new session's very first write (`/new`'s initial
 * prompt, sent the instant `waitForChannelConnected` gives up at its 15s timeout and the caller
 * "proceeds anyway"): `Error: Socket is closed` from deep inside `node-pty`'s Windows backend,
 * `uncaughtException`, `process.exit(1)` - one session's dead PTY took the entire fleet down.
 *
 * A try/catch around the `write()` call is necessary but not sufficient. `windowsTerminal.js`'s own
 * source is explicit about why: its internal `inSocket` error handler re-throws unless
 * `this.listeners('error').length >= 2` - node-pty installs one listener on the `IPty` itself, so a
 * second is required from the consumer, or an internal socket error (not just a synchronous
 * `write()` throw) rethrows from inside node-pty's own IO callback, past any try/catch around the
 * call site, straight into `uncaughtException`. `attachPtyErrorGuard` is that second listener; it
 * only has to exist, not do anything - `wireSession`'s own `onExit` handler is still what tells the
 * rest of the codebase the session is gone.
 */

/** The slice of node-pty's `IPty` this module needs. `IPty`'s declared type has no `.on` - it's the
 * underlying `EventEmitter` node-pty's `WindowsTerminal` actually is, just not part of the public
 * surface - so callers cast their real `IPty` to this at the call site. */
export interface PtyLike {
  write(data: string): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export interface PtyWriteGuardOptions {
  log?: (level: "WARN", message: string) => void;
}

/**
 * Wires up the two independent halves of "a dead PTY must never crash the daemon": an `'error'`
 * listener (see this module's doc comment for why one alone is required) and a write wrapper that
 * swallows the *synchronous* half of the same failure mode. Returns the guarded write function;
 * callers pass this to whatever routes text into the session (`routing.setPtyWrite`, `/effort`'s
 * follow-up `\r`, etc.) instead of calling `ptyProcess.write` directly.
 */
export function attachPtyWriteGuard(ptyProcess: PtyLike, slug: string, opts: PtyWriteGuardOptions = {}): (text: string) => void {
  const log = opts.log ?? (() => {});

  ptyProcess.on("error", (err) => {
    log("WARN", `pty error for session "${slug}" (suppressed - a dead PTY must not crash the daemon): ${err.message}`);
  });

  return (text: string) => {
    try {
      ptyProcess.write(text);
    } catch (err) {
      log("WARN", `write to session "${slug}" dropped - its PTY is gone: ${(err as Error).message}`);
    }
  };
}
