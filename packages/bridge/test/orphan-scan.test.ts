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

  test("a plugin-mode orphan (0.55.0's only launch form) is flagged too, not just the dev-flag form", () => {
    const processes = [{ pid: 6666, commandLine: '"claude.exe" --channels plugin:aibridge-telegram@devitgroup-plugins --model sonnet' }];
    expect(findOrphanProcesses(processes, [row()])).toEqual([
      { pid: 6666, commandLine: '"claude.exe" --channels plugin:aibridge-telegram@devitgroup-plugins --model sonnet' },
    ]);
  });

  test("a plugin-mode process whose pid matches a row is not an orphan", () => {
    const processes = [{ pid: 1234, commandLine: '"claude.exe" --channels plugin:aibridge-telegram@devitgroup-plugins --model sonnet' }];
    expect(findOrphanProcesses(processes, [row()])).toEqual([]);
  });

  // 0.99.0: this was the self-check ("test-session") row's actual live bug, root-caused
  // 2026-08-08. Its row's ptyPid was never kept in sync with its own relaunch (unlike a fleet
  // session's `resumeSession`, which calls `setPtyPid` every time), so it stayed stuck at 0 - and
  // matching is by *exact pid*, so a legitimate session with a stale ptyPid flags its own perfectly
  // healthy process as an orphan indistinguishable from a real leak. This function's own matching
  // logic was never wrong; the bug was upstream (index.ts never calling `setPtyPid` on that path) -
  // these two cases document the mechanism, i.e. what the fix actually depends on.
  test("a row whose ptyPid was never kept in sync with its own relaunch still self-flags as an orphan", () => {
    const processes = [{ pid: 6304, commandLine: '"claude.exe" --channels plugin:aibridge-telegram@devitgroup-plugins --model sonnet' }];
    expect(findOrphanProcesses(processes, [row({ slug: "test-session", ptyPid: 0 })])).toEqual([
      { pid: 6304, commandLine: '"claude.exe" --channels plugin:aibridge-telegram@devitgroup-plugins --model sonnet' },
    ]);
  });

  test("once ptyPid is kept in sync with the relaunch (the actual fix), the same session is no longer flagged", () => {
    const processes = [{ pid: 6304, commandLine: '"claude.exe" --channels plugin:aibridge-telegram@devitgroup-plugins --model sonnet' }];
    expect(findOrphanProcesses(processes, [row({ slug: "test-session", ptyPid: 6304 })])).toEqual([]);
  });
});
