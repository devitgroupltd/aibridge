import { describe, expect, test } from "bun:test";
import {
  buildCreateArgs,
  buildDeleteArgs,
  buildFixTaskSettingsScript,
  buildQueryArgs,
  buildRunArgs,
  parseQueryOutput,
  renderAutostartStatus,
  TASK_NAME,
} from "../src/autostart.ts";

describe("buildCreateArgs / buildQueryArgs / buildDeleteArgs", () => {
  // 0.100.0: this was `<bunExePath> run <entryScriptPath>` until root-caused live 2026-08-08 -
  // Bun is the confirmed trigger for node-pty's unhandled "Socket is closed" ConPTY write crash
  // (0.21.0), so a logon-triggered Bridge registered this way wedged nearly every session it ever
  // spawned. Must always be the documented runtime instead (packages/bridge/package.json's own
  // `start` script), never Bun.
  test("buildCreateArgs registers a logon-trigger task at limited (non-admin) privilege, running node --experimental-strip-types", () => {
    const args = buildCreateArgs("C:\\node.exe", "C:\\aibridge\\index.ts");
    expect(args).toEqual([
      "/Create",
      "/TN",
      TASK_NAME,
      "/SC",
      "ONLOGON",
      "/TR",
      '"C:\\node.exe" --experimental-strip-types "C:\\aibridge\\index.ts"',
      "/RL",
      "LIMITED",
      "/F",
    ]);
  });

  test("buildQueryArgs and buildDeleteArgs target the same task name", () => {
    expect(buildQueryArgs()).toEqual(["/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"]);
    expect(buildDeleteArgs()).toEqual(["/Delete", "/TN", TASK_NAME, "/F"]);
  });
});

describe("parseQueryOutput", () => {
  // A real `schtasks /Query /TN <name> /FO LIST /V` sample shape.
  const REGISTERED_SAMPLE = [
    "Folder: \\",
    "HostName:                             DESKTOP-XYZ",
    `TaskName:                             \\${TASK_NAME}`,
    "Next Run Time:                        N/A",
    "Status:                               Ready",
    "Logon Mode:                           Interactive/Background",
    "Last Run Time:                        8/4/2026 3:00:00 PM",
    "Last Result:                          0",
    "Author:                               DESKTOP-XYZ\\oleg",
    'Task To Run:                          "C:\\bun.exe" run "C:\\aibridge\\index.ts"',
    "Scheduled Task State:                 Enabled",
  ].join("\r\n");

  test("parses status/last-run/last-result from a registered task", () => {
    expect(parseQueryOutput(REGISTERED_SAMPLE, "")).toEqual({
      registered: true,
      status: "Ready",
      lastRunTime: "8/4/2026 3:00:00 PM",
      lastResult: "0",
    });
  });

  test("an ERROR line on stdout or stderr means not registered, not a parse attempt", () => {
    expect(parseQueryOutput("ERROR: The system cannot find the file specified.", "")).toEqual({ registered: false });
    expect(parseQueryOutput("", "ERROR: The system cannot find the file specified.")).toEqual({ registered: false });
  });

  test("empty stdout means not registered", () => {
    expect(parseQueryOutput("", "")).toEqual({ registered: false });
  });
});

describe("buildFixTaskSettingsScript", () => {
  // §7.2 point 2's 3-day default: schtasks /Create has no flag for it, so /autostart install has to
  // follow up with this PowerShell one-liner. Live-verified 2026-08-06 that a freshly-created task
  // really does default to "Stop Task If Runs X Hours and X Mins: 72:00:00" on this host.
  test("targets the named task and writes back ExecutionTimeLimit", () => {
    const script = buildFixTaskSettingsScript(TASK_NAME);
    expect(script).toContain(`Get-ScheduledTask -TaskName '${TASK_NAME}'`);
    expect(script).toContain("$t.Settings.ExecutionTimeLimit = 'PT0S'");
    expect(script).toContain("Set-ScheduledTask -InputObject $t");
  });

  // Live-verified 2026-08-06: the default `IgnoreNew` policy silently drops buildRunArgs's /restart
  // re-trigger while the old instance is still marked "Running", leaving nothing running at all.
  test("also writes back MultipleInstances so a /restart re-trigger isn't ignored", () => {
    expect(buildFixTaskSettingsScript(TASK_NAME)).toContain("$t.Settings.MultipleInstances = 'Parallel'");
  });

  // Live-verified 2026-09-02 that a task created by buildCreateArgs really does come back with
  // RestartCount 0 and an empty RestartInterval, i.e. no restart policy: two VM boots onto a broken
  // network produced two crashed Bridges and no further attempt at all. Both properties have to be
  // written or Task Scheduler ignores the pair, and PT1M is its documented minimum interval.
  test("also writes back a restart-on-failure policy, both halves of it", () => {
    const script = buildFixTaskSettingsScript(TASK_NAME);
    expect(script).toContain("$t.Settings.RestartCount = 3");
    expect(script).toContain("$t.Settings.RestartInterval = 'PT1M'");
  });

  // Not a stylistic preference: a network condition on the task is documented-broken since Windows
  // 10 1607 (it can stop the task triggering at all), and the boot-time network wait lives in
  // `awaitTokenValidation` instead. Asserted so a future "obvious fix" has to read the doc comment.
  test("never sets a network condition on the task", () => {
    expect(buildFixTaskSettingsScript(TASK_NAME)).not.toContain("RunOnlyIfNetworkAvailable");
  });

  test("defaults to the real task name when called with no argument", () => {
    expect(buildFixTaskSettingsScript()).toContain(`'${TASK_NAME}'`);
  });
});

describe("renderAutostartStatus", () => {
  test("unregistered points at /autostart install", () => {
    expect(renderAutostartStatus({ registered: false })).toContain("/autostart install");
  });

  test("registered shows status/last-run/last-result", () => {
    const text = renderAutostartStatus({ registered: true, status: "Ready", lastRunTime: "8/4/2026 3:00:00 PM", lastResult: "0" });
    expect(text).toContain(`"${TASK_NAME}"`);
    expect(text).toContain("Status: Ready");
    expect(text).toContain("Last run: 8/4/2026 3:00:00 PM");
    expect(text).toContain("Last result: 0");
  });
});

describe("buildRunArgs", () => {
  // `/restart` re-triggers the registered task via this instead of a raw detached spawn - see the
  // function's own doc comment for why a plain spawn dies with its Task-Scheduler-tracked parent.
  test("targets the same task name for an immediate on-demand run", () => {
    expect(buildRunArgs()).toEqual(["/Run", "/TN", TASK_NAME]);
  });
});
