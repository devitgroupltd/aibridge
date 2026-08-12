import { readFileSync } from "node:fs";
import { DEFAULT_PIPE_PATH } from "@aibridge/protocol";
import { askOnce } from "./ask-once.ts";
import { sendOnce } from "./send-once.ts";
import { runHook } from "./run-hook.ts";

// §6.4: 3550s, ten seconds inside the hook's own 3600s configured ceiling and the Bridge's own
// 3540s cancel-and-post - only reached if the Bridge itself never answers at all, so this process
// still exits with a clean `deny` instead of being force-killed by Claude Code with no output.
const DEFAULT_ASK_HARD_TIMEOUT_MS = 3_550_000;

/**
 * Node's stdout is **asynchronous when it's a pipe on Windows** - which is exactly how Claude Code
 * reads a hook's output on the Phase 1-5 host. `process.stdout.write(...)` immediately followed by
 * `process.exit(0)` therefore discards whatever hadn't flushed yet, and `buildAskOutput` echoes the
 * whole `questions` array (including every option's `description`) alongside the answers, so a
 * multi-question ask easily clears the pipe buffer. Claude Code then sees truncated JSON instead of
 * `permissionDecision: "allow"` and falls back to its own terminal picker - the operator's Telegram
 * answer silently lost *after* they answered it, with the card already reading "✅ <label>". Small
 * payloads complete synchronously, which is why this passed live verification: it is size-dependent,
 * not absent.
 */
function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => {
    // Never rejects, and never waits forever. If Claude Code closed the read end (EPIPE) there is
    // nothing left to deliver and nothing useful to say about it; if it stopped draining without
    // closing, the callback never fires - and this module's documented invariant is that it always
    // exits 0 promptly, because a hook that hangs blocks Claude's own turn. Either way: give the
    // flush a bounded window, then move on.
    const done = setTimeout(resolve, 2000);
    done.unref?.();
    process.stdout.write(text, () => {
      clearTimeout(done);
      resolve();
    });
  });
}

// The actual dispatch logic (P1-8, codebase-hardening-plan.md) lives in run-hook.ts, unit-tested
// there against fake `readStdin`/`askOnce`/`sendOnce`/`writeStdout` - `index.ts` itself can't be
// imported by a test at all (this same top-level `await ...; process.exit(0)` would kill the test
// runner's own process), so it's now just wiring plus the one still-inline side effect
// (`writeStdout`) that genuinely needs real `process.stdout`.
await runHook({
  env: process.env,
  argv: process.argv,
  pid: process.pid,
  defaultPipePath: DEFAULT_PIPE_PATH,
  defaultAskHardTimeoutMs: DEFAULT_ASK_HARD_TIMEOUT_MS,
  readStdin: () => readFileSync(0, "utf8"),
  askOnce,
  sendOnce,
  writeStdout,
});
process.exit(0);
