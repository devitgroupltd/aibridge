import type { SessionRow } from "./session-store.ts";

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

/**
 * §4.5's "process alive, no row" case - a session process that survived whatever left its DB row
 * gone (a crash mid-`/new`, before the row was ever inserted; a row deleted by `/rm` while the
 * process it named was still somehow alive). Scoped to processes carrying
 * `--dangerously-load-development-channels` (session-launcher.ts's own launch flag) - the one
 * substring that's true of every aibridge-spawned `claude` process and essentially nothing else on
 * the box, so an operator's own unrelated terminal sessions never get flagged. A pid referenced by
 * any *non-dead* row is not an orphan - it's a session this Bridge instance still manages. A
 * `dead` row's pid is deliberately **not** treated as known: `/kill`/topic-deletion reconciliation
 * mark a row dead on the assumption its process is gone (measured true on this stack, §4.5), so a
 * process that still matches a dead row's old pid is exactly the "somehow survived" case worth
 * surfacing, not suppressing - the alternative (never re-checking a dead row's pid again) would
 * hide a real leak behind the very state that was supposed to mean "cleaned up".
 */
export function findOrphanProcesses(processes: readonly ProcessInfo[], rows: readonly SessionRow[]): ProcessInfo[] {
  const knownPids = new Set(rows.filter((r) => r.state !== "dead").map((r) => r.ptyPid));
  return processes.filter(
    (p) => p.commandLine.includes("--dangerously-load-development-channels") && !knownPids.has(p.pid),
  );
}
