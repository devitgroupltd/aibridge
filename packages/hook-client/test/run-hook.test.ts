import { describe, expect, test } from "bun:test";
import type { HelloFromHook, HookAskMessage } from "@aibridge/protocol";
import { runHook, type RunHookOptions } from "../src/run-hook.ts";
import type { HookMessages } from "../src/build-message.ts";
import type { AskResolution } from "../src/ask-once.ts";

/** P1-8 (codebase-hardening-plan.md): `index.ts` itself can't be imported by a test at all - its
 * top-level `await main(); process.exit(0)` would kill the test runner's own process. `run-hook.ts`
 * was extracted specifically to make this testable without changing behavior: these tests exercise
 * the exact same dispatch logic `index.ts` used to run inline, against fake stdin/askOnce/sendOnce/
 * writeStdout - never touching a real pipe, real stdout, or real process.exit. */

function setup(overrides: Partial<RunHookOptions> = {}, askResolution: AskResolution = { kind: "timeout" }) {
  const sendOnceCalls: Array<{ pipePath: string; messages: HookMessages }> = [];
  const askOnceCalls: Array<{ pipePath: string; hello: HelloFromHook; ask: HookAskMessage; hardTimeoutMs: number }> = [];
  const stdoutWrites: string[] = [];
  const opts: RunHookOptions = {
    env: { AIBRIDGE_SLUG: "fix-bug" },
    argv: ["node", "index.ts"],
    pid: 4242,
    defaultPipePath: "\\\\.\\pipe\\aibridge-default",
    defaultAskHardTimeoutMs: 3_550_000,
    readStdin: () => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "sess-1", tool_name: "Write" }),
    sendOnce: async (pipePath, messages) => {
      sendOnceCalls.push({ pipePath, messages });
    },
    askOnce: async (pipePath, hello, ask, hardTimeoutMs) => {
      askOnceCalls.push({ pipePath, hello, ask, hardTimeoutMs });
      return askResolution;
    },
    writeStdout: async (text) => {
      stdoutWrites.push(text);
    },
    ...overrides,
  };
  return { opts, sendOnceCalls, askOnceCalls, stdoutWrites };
}

const ASK_PAYLOAD = {
  hook_event_name: "PreToolUse",
  session_id: "sess-1",
  tool_use_id: "tu-1",
  tool_name: "AskUserQuestion",
  tool_input: { questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }] },
};

describe("runHook", () => {
  test("with no AIBRIDGE_SLUG set, returns immediately without reading stdin", async () => {
    let readCalled = false;
    const { opts, sendOnceCalls } = setup({
      env: {},
      readStdin: () => {
        readCalled = true;
        return "{}";
      },
    });
    await runHook(opts);
    expect(readCalled).toBe(false);
    expect(sendOnceCalls).toEqual([]);
  });

  test("when readStdin throws (fd 0 not readable), returns cleanly instead of propagating", async () => {
    const { opts, sendOnceCalls } = setup({
      readStdin: () => {
        throw new Error("EBADF");
      },
    });
    await expect(runHook(opts)).resolves.toBeUndefined();
    expect(sendOnceCalls).toEqual([]);
  });

  test("malformed JSON on stdin returns cleanly instead of throwing", async () => {
    const { opts, sendOnceCalls } = setup({ readStdin: () => "not json{" });
    await expect(runHook(opts)).resolves.toBeUndefined();
    expect(sendOnceCalls).toEqual([]);
  });

  describe("the plain (non---ask) path", () => {
    test("a well-formed payload is forwarded via sendOnce with the default pipe path", async () => {
      const { opts, sendOnceCalls } = setup();
      await runHook(opts);
      expect(sendOnceCalls.length).toBe(1);
      expect(sendOnceCalls[0]?.pipePath).toBe("\\\\.\\pipe\\aibridge-default");
      expect(sendOnceCalls[0]?.messages.event.hook_event_name).toBe("PreToolUse");
      expect(sendOnceCalls[0]?.messages.event.session_id).toBe("sess-1");
    });

    test("AIBRIDGE_PIPE_PATH overrides the default pipe path", async () => {
      const { opts, sendOnceCalls } = setup({ env: { AIBRIDGE_SLUG: "fix-bug", AIBRIDGE_PIPE_PATH: "\\\\.\\pipe\\aibridge-custom" } });
      await runHook(opts);
      expect(sendOnceCalls[0]?.pipePath).toBe("\\\\.\\pipe\\aibridge-custom");
    });

    test("a payload buildHookMessages rejects (malformed shape) is not forwarded", async () => {
      const { opts, sendOnceCalls } = setup({ readStdin: () => JSON.stringify({ not: "a hook payload" }) });
      await runHook(opts);
      expect(sendOnceCalls).toEqual([]);
    });

    test("does not call askOnce or writeStdout on the plain path", async () => {
      const { opts, askOnceCalls, stdoutWrites } = setup();
      await runHook(opts);
      expect(askOnceCalls).toEqual([]);
      expect(stdoutWrites).toEqual([]);
    });
  });

  describe("the --ask path", () => {
    test("blocks on askOnce and writes its resolution to stdout, never calling sendOnce", async () => {
      const { opts, sendOnceCalls, askOnceCalls, stdoutWrites } = setup(
        { argv: ["node", "index.ts", "--ask"], readStdin: () => JSON.stringify(ASK_PAYLOAD) },
        { kind: "answered", answers: { "Continue?": "Yes" } },
      );
      await runHook(opts);
      expect(askOnceCalls.length).toBe(1);
      expect(sendOnceCalls).toEqual([]);
      expect(stdoutWrites.length).toBe(1);
      const output = JSON.parse(stdoutWrites[0]!);
      expect(output.hookSpecificOutput.updatedInput.answers).toEqual({ "Continue?": "Yes" });
    });

    test("uses the default hard timeout when AIBRIDGE_ASK_HARD_TIMEOUT_MS is unset", async () => {
      const { opts, askOnceCalls } = setup({
        argv: ["node", "index.ts", "--ask"],
        readStdin: () => JSON.stringify(ASK_PAYLOAD),
      });
      await runHook(opts);
      expect(askOnceCalls[0]?.hardTimeoutMs).toBe(3_550_000);
    });

    test("AIBRIDGE_ASK_HARD_TIMEOUT_MS overrides the default", async () => {
      const { opts, askOnceCalls } = setup({
        env: { AIBRIDGE_SLUG: "fix-bug", AIBRIDGE_ASK_HARD_TIMEOUT_MS: "5000" },
        argv: ["node", "index.ts", "--ask"],
        readStdin: () => JSON.stringify(ASK_PAYLOAD),
      });
      await runHook(opts);
      expect(askOnceCalls[0]?.hardTimeoutMs).toBe(5000);
    });

    test("a malformed --ask payload returns without calling askOnce or writeStdout - Claude Code falls through to its own picker", async () => {
      const { opts, askOnceCalls, stdoutWrites } = setup({
        argv: ["node", "index.ts", "--ask"],
        readStdin: () => JSON.stringify({ not: "an ask payload" }),
      });
      await runHook(opts);
      expect(askOnceCalls).toEqual([]);
      expect(stdoutWrites).toEqual([]);
    });

    test("a timeout resolution is still written to stdout, not silently dropped", async () => {
      const { opts, stdoutWrites } = setup(
        { argv: ["node", "index.ts", "--ask"], readStdin: () => JSON.stringify(ASK_PAYLOAD) },
        { kind: "timeout" },
      );
      await runHook(opts);
      expect(stdoutWrites.length).toBe(1);
      const output = JSON.parse(stdoutWrites[0]!);
      expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    });
  });
});
