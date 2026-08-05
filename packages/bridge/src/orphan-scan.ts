import type { SessionRow } from "./session-store.ts";

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

/**
 * §4.5's "process alive, no row" case - a session process that survived whatever left its DB row
 * gone (a crash mid-`/new`, before the row was ever inserted; a row deleted by `/rm` while the
 * process it named was still somehow alive). Scoped to processes carrying either of
 * `session-launcher.ts`'s two launch flags - the dev-flag form
 * (`--dangerously-load-development-channels`) or, since 0.54.0's plugin-mode default, the plugin
 * form (`--channels plugin:aibridge-telegram@`) - either substring being true of essentially every
 * aibridge-spawned `claude` process and nothing else on the box, so an operator's own unrelated
 * terminal sessions never get flagged. Both are checked, not just whichever mode happens to be the
 * current default, since `AIBRIDGE_CHANNEL_MODE=dev-flag` can still launch the old form and an
 * orphan predating a mode switch could carry either one. A pid referenced by any *non-dead* row is
 * not an orphan - it's a session this Bridge instance still manages. A `dead` row's pid is
 * deliberately **not** treated as known: `/kill`/topic-deletion reconciliation mark a row dead on
 * the assumption its process is gone (measured true on this stack, §4.5), so a process that still
 * matches a dead row's old pid is exactly the "somehow survived" case worth surfacing, not
 * suppressing - the alternative (never re-checking a dead row's pid again) would hide a real leak
 * behind the very state that was supposed to mean "cleaned up".
 */
const AIBRIDGE_LAUNCH_FLAG_MARKERS = ["--dangerously-load-development-channels", "--channels plugin:aibridge-telegram@"];

export function findOrphanProcesses(processes: readonly ProcessInfo[], rows: readonly SessionRow[]): ProcessInfo[] {
  const knownPids = new Set(rows.filter((r) => r.state !== "dead").map((r) => r.ptyPid));
  return processes.filter(
    (p) => AIBRIDGE_LAUNCH_FLAG_MARKERS.some((marker) => p.commandLine.includes(marker)) && !knownPids.has(p.pid),
  );
}
