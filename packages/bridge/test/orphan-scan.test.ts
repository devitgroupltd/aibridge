import { describe, expect, test } from "bun:test";
import { findOrphanProcesses } from "../src/orphan-scan.ts";
import type { SessionRow } from "../src/session-store.ts";

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "fix-bug",
    topicId: 2,
    sessionId: "sess-123",
    worktreePath: "c:\\data\\worktrees\\fix-bug",
    branch: "claude/fix-bug-1",
    repoPath: "c:\\data\\projects\\seowrite",
    model: "sonnet",
    ptyPid: 1234,
    state: "idle",
    turnCardMsg: null,
    paused: false,
    renamed: false,
    feedDetail: "compact",
    feedVerbose: false,
    createdUtc: "2026-08-03T00:00:00.000Z",
    lastEventUtc: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("findOrphanProcesses (§9 scenario 24, §4.5's reconciliation table)", () => {
  test("a claude process whose pid matches a row is not an orphan", () => {
    const processes = [{ pid: 1234, commandLine: '"claude.exe" --dangerously-load-development-channels server:aibridge' }];
    expect(findOrphanProcesses(processes, [row()])).toEqual([]);
  });

  test("a claude process whose pid matches only a dead row is still flagged - a dead row's pid isn't re-checked as 'known' forever", () => {
    const processes = [{ pid: 9999, commandLine: '"claude.exe" --dangerously-load-development-channels server:aibridge' }];
    expect(findOrphanProcesses(processes, [row({ ptyPid: 9999, state: "dead" })])).toEqual([
      { pid: 9999, commandLine: '"claude.exe" --dangerously-load-development-channels server:aibridge' },
    ]);
  });

  test("a claude process with no matching row at all is an orphan", () => {
    const processes = [{ pid: 5555, commandLine: '"claude.exe" --dangerously-load-development-channels server:aibridge' }];
    expect(findOrphanProcesses(processes, [row()])).toEqual([{ pid: 5555, commandLine: '"claude.exe" --dangerously-load-development-channels server:aibridge' }]);
  });

  test("a process without the launch flag is never flagged, even unmatched - it isn't ours", () => {
    const processes = [{ pid: 5555, commandLine: '"claude.exe" --version' }];
    expect(findOrphanProcesses(processes, [row()])).toEqual([]);
  });

  test("a plugin-mode orphan (0.54.0's default launch form) is flagged too, not just the dev-flag form", () => {
    const processes = [{ pid: 6666, commandLine: '"claude.exe" --channels plugin:aibridge-telegram@devitgroup-plugins --model sonnet' }];
    expect(findOrphanProcesses(processes, [row()])).toEqual([
      { pid: 6666, commandLine: '"claude.exe" --channels plugin:aibridge-telegram@devitgroup-plugins --model sonnet' },
    ]);
  });

  test("a plugin-mode process whose pid matches a row is not an orphan", () => {
    const processes = [{ pid: 1234, commandLine: '"claude.exe" --channels plugin:aibridge-telegram@devitgroup-plugins --model sonnet' }];
    expect(findOrphanProcesses(processes, [row()])).toEqual([]);
  });
});
