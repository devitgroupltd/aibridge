import { execFile } from "node:child_process";

/**
 * The Bridge's wrapper around the three Windows built-ins it shells out to (`schtasks.exe`,
 * `powershell.exe`, `shutdown.exe`).
 *
 * Lived in `deploy-lifecycle-commands.ts` until now, because `/autostart` was the first command to
 * need it - but nothing here is about deploy or about any command. Two of its three consumers sit
 * outside that module entirely: `os-power-commands.ts` uses `runShutdown`/`runPowershell`, and
 * `index.ts` needs `runSchtasks` at boot for `respawnSelfAndExit`, well before any command handler
 * exists (its construction there carried a four-line comment apologising for reaching into a
 * command module to get it).
 */

/** Result shape shared by all three runners - `/Query` against an unregistered task exits non-zero,
 * which is a valid "not registered" answer, not a transport failure, so all three always resolve
 * rather than reject; callers that care about install/delete failing check `failed` themselves. */
export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  failed: boolean;
}

/** An injected `execFile`-shaped runner, so these are fakeable in tests rather than requiring a real
 * Windows host with a real Task Scheduler - same dependency-inversion treatment already applied to
 * `confirmSessionCommand` elsewhere. */
export type ExecFileFn = (
  command: string,
  args: string[],
  options: { windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export interface ProcessRunner {
  /** Wraps `schtasks.exe` (built into Windows, no extra dependency). */
  runSchtasks(args: string[]): Promise<ProcessRunResult>;
  /** Runs a PowerShell one-liner and reports success/failure the same shape as `runSchtasks` -
   * `schtasks.exe` alone can't fix the two task-settings defaults `buildFixTaskSettingsScript`
   * targets, so `/autostart install` needs this second tool as well. `stdout` was added for
   * `os-power-commands.ts`'s `checkAutoLogonEnabled` (needs the actual registry value back, not
   * just success/failure) - every existing caller only ever read `stderr`/`failed`, so this is a
   * pure addition, not a behaviour change for them. */
  runPowershell(script: string): Promise<ProcessRunResult>;
  /** Wraps `shutdown.exe` (built into Windows) - `/os shutdown|reboot|cancel` (os-power-commands.ts).
   * A third method on this same interface rather than a separate injectable, so there's still only
   * one process-runner shape to fake in tests. */
  runShutdown(args: string[]): Promise<ProcessRunResult>;
}

/** Same spawn-level-failure gap as `deploy.ts`'s `defaultRunner` (found live 2026-08-11, same day):
 * a *real* run of `cmd` (task registered or not, script ran or not) reports through `stderr` as
 * `execFileFn` already hands it back, but a *spawn-level* failure - `cmd` not resolvable, a
 * permission error - never runs the child process at all, so `stderr` comes back empty and the
 * only diagnostic left is `err.message` (Node's "spawn schtasks ENOENT"-shaped text). Without this
 * fallback, callers built exactly the bare, undiagnosable failure the `deploy.ts` fix addressed -
 * `schtasks /Create failed` / `(unknown error)` with nothing else to go on. */
function stderrOrMessage(err: Error | null, stderr: string): string {
  return stderr || (err?.message ?? "");
}

export function createProcessRunner(execFileFn: ExecFileFn = execFile as unknown as ExecFileFn): ProcessRunner {
  function run(command: string, args: string[]): Promise<ProcessRunResult> {
    return new Promise((resolve) => {
      execFileFn(command, args, { windowsHide: true }, (err, stdout, stderr) => {
        resolve({ stdout: stdout ?? "", stderr: stderrOrMessage(err, stderr ?? ""), failed: err !== null });
      });
    });
  }

  return {
    runSchtasks: (args) => run("schtasks", args),
    runPowershell: (script) => run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]),
    runShutdown: (args) => run("shutdown", args),
  };
}
