/**
 * §9's own discipline, applied to the dozens of `void asyncFn(...)` call sites this codebase uses
 * for genuine fire-and-forget work (a hook event forwarded, a confirm card finalized, an inbound
 * message dispatched) - every one of them silently depended on the callee never actually
 * rejecting, an unenforced convention with no type-level guard and no test. Combined with
 * `index.ts`'s `process.on("unhandledRejection", ... process.exit(1))` (load-bearing: a truly
 * unexpected rejection anywhere else in the process should be loud, not silently swallowed), one
 * missed internal `try/catch` in any of those ~45 sites is a full-fleet outage over a single
 * session's misbehavior - found live 2026-08-09 in `session-supervisor.ts`'s own
 * `void handleUnexpectedExit(...)` (see that module's `resumeSession`/`markDeadIfPresent`).
 *
 * `fireAndForget` is the one chokepoint every such call site should go through instead of a bare
 * `void`: it can never let a rejection reach the process as unhandled, and it leaves a log line
 * naming exactly which fire-and-forget call failed - today's bare `void` left no trace at all
 * beyond whatever (if any) the callee itself chose to log internally.
 */

import type { LogFn } from "./logger.ts";

/** `context` should name the call site (e.g. `"pipe-server handleReply"`), not the error - it's
 * what makes the log line useful when several fire-and-forget calls could plausibly be the
 * culprit. */
export function fireAndForget(promise: Promise<unknown>, log: LogFn, context: string): void {
  // `Promise.resolve(...)`, not a bare `.catch` on the argument itself: several call sites pass
  // through an injected callback typed `() => Promise<void>` whose test doubles return a plain
  // `undefined` synchronously rather than a real promise (common for a fire-and-forget stub with
  // nothing to await) - calling `.catch` directly on that throws `promise.catch is not a
  // function`, which is exactly the kind of failure this helper exists to prevent, not reintroduce.
  Promise.resolve(promise).catch((err) => {
    log("ERROR", `unhandled rejection in ${context}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  });
}
