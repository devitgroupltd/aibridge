import { readFileSync } from "node:fs";
import { DEFAULT_PIPE_PATH } from "@aibridge/protocol";
import { buildHookMessages } from "./build-message.ts";
import { sendOnce } from "./send-once.ts";

/**
 * §5.1/§9: invoked synchronously by Claude Code once per hook firing, even though every hook in
 * the settings block is declared `async` - the event itself doesn't block the agent loop, but
 * this process's own startup/exit still does, which is why `bun build --compile` (not `bun run`)
 * matters here specifically (§9's "startup latency is load-bearing").  Always exits 0: a non-zero
 * exit (specifically 2) triggers `asyncRewake`, which `§5.1` rejects outright as a prompt-injection
 * surface, so this process never has a reason to signal anything back to Claude Code.
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

  const messages = buildHookMessages(payload, slug, process.pid);
  if (!messages) return;

  const pipePath = process.env.AIBRIDGE_PIPE_PATH ?? DEFAULT_PIPE_PATH;
  await sendOnce(pipePath, messages);
}

await main();
process.exit(0);
