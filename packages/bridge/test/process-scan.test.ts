import { describe, expect, test } from "bun:test";
import { parseProcessList } from "../src/process-scan.ts";

/**
 * §9's silent-wrong bar. `ConvertTo-Json` emits a *bare object* rather than an array when exactly one
 * process matches - the single most common real case for a fleet running one session - and the pids
 * this produces are shown to an operator in an orphan-process report that they may act on by killing
 * something. A wrong or fabricated pid there is the worst possible outcome, and none of it crashes.
 *
 * Extracted from `listClaudeProcesses` for exactly this reason: the surrounding function shells out to
 * PowerShell, so the parsing was previously untestable.
 */
describe("parseProcessList", () => {
  test("parses the array form (two or more matching processes)", () => {
    const stdout = JSON.stringify([
      { ProcessId: 1234, CommandLine: "claude.exe --resume abc" },
      { ProcessId: 5678, CommandLine: "claude.exe" },
    ]);
    expect(parseProcessList(stdout)).toEqual([
      { pid: 1234, commandLine: "claude.exe --resume abc" },
      { pid: 5678, commandLine: "claude.exe" },
    ]);
  });

  test("parses the bare-object form PowerShell emits for exactly one match", () => {
    const stdout = JSON.stringify({ ProcessId: 4242, CommandLine: "claude.exe --resume xyz" });
    expect(parseProcessList(stdout)).toEqual([{ pid: 4242, commandLine: "claude.exe --resume xyz" }]);
  });

  test("a process with no CommandLine (access denied) still yields its pid, with an empty command", () => {
    expect(parseProcessList(JSON.stringify({ ProcessId: 99, CommandLine: null }))).toEqual([{ pid: 99, commandLine: "" }]);
    expect(parseProcessList(JSON.stringify({ ProcessId: 99 }))).toEqual([{ pid: 99, commandLine: "" }]);
  });

  test("drops any entry without a numeric pid rather than inventing one", () => {
    // The dangerous direction: an entry whose pid is a string or missing must not become a `NaN`/
    // `undefined` pid in an orphan report the operator might act on.
    const stdout = JSON.stringify([{ ProcessId: "1234" }, { CommandLine: "claude.exe" }, { ProcessId: 7 }]);
    expect(parseProcessList(stdout)).toEqual([{ pid: 7, commandLine: "" }]);
  });

  test("non-JSON, empty and null output all yield no entries rather than throwing", () => {
    // Orphan detection finding nothing is the safe direction to fail in - it never drives an
    // automatic kill (see orphan-scan.ts).
    expect(parseProcessList("")).toEqual([]);
    expect(parseProcessList("not json at all")).toEqual([]);
    expect(parseProcessList("null")).toEqual([]);
    expect(parseProcessList("[]")).toEqual([]);
  });

  test("a JSON scalar (not an object) yields no entries", () => {
    expect(parseProcessList("42")).toEqual([]);
    expect(parseProcessList('"a string"')).toEqual([]);
  });
});
