import type { SessionState } from "./session-store.ts";

/**
 * §4.3's state table, the subset actually driven by hook events (not by the permission/ask relay,
 * which drives `awaiting_input` <-> `working` from `pipe-server.ts`/`index.ts` directly - see the
 * plan's honest note that this pass wires the hook-driven half of the table, not that half yet).
 * Returns null for a hook that isn't a state trigger at all (`PreToolUse`, `PostToolUse`, etc.) -
 * the caller still has to check `isValidTransition` before applying, since a stale/duplicate event
 * (e.g. two `Stop`s in a row) must be a silent no-op, not a thrown error.
 */
export function stateForHookEvent(hookEventName: string): SessionState | null {
  switch (hookEventName) {
    case "SessionStart":
      return "idle";
    case "UserPromptSubmit":
      return "working";
    case "Stop":
    case "StopFailure":
      return "idle";
    case "SessionEnd":
      return "dead";
    default:
      return null;
  }
}
