import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCmdShimText,
  buildCommandKeyboard,
  isBuiltinPassthroughCommand,
  listRepoCommands,
  resolveCommandAction,
} from "../src/commands.ts";

describe("isBuiltinPassthroughCommand", () => {
  test("recognizes known CLI-native commands", () => {
    expect(isBuiltinPassthroughCommand("compact")).toBe(true);
    expect(isBuiltinPassthroughCommand("clear")).toBe(true);
  });

  test("rejects anything else, including a leading slash", () => {
    expect(isBuiltinPassthroughCommand("/compact")).toBe(false);
    expect(isBuiltinPassthroughCommand("exit")).toBe(false);
    expect(isBuiltinPassthroughCommand("")).toBe(false);
  });
});

describe("listRepoCommands", () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = mkdtempSync(path.join(os.tmpdir(), "aibridge-commands-worktree-"));
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  test("returns an empty list when .claude/commands does not exist", () => {
    expect(listRepoCommands(worktreePath)).toEqual([]);
  });

  test("lists top-level and nested command files without the .md extension, sorted", () => {
    const commandsDir = path.join(worktreePath, ".claude", "commands");
    mkdirSync(path.join(commandsDir, "review"), { recursive: true });
    writeFileSync(path.join(commandsDir, "deep-check.md"), "# deep check\n");
    writeFileSync(path.join(commandsDir, "review", "pre-push.md"), "# pre push\n");
    writeFileSync(path.join(commandsDir, "notes.txt"), "not a command\n");

    expect(listRepoCommands(worktreePath)).toEqual(["deep-check", "review/pre-push"]);
  });
});

describe("buildCommandKeyboard", () => {
  test("lists built-ins first, then repo commands, one button per row", () => {
    const keyboard = buildCommandKeyboard(["deep-check", "review/pre-push"]);
    expect(keyboard).toEqual([
      [{ text: "/compact", callback_data: "run:builtin:compact" }],
      [{ text: "/clear", callback_data: "run:builtin:clear" }],
      [{ text: "/cmd deep-check", callback_data: "run:cmd:deep-check" }],
      [{ text: "/cmd review/pre-push", callback_data: "run:cmd:review/pre-push" }],
    ]);
  });
});

describe("resolveCommandAction", () => {
  const repoCommands = ["deep-check"];

  test("resolves a valid builtin callback", () => {
    expect(resolveCommandAction("run:builtin:compact", repoCommands)).toEqual({
      kind: "builtin",
      name: "compact",
    });
  });

  test("resolves a valid repo-command callback", () => {
    expect(resolveCommandAction("run:cmd:deep-check", repoCommands)).toEqual({
      kind: "cmd",
      name: "deep-check",
    });
  });

  test("rejects a builtin name that isn't in the known set (tampered callback_data)", () => {
    expect(resolveCommandAction("run:builtin:exit", repoCommands)).toBeNull();
  });

  test("rejects a repo command that no longer exists in this worktree", () => {
    expect(resolveCommandAction("run:cmd:deleted-command", repoCommands)).toBeNull();
  });

  test("rejects anything not matching the known callback_data shapes", () => {
    expect(resolveCommandAction("garbage", repoCommands)).toBeNull();
  });
});

describe("buildCmdShimText", () => {
  test("names the command file and passes arguments through verbatim", () => {
    expect(buildCmdShimText("review/pre-push", "--staged")).toBe(
      "Read `.claude/commands/review/pre-push.md` and carry out the workflow it defines, with arguments: --staged",
    );
  });

  test("renders (none) when no arguments were given", () => {
    expect(buildCmdShimText("deep-check", "")).toBe(
      "Read `.claude/commands/deep-check.md` and carry out the workflow it defines, with arguments: (none)",
    );
  });
});
