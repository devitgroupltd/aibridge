/**
 * Found live 2026-08-06: an operator's `/restart` landing within ~1s of this same process's own
 * boot reconciliation having just resumed a session (`claude --resume <session_id>`) kills that
 * barely-alive session and immediately resumes the *same* `session_id` again in the successor
 * process - and Claude Code's own local resume bookkeeping doesn't tolerate two resumes of one
 * session_id back to back that closely; the second one comes up dead ("This session has ended.")
 * rather than actually resuming. §4.5's 2026-08-03 measurement ("a live session's process does not
 * survive the Bridge dying, ever") is what makes every restart re-resume every live row
 * unconditionally - correct on a normal crash-to-restart gap of minutes, not on a few hundred ms.
 *
 * Rather than guess at Claude Code's own settle time, this just keeps a self-triggered restart
 * (`/restart`, `/deploy`'s self-repo restart, the stale-deploy rollback) from re-entering
 * reconciliation before this process's *own* boot reconciliation has had a chance to breathe -
 * pure decision function, unit-testable against a fake clock rather than only exercisable live.
 */
export const RESTART_SETTLE_MS = 10_000;

/** Remaining ms to wait before it's safe to respawn, given when this process finished its own
 * boot reconciliation (`bootReadyAtMs`) and the current time (`nowMs`). 0 once settled. */
export function restartSettleDelayMs(bootReadyAtMs: number, nowMs: number, settleMs: number = RESTART_SETTLE_MS): number {
  const elapsed = nowMs - bootReadyAtMs;
  return Math.max(0, settleMs - elapsed);
}
