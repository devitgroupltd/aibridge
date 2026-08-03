import type { SessionRow } from "./session-store.ts";

/**
 * §4.5's reconciliation table, as a pure decision function so it's unit-testable against a seeded
 * DB and a stubbed process table (§9 scenario 24) rather than only exercisable live. Scoped to the
 * rows the DB alone can drive: "process alive, no row" (an orphan from a Bridge crash mid-`/new`)
 * and "row exists, topic deleted in Telegram" both need a live-process/topic enumeration this pass
 * doesn't build - noted as a deferred gap, not silently skipped.
 */
export type ReconciliationAction =
  | { kind: "readopt"; slug: string }
  | { kind: "resume"; slug: string; sessionId: string | null }
  | { kind: "lost_prompt"; slug: string };

/**
 * §4.5's 2026-08-03 measurement: on this Windows/ConPTY stack, a live session's process does not
 * survive the Bridge dying, ever - so `isProcessAlive` returning true for a dead row's `pty_pid` is
 * the untested-in-practice branch scenario 24 still asks for (a recycled pid could coincidentally
 * be alive; the caller is expected to verify by image name, not just liveness, per §4.5).
 */
export function reconcile(rows: readonly SessionRow[], isProcessAlive: (pid: number) => boolean): ReconciliationAction[] {
  const actions: ReconciliationAction[] = [];
  for (const row of rows) {
    if (row.state === "dead") continue;

    if (row.state === "awaiting_input") {
      actions.push({ kind: "lost_prompt", slug: row.slug });
    }

    if (isProcessAlive(row.ptyPid)) {
      // The PTY handle belongs to the process that created it (§2.3) - a restarted Bridge can see
      // the process is alive but has no way to read its output or write to its stdin again, so
      // this is reported as terminal-detached, not silently treated as a healthy live session.
      actions.push({ kind: "readopt", slug: row.slug });
    } else {
      actions.push({ kind: "resume", slug: row.slug, sessionId: row.sessionId });
    }
  }
  return actions;
}
