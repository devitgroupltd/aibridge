import type { HelloFromHook, HookAskMessage } from "@aibridge/protocol";
import type { HookMessages } from "./build-message.ts";
import { buildAskMessages, buildAskOutput } from "./ask-message.ts";
import { buildHookMessages } from "./build-message.ts";
import type { AskResolution } from "./ask-once.ts";

/**
 * P1-8 (codebase-hardening-plan.md): extracted from `index.ts` so this hook's dispatch logic is
 * unit-testable at all - `index.ts` itself is a top-level entry-point script (`await main();
 * process.exit(0);` at module scope), so importing it in a test process would call `process.exit`
 * on the test runner itself. Behavior-identical to what `index.ts` used to do inline; only the
 * construction is different (`readStdin`/`askOnce`/`sendOnce`/`writeStdout`/`env`/`argv` injected
 * here instead of read from real `process.*`/imported directly).
 */

export interface RunHookOptions {
  env: { AIBRIDGE_SLUG?: string; AIBRIDGE_PIPE_PATH?: string; AIBRIDGE_ASK_HARD_TIMEOUT_MS?: string; [key: string]: string | undefined };
  argv: string[];
  pid: number;
  defaultPipePath: string;
  defaultAskHardTimeoutMs: number;
  /** Wraps `readFileSync(0, "utf8")` - throws exactly like that does when stdin isn't readable. */
  readStdin: () => string;
  askOnce: (pipePath: string, hello: HelloFromHook, ask: HookAskMessage, hardTimeoutMs: number) => Promise<AskResolution>;
  sendOnce: (pipePath: string, messages: HookMessages) => Promise<void>;
  writeStdout: (text: string) => Promise<void>;
}

/**
 * §5.1/§9: invoked synchronously by Claude Code once per hook firing, even though every hook in
 * the settings block is declared `async` - the event itself doesn't block the agent loop, but
 * this process's own startup/exit still does, which is why `bun build --compile` (not `bun run`)
 * matters here specifically (§9's "startup latency is load-bearing"). Always exits 0 (`index.ts`'s
 * job, not this function's): a non-zero exit (specifically 2) triggers `asyncRewake`, which §5.1
 * rejects outright as a prompt-injection surface, so this process never has a reason to signal
 * anything back to Claude Code.
 *
 * The `--ask` flag (checked before any payload inspection) is what distinguishes the synchronous
 * `AskUserQuestion`-matcher hook entry from the async catch-all `PreToolUse` entry - both receive
 * the identical stdin payload when Claude calls `AskUserQuestion`, so the payload itself can't be
 * what decides whether this invocation blocks for an answer (§6.4).
 */
export async function runHook(opts: RunHookOptions): Promise<void> {
  const slug = opts.env.AIBRIDGE_SLUG;
  if (!slug) return;

  let raw: string;
  try {
    raw = opts.readStdin();
  } catch {
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const pipePath = opts.env.AIBRIDGE_PIPE_PATH ?? opts.defaultPipePath;

  if (opts.argv.includes("--ask")) {
    const messages = buildAskMessages(payload, slug, opts.pid);
    if (!messages) return; // malformed - Claude Code falls through to its own terminal picker
    const hardTimeoutMs = Number(opts.env.AIBRIDGE_ASK_HARD_TIMEOUT_MS ?? opts.defaultAskHardTimeoutMs);
    const resolution = await opts.askOnce(pipePath, messages.hello, messages.ask, hardTimeoutMs);
    await opts.writeStdout(JSON.stringify(buildAskOutput(messages.ask.questions, resolution)));
    return;
  }

  const messages = buildHookMessages(payload, slug, opts.pid);
  if (!messages) return;
  await opts.sendOnce(pipePath, messages);
}
