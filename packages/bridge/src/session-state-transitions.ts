import type { SessionState } from "./session-store.ts";

/**
 * §4.3's state table, the subset actually driven by hook events (not by the permission/ask relay,
 * which drives `awaiting_input` <-> `working` from `pipe-server.ts`/`index.ts` directly - see the
 * plan's honest note that this pass wires the hook-driven half of the table, not that half yet).
 * Returns null for a hook that isn't a state trigger at all (`PreToolUse`, `PostToolUse`, etc.) -
 * the caller still has to check `isValidTransition` before applying, since a stale/duplicate event
 * (e.g. two `Stop`s in a row) must be a silent no-op, not a thrown error.
 */
export function stateForHookEvent(hookEventName: string, reason?: string): SessionState | null {
  switch (hookEventName) {
    case "SessionStart":
      return "idle";
    case "UserPromptSubmit":
      return "working";
    case "Stop":
    case "StopFailure":
      return "idle";
    case "SessionEnd":
      // Not every `SessionEnd` ends the *process*. `/clear` (an advertised passthrough command -
      // `commands.ts`, and NL-routable) fires `SessionEnd` with `reason: "clear"` and then a fresh
      // `SessionStart` for the new conversation, on the same live `claude`. Marking the row `dead`
      // there is unrecoverable: `dead` is terminal in `session-store.ts`, so the follow-up
      // `SessionStart -> idle` is dropped silently, and from then on a fully working session shows
      // as dead in `/ls`, stops counting toward the concurrency budget, is refused a resume if it
      // later crashes, gets its live pid reported as an orphan, and is killed by `/rm --dead`.
      return isNonTerminalSessionEnd(reason) ? null : "dead";
    default:
      return null;
  }
}

/** `SessionEnd` reasons that restart the conversation rather than end the session. Unknown reasons
 * fall through to `dead`, which is the safe direction: an over-eager `dead` on a real exit is
 * self-correcting via reconciliation, whereas missing a real exit leaves a phantom live row. */
function isNonTerminalSessionEnd(reason: string | undefined): boolean {
  return reason === "clear" || reason === "compact";
}
