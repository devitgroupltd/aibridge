import { escapeForFeed } from "./feed-escape.ts";

/**
 * §7.2's Task Scheduler autostart, made reachable from the control topic instead of only from the
 * desk. Registers a logon-trigger task under the *current user's own account* (`/RL LIMITED`, no
 * "highest privileges", no SYSTEM) - deliberately the one mode that needs no admin rights, matching
 * the plan's own "check 'Run with highest privileges' only if it proves necessary; it should not
 * be" (§7.2).
 */
export const TASK_NAME = "aibridge";

/** `schtasks /Create` args for a logon-trigger task running `<bunExePath> run <entryScriptPath>`. */
export function buildCreateArgs(bunExePath: string, entryScriptPath: string): string[] {
  return ["/Create", "/TN", TASK_NAME, "/SC", "ONLOGON", "/TR", `"${bunExePath}" run "${entryScriptPath}"`, "/RL", "LIMITED", "/F"];
}

export function buildQueryArgs(): string[] {
  return ["/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"];
}

export function buildDeleteArgs(): string[] {
  return ["/Delete", "/TN", TASK_NAME, "/F"];
}

/**
 * `schtasks /Run` re-triggers an already-registered task's own action immediately, regardless of its
 * trigger type. `/restart` needs this specifically when running under Task Scheduler: Windows runs a
 * scheduled task's process inside a Job Object, and `child_process.spawn`'s `detached: true` on
 * Windows only sets `CREATE_NEW_PROCESS_GROUP`, not a job-breakaway flag - so a raw detached successor
 * is still killed the instant the Task-Scheduler-tracked parent exits, before it can finish starting.
 * Re-running the task via `schtasks` instead launches a wholly new, independent action outside the
 * dying job, so it survives the parent's exit. Live-verified 2026-08-06: the plain spawn path silently
 * failed this way the first time `/restart` was exercised against an autostart-launched Bridge.
 */
export function buildRunArgs(): string[] {
  return ["/Run", "/TN", TASK_NAME];
}

/**
 * Two `schtasks /Create` defaults have no flag to fix via `schtasks.exe` itself - both need the
 * `ScheduledTasks` PowerShell module instead, so `/autostart install` runs this once right after
 * `/Create` succeeds. Fetches the task by name and writes back only these two settings (not a fresh
 * settings object), so everything else `/Create` already applied (idle behaviour, power management,
 * `/RL LIMITED`) survives untouched.
 *
 * - **`ExecutionTimeLimit`** defaults to `PT72H` (3 days) - §7.2 point 2 calls this out explicitly as
 *   something that "would otherwise kill the fleet without explanation on the fourth day." Set to
 *   `PT0S` (no limit).
 * - **`MultipleInstances`** defaults to `IgnoreNew` - live-verified 2026-08-06 that this silently
 *   breaks `/restart`'s `buildRunArgs` path: `schtasks /Run` re-triggers the task while the old,
 *   about-to-exit instance is still marked "Running", `IgnoreNew` drops that request on the floor, and
 *   the old instance exits anyway (per `/restart`'s own logic), leaving nothing running at all - no
 *   crash, no error, just silence. Set to `Parallel` so the re-trigger actually starts a second
 *   instance instead of being ignored; the old one still exits itself moments later exactly as before.
 */
export function buildFixTaskSettingsScript(taskName: string = TASK_NAME): string {
  return (
    `$t = Get-ScheduledTask -TaskName '${taskName}'; ` +
    `$t.Settings.ExecutionTimeLimit = 'PT0S'; ` +
    `$t.Settings.MultipleInstances = 'Parallel'; ` +
    `Set-ScheduledTask -InputObject $t | Out-Null`
  );
}

export interface AutostartStatus {
  registered: boolean;
  status?: string;
  lastRunTime?: string;
  lastResult?: string;
}

/**
 * Parses `schtasks /Query /TN <name> /FO LIST /V`'s stdout/stderr. §9's silent-wrong risk: reading
 * the wrong field, or missing the "task not found" case, would report a dead autostart entry as
 * healthy. `/Query` against an unregistered task name exits non-zero with an `ERROR:` line on
 * stdout or stderr (locale-dependent which stream) rather than an empty success - both are treated
 * as "not registered" rather than parsed for fields that won't be there.
 */
export function parseQueryOutput(stdout: string, stderr: string): AutostartStatus {
  if (/ERROR:/i.test(stdout) || /ERROR:/i.test(stderr) || stdout.trim().length === 0) {
    return { registered: false };
  }
  const field = (name: string): string | undefined => stdout.match(new RegExp(`^${name}:\\s*(.*)$`, "mi"))?.[1]?.trim();
  return {
    registered: true,
    status: field("Status"),
    lastRunTime: field("Last Run Time"),
    lastResult: field("Last Result"),
  };
}

export function renderAutostartStatus(s: AutostartStatus): string {
  if (!s.registered) {
    return `Not registered. Send /autostart install to register "${TASK_NAME}" as a logon-trigger scheduled task (§7.2) - no admin rights needed.`;
  }
  const lines = [`Registered as scheduled task "${TASK_NAME}" (runs at logon, current-user scope).`];
  if (s.status) lines.push(`Status: ${s.status}`);
  if (s.lastRunTime) lines.push(`Last run: ${s.lastRunTime}`);
  if (s.lastResult) lines.push(`Last result: ${s.lastResult}`);
  return escapeForFeed(lines.join("\n"));
}
