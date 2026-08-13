import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { describeExecFailure, formatExecFailureForLog, formatExitClause } from "../src/exec-failure.ts";

/**
 * `codebase-hardening-plan.md` P1-9. The silent-wrong risk this covers is specific: every field is
 * optional on a value typed `unknown`, so a mistake here doesn't crash - it produces a
 * plausible-looking diagnostic line that quietly omits the one field that would have explained the
 * failure, which is exactly the position the 2026-08-12 `/new` incident left the operator in.
 */
describe("describeExecFailure", () => {
  test("reads message, status and stderr off a real execFileSync failure", () => {
    // Not a hand-built object: the whole point is to match the shape Node actually throws, so this
    // runs a real child process that exits non-zero.
    let thrown: unknown;
    try {
      execFileSync(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(3)"], { stdio: "pipe" });
    } catch (err) {
      thrown = err;
    }

    const failure = describeExecFailure(thrown);
    expect(failure.status).toBe(3);
    expect(failure.stderr).toBe("boom");
    expect(failure.signal).toBeUndefined();
    expect(failure.message).toContain("Command failed");
  });

  test("preserves an empty stderr as an observation rather than dropping the field", () => {
    // The incident's actual signature: non-zero exit, nothing printed. "stderr was empty" and
    // "stderr was never captured" have to stay distinguishable.
    let thrown: unknown;
    try {
      execFileSync(process.execPath, ["-e", "process.exit(4)"], { stdio: "pipe" });
    } catch (err) {
      thrown = err;
    }

    const failure = describeExecFailure(thrown);
    expect(failure.status).toBe(4);
    expect(failure.stderr).toBe("");
    expect(formatExecFailureForLog(failure)).toContain("stderr: (empty)");
  });

  test("keeps a plain Error to just its message - no invented exit status", () => {
    const failure = describeExecFailure(new Error("no worktrees root configured"));
    expect(failure).toEqual({ message: "no worktrees root configured" });
    expect(formatExitClause(failure)).toBe("");
  });

  test("survives a non-Error throw", () => {
    expect(describeExecFailure("just a string")).toEqual({ message: "just a string" });
    expect(describeExecFailure(null)).toEqual({ message: "null" });
    expect(describeExecFailure(undefined)).toEqual({ message: "undefined" });
  });

  test("reports a signal kill as a signal, not as an exit code", () => {
    // Node sets `status: null` and `signal: "SIGKILL"` on a killed child. A truthiness check on
    // `status` would be right here by accident and wrong for `status: 0`, which the next case pins.
    const failure = describeExecFailure(Object.assign(new Error("Command failed: git"), { status: null, signal: "SIGKILL" }));
    expect(failure.status).toBeUndefined();
    expect(failure.signal).toBe("SIGKILL");
    expect(formatExitClause(failure)).toBe(" (killed by SIGKILL)");
  });

  test("keeps a zero exit status rather than treating it as absent", () => {
    const failure = describeExecFailure(Object.assign(new Error("Command failed: git"), { status: 0 }));
    expect(failure.status).toBe(0);
    expect(formatExitClause(failure)).toBe(" (exit 0)");
  });

  test("decodes a Buffer stderr", () => {
    const failure = describeExecFailure(Object.assign(new Error("Command failed"), { status: 1, stderr: Buffer.from("fatal: bad ref\n") }));
    expect(failure.stderr).toBe("fatal: bad ref");
  });

  test("ignores fields of the wrong type instead of reporting garbage", () => {
    const failure = describeExecFailure(Object.assign(new Error("Command failed"), { status: "128", signal: 9, stderr: { nope: true } }));
    expect(failure.status).toBeUndefined();
    expect(failure.signal).toBeUndefined();
    expect(failure.stderr).toBeUndefined();
  });
});

describe("formatExecFailureForLog", () => {
  test("names signal, status and stderr in one line", () => {
    const line = formatExecFailureForLog({ message: "Command failed: git worktree add", status: 128, signal: "SIGTERM", stderr: "fatal: bad ref" });
    expect(line).toBe("Command failed: git worktree add | signal: SIGTERM | status: 128 | stderr: fatal: bad ref");
  });

  test("degrades to just the message when nothing else is known", () => {
    expect(formatExecFailureForLog({ message: "boom" })).toBe("boom");
  });

  test("never emits a newline, so the whole entry survives a grep of bridge.log", () => {
    // Found live 2026-08-12: `logger.ts` prefixes one line per entry, and Node's execFileSync
    // message embeds the child's stderr with a newline - so the first version of this put
    // `status:`/`stderr:` on an unprefixed continuation line, and `grep ERROR bridge.log` showed
    // the header without any of the diagnostics it exists to carry.
    const line = formatExecFailureForLog({
      message: "Command failed: git worktree add C:\\data\\worktrees\\x -b claude/x-1\nfatal: not a git repository\n",
      status: 128,
      stderr: "fatal: not a git repository\n",
    });

    expect(line).not.toContain("\n");
    expect(line).toContain("status: 128");
    expect(line).toContain("fatal: not a git repository");
  });

  test("does not repeat stderr that the message already carries", () => {
    // Node appends a failed child's stderr to `err.message`, so the naive version printed the same
    // sentence twice in one line.
    const line = formatExecFailureForLog({
      message: "Command failed: git worktree add\nfatal: not a git repository",
      status: 128,
      stderr: "fatal: not a git repository",
    });

    expect(line.match(/not a git repository/g)).toHaveLength(1);
  });

  test("still reports an empty stderr even though the message cannot contain it", () => {
    const line = formatExecFailureForLog({ message: "Command failed: git worktree add", status: 128, stderr: "" });
    expect(line).toBe("Command failed: git worktree add | status: 128 | stderr: (empty)");
  });
});

describe("formatExitClause", () => {
  test("prefers the signal when a child was killed rather than exiting", () => {
    expect(formatExitClause({ message: "x", status: 128, signal: "SIGKILL" })).toBe(" (killed by SIGKILL)");
  });
});
