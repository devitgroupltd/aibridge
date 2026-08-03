import { readFileSync } from "node:fs";
import { DEFAULT_PIPE_PATH } from "@aibridge/protocol";
import { askOnce } from "./ask-once.ts";
import { buildAskMessages, buildAskOutput } from "./ask-message.ts";
import { buildHookMessages } from "./build-message.ts";
import { sendOnce } from "./send-once.ts";

// §6.4: 3550s, ten seconds inside the hook's own 3600s configured ceiling and the Bridge's own
// 3540s cancel-and-post - only reached if the Bridge itself never answers at all, so this process
// still exits with a clean `deny` instead of being force-killed by Claude Code with no output.
const DEFAULT_ASK_HARD_TIMEOUT_MS = 3_550_000;

/**
 * §5.1/§9: invoked synchronously by Claude Code once per hook firing, even though every hook in
 * the settings block is declared `async` - the event itself doesn't block the agent loop, but
 * this process's own startup/exit still does, which is why `bun build --compile` (not `bun run`)
 * matters here specifically (§9's "startup latency is load-bearing").  Always exits 0: a non-zero
 * exit (specifically 2) triggers `asyncRewake`, which `§5.1` rejects outright as a prompt-injection
 * surface, so this process never has a reason to signal anything back to Claude Code.
 *
 * The `--ask` flag (checked before any payload inspection) is what distinguishes the synchronous
 * `AskUserQuestion`-matcher hook entry from the async catch-all `PreToolUse` entry - both receive
 * the identical stdin payload when Claude calls `AskUserQuestion`, so the payload itself can't be
 * what decides whether this invocation blocks for an answer (§6.4).
 */
async function main(): Promise<void> {
  const slug = process.env.AIBRIDGE_SLUG;
  if (!slug) return;

  let raw: string;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const pipePath = process.env.AIBRIDGE_PIPE_PATH ?? DEFAULT_PIPE_PATH;

  if (process.argv.includes("--ask")) {
    const messages = buildAskMessages(payload, slug, process.pid);
    if (!messages) return; // malformed - Claude Code falls through to its own terminal picker
    const hardTimeoutMs = Number(process.env.AIBRIDGE_ASK_HARD_TIMEOUT_MS ?? DEFAULT_ASK_HARD_TIMEOUT_MS);
    const resolution = await askOnce(pipePath, messages.hello, messages.ask, hardTimeoutMs);
    process.stdout.write(JSON.stringify(buildAskOutput(messages.ask.questions, resolution)));
    return;
  }

  const messages = buildHookMessages(payload, slug, process.pid);
  if (!messages) return;
  await sendOnce(pipePath, messages);
}

await main();
process.exit(0);
