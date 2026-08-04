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
      { windowsHide: true },
      (err, stdout) => {
        if (err || !stdout || stdout.trim().length === 0) {
          resolve([]);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          resolve(
            list
              .filter((p): p is { ProcessId: number; CommandLine?: string } => typeof p === "object" && p !== null && "ProcessId" in p)
              .map((p) => ({ pid: p.ProcessId, commandLine: p.CommandLine ?? "" })),
          );
        } catch {
          resolve([]);
        }
      },
    );
  });
}
