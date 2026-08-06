import { execFile } from "node:child_process";
import type { ProcessInfo } from "./orphan-scan.ts";

/**
 * Windows has no `ps -o command`-equivalent that ships with `node-pty`/Bun - `tasklist` doesn't
 * expose the full command line, so this shells out to `Get-CimInstance Win32_Process`, the same
 * primitive Task Manager's own "Details" > "Command line" column uses. Always resolves to `[]` on
 * any failure (PowerShell missing, WMI query error, malformed JSON) rather than rejecting - same
 * "never throw, let the caller see an empty result" convention as `runSchtasks` in `index.ts`. An
 * empty result just means orphan-detection finds nothing that pass, which is the safe direction to
 * fail in (this never drives an automatic kill - see `orphan-scan.ts`).
 */
/**
 * Split out for direct unit testing (§9's "silent-wrong" bar): `ConvertTo-Json` emits a bare object
 * rather than an array when exactly one process matches, and a wrong pid here is shown to an operator
 * who may act on it by killing something. A shape this doesn't recognise yields no entry rather than
 * an entry with a garbage pid.
 */
export function parseProcessList(stdout: string): ProcessInfo[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((p): p is { ProcessId: number; CommandLine?: string } => typeof p === "object" && p !== null && typeof (p as { ProcessId?: unknown }).ProcessId === "number")
      .map((p) => ({ pid: p.ProcessId, commandLine: typeof p.CommandLine === "string" ? p.CommandLine : "" }));
  } catch {
    return [];
  }
}

export function listClaudeProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      // A timeout, because "always resolves to []" was only true for *errors*, not for a hang - and
      // this promise is awaited by `runStartupReconciliation` before `startPolling` is ever reached.
      // A wedged WMI service (a real, known Windows condition) meant `Get-CimInstance` never
      // returned, so no session was resumed, Telegram was never polled, and nothing in the log said
      // why. Orphan reporting is advisory; the Bridge coming up is not.
      { windowsHide: true, timeout: 10_000, killSignal: "SIGKILL" },
      (err, stdout) => {
        if (err || !stdout || stdout.trim().length === 0) {
          resolve([]);
          return;
        }
        resolve(parseProcessList(stdout));
      },
    );
  });
}
