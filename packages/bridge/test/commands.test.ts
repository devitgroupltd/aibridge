import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCmdShimText,
  buildCommandKeyboard,
  buildSkillShimText,
  filterNames,
  isBuiltinPassthroughCommand,
  listRepoCommands,
  listRepoSkills,
  MAX_LISTED_NAMES,
  parseCmdInvocation,
  parseSkillInvocation,
  renderCommandsListText,
  renderSkillsListText,
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

describe("listRepoSkills", () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = mkdtempSync(path.join(os.tmpdir(), "aibridge-skills-worktree-"));
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  test("returns an empty list when .claude/skills does not exist", () => {
    expect(listRepoSkills(worktreePath)).toEqual([]);
  });

  test("lists only subdirectories that contain a SKILL.md, sorted, without descending further", () => {
    const skillsDir = path.join(worktreePath, ".claude", "skills");
    mkdirSync(path.join(skillsDir, "plan-craft"), { recursive: true });
    writeFileSync(path.join(skillsDir, "plan-craft", "SKILL.md"), "---\nname: plan-craft\n---\n");
    writeFileSync(path.join(skillsDir, "plan-craft", "checklist.md"), "not a skill entrypoint\n");
    mkdirSync(path.join(skillsDir, "empty-dir"), { recursive: true });

    expect(listRepoSkills(worktreePath)).toEqual(["plan-craft"]);
  });
});

describe("buildCommandKeyboard", () => {
  test("built-ins plus one Commands button and one Skills button - never one button per item", () => {
    const keyboard = buildCommandKeyboard(["deep-check", "review/pre-push"], ["plan-craft"]);
    expect(keyboard).toEqual([
      [{ text: "/compact", callback_data: "run:builtin:compact" }],
      [{ text: "/clear", callback_data: "run:builtin:clear" }],
      [{ text: "Commands (2)", callback_data: "run:showcommands" }],
      [{ text: "Skills (1)", callback_data: "run:showskills" }],
    ]);
  });

  test("omits a category button entirely when that category is empty", () => {
    expect(buildCommandKeyboard([])).toEqual([
      [{ text: "/compact", callback_data: "run:builtin:compact" }],
      [{ text: "/clear", callback_data: "run:builtin:clear" }],
    ]);
  });

  test("stays exactly 4 rows at seowrite scale (43 commands, 66 skills) - counts, not per-item buttons", () => {
    const commands = Array.from({ length: 43 }, (_, i) => `cmd-${i}`);
    const skills = Array.from({ length: 66 }, (_, i) => `skill-${i}`);
    const keyboard = buildCommandKeyboard(commands, skills);
    expect(keyboard).toEqual([
      [{ text: "/compact", callback_data: "run:builtin:compact" }],
      [{ text: "/clear", callback_data: "run:builtin:clear" }],
      [{ text: "Commands (43)", callback_data: "run:showcommands" }],
      [{ text: "Skills (66)", callback_data: "run:showskills" }],
    ]);
  });
});

describe("resolveCommandAction", () => {
  test("resolves a valid builtin callback", () => {
    expect(resolveCommandAction("run:builtin:compact")).toEqual({ kind: "builtin", name: "compact" });
  });

  test("resolves run:showcommands and run:showskills - static actions, nothing to validate", () => {
    expect(resolveCommandAction("run:showcommands")).toEqual({ kind: "show_commands" });
    expect(resolveCommandAction("run:showskills")).toEqual({ kind: "show_skills" });
  });

  test("rejects a builtin name that isn't in the known set (tampered callback_data)", () => {
    expect(resolveCommandAction("run:builtin:exit")).toBeNull();
  });

  test("rejects anything not matching the known callback_data shapes", () => {
    expect(resolveCommandAction("garbage")).toBeNull();
  });
});

describe("parseCmdInvocation", () => {
  test("accepts /cmd <name> [args]", () => {
    expect(parseCmdInvocation("/cmd deep-check")).toEqual({ name: "deep-check", args: "" });
    expect(parseCmdInvocation("/cmd review/pre-push --staged")).toEqual({ name: "review/pre-push", args: "--staged" });
  });

  test("accepts /commands <name> [args] as a synonym", () => {
    expect(parseCmdInvocation("/commands deep-check")).toEqual({ name: "deep-check", args: "" });
  });

  test("returns null for anything else, including a bare /commands with no name", () => {
    expect(parseCmdInvocation("/commands")).toBeNull();
    expect(parseCmdInvocation("/cmd")).toBeNull();
    expect(parseCmdInvocation("hello")).toBeNull();
  });
});

describe("parseSkillInvocation", () => {
  test("extracts name and args from any /word - unvalidated syntax only", () => {
    expect(parseSkillInvocation("/plan-craft")).toEqual({ name: "plan-craft", args: "" });
    expect(parseSkillInvocation("/plan-craft billing --manual")).toEqual({ name: "plan-craft", args: "billing --manual" });
  });

  test("returns null for non-slash text", () => {
    expect(parseSkillInvocation("hello")).toBeNull();
  });
});

describe("filterNames", () => {
  test("case-insensitive substring match", () => {
    expect(filterNames(["deep-check", "review/pre-push", "PLAN-CRAFT"], "plan")).toEqual(["PLAN-CRAFT"]);
  });

  test("empty term returns the list unchanged, not an empty match", () => {
    const names = ["a", "b"];
    expect(filterNames(names, "")).toBe(names);
    expect(filterNames(names, "   ")).toBe(names);
  });

  test("no matches returns an empty array", () => {
    expect(filterNames(["deep-check"], "nonexistent")).toEqual([]);
  });
});

describe("renderCommandsListText", () => {
  test("lists everything, unfiltered, with a header count", () => {
    expect(renderCommandsListText(["deep-check", "review/pre-push"])).toBe("Repo commands (2):\n/cmd deep-check, /cmd review/pre-push");
  });

  test("filters by term and reflects the match count in the header", () => {
    expect(renderCommandsListText(["deep-check", "review/pre-push"], "deep")).toBe("Commands matching \"deep\" (1):\n/cmd deep-check");
  });

  test("says so when nothing is defined", () => {
    expect(renderCommandsListText([])).toBe("No repo commands in this project.");
  });

  test("says so when a term matches nothing", () => {
    expect(renderCommandsListText(["deep-check"], "nonexistent")).toBe('No repo commands matched "nonexistent".');
  });

  test("falls back to a residual count past the name-list cap - a pathological project, not seowrite's real 43", () => {
    const commands = Array.from({ length: MAX_LISTED_NAMES + 5 }, (_, i) => `cmd-${i}`);
    const text = renderCommandsListText(commands);
    expect(text).toContain("(+5 more - narrow with /commands <term>)");
  });
});

describe("renderSkillsListText", () => {
  test("lists everything, unfiltered, with a header count", () => {
    expect(renderSkillsListText(["plan-craft", "code-review"])).toBe("Skills (2):\n/plan-craft, /code-review");
  });

  test("filters by term", () => {
    expect(renderSkillsListText(["plan-craft", "code-review"], "plan")).toBe('Skills matching "plan" (1):\n/plan-craft');
  });

  test("says so when nothing is defined", () => {
    expect(renderSkillsListText([])).toBe("No skills in this project.");
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

describe("buildSkillShimText", () => {
  test("names the skill directory and passes arguments through verbatim", () => {
    expect(buildSkillShimText("plan-craft", "billing --manual")).toBe(
      "Invoke the `plan-craft` skill (see `.claude/skills/plan-craft/SKILL.md`) with arguments: billing --manual",
    );
  });

  test("renders (none) when no arguments were given", () => {
    expect(buildSkillShimText("plan-craft", "")).toBe(
      "Invoke the `plan-craft` skill (see `.claude/skills/plan-craft/SKILL.md`) with arguments: (none)",
    );
  });
});
