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
