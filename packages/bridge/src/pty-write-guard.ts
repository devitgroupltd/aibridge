/**
 * Every write to a session's PTY has to survive that PTY having already gone away - found live
 * 2026-08-06 crashing the whole daemon on a brand-new session's very first write (`/new`'s initial
 * prompt, sent the instant `waitForChannelConnected` gives up at its 15s timeout and the caller
 * "proceeds anyway"): `Error: Socket is closed` from deep inside `node-pty`'s Windows backend,
 * `uncaughtException`, `process.exit(1)` - one session's dead PTY took the entire fleet down.
 *
 * A try/catch around the `write()` call is necessary but not sufficient. `windowsTerminal.js`'s own
 * source is explicit about why, for the *read* side: its `_socket` (`_agent.outSocket`) error
 * handler re-throws unless `this.listeners('error').length >= 2` - node-pty installs one listener on
 * the `IPty` itself, so a second is required from the consumer, or an internal socket error (not
 * just a synchronous `write()` throw) rethrows from inside node-pty's own IO callback, past any
 * try/catch around the call site, straight into `uncaughtException`. `attachPtyErrorGuard`'s `.on
 * ("error", ...)` on the `IPty` is that second listener for the read side.
 *
 * Found live again 2026-08-07 (killed the whole daemon a second time, on `/new`'s post-launch
 * `writeModeKeystrokes` this time, not the initial-prompt write the first fix targeted): the *write*
 * side has no such protection at all. `_doWrite` calls `_agent.inSocket.write(data)` directly -
 * `inSocket` is a plain internal socket `windowsTerminal.js` never attaches any `'error'` listener to,
 * on the `IPty` or anywhere else. A write to it after the underlying process has already died emits
 * `'error'` asynchronously (not a synchronous `write()` throw a try/catch could catch) on an
 * `EventEmitter` with zero listeners, which per Node's own contract throws straight into
 * `uncaughtException` regardless of how many listeners the outer `IPty` has. `attachPtyWriteGuard`
 * therefore also reaches into the private `_agent.inSocket` (there is no public API for this - see
 * the cast below) and attaches the same suppressing listener there.
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

/** The shape of node-pty's real (undocumented, underscore-prefixed) internals on Windows - `_agent`
 * only exists on `WindowsTerminal`, not the Unix backend, so this is always optional. Reached into
 * only to attach a suppressing `'error'` listener (see this module's doc comment); nothing here is
 * ever called. */
interface PtyInternals {
  _agent?: { inSocket?: { on(event: "error", listener: (err: Error) => void): void } };
}

/**
 * The two `'error'`-listener halves, split out so `session-launcher.ts`'s dev-only
 * `mirrorPtyToConsole` stdin passthrough - which needs its own write wrapper (it forwards raw
 * keyboard input, not routed text) rather than the wrapped-write function below - can still get the
 * same protection instead of relying on its own try/catch alone, which this module's doc comment
 * explains is not sufficient by itself.
 */
export function attachPtyErrorSuppression(ptyProcess: PtyLike, slug: string, opts: PtyWriteGuardOptions = {}): void {
  const log = opts.log ?? (() => {});
  const suppress = (err: Error): void => {
    log("WARN", `pty error for session "${slug}" (suppressed - a dead PTY must not crash the daemon): ${err.message}`);
  };

  ptyProcess.on("error", suppress);
  (ptyProcess as unknown as PtyInternals)._agent?.inSocket?.on("error", suppress);
}

/**
 * Wires up the independent halves of "a dead PTY must never crash the daemon": an `'error'` listener
 * on the `IPty` itself for the read side, the same on the private write-side `inSocket` (see this
 * module's doc comment for why both are required - node-pty protects neither by default, and the two
 * sockets are different objects), and a write wrapper that swallows the *synchronous* half of the
 * same failure mode. Returns the guarded write function; callers pass this to whatever routes text
 * into the session (`routing.setPtyWrite`, `/effort`'s follow-up `\r`, etc.) instead of calling
 * `ptyProcess.write` directly.
 */
export function attachPtyWriteGuard(ptyProcess: PtyLike, slug: string, opts: PtyWriteGuardOptions = {}): (text: string) => void {
  const log = opts.log ?? (() => {});
  attachPtyErrorSuppression(ptyProcess, slug, opts);

  return (text: string) => {
    try {
      ptyProcess.write(text);
    } catch (err) {
      log("WARN", `write to session "${slug}" dropped - its PTY is gone: ${(err as Error).message}`);
    }
  };
}
