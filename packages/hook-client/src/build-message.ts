import { PROTOCOL_VERSION } from "@aibridge/protocol";
import type { HelloFromHook, HookEventMessage } from "@aibridge/protocol";

export interface HookMessages {
  hello: HelloFromHook;
  event: HookEventMessage;
}

/**
 * Every hook firing is a fresh process (§5.1) - there is no persistent connection to register, so
 * `hello` and `event` are sent together over one short-lived connection rather than the
 * channel server's hello-then-many-messages pattern. Returns null for anything that doesn't even
 * look like a hook payload (Stage 0's live capture confirmed `hook_event_name`/`session_id` are
 * present on every event type tried), so a malformed or unrecognisable invocation is dropped
 * rather than forwarded as garbage the Bridge would have to guard against instead.
 */
export function buildHookMessages(rawPayload: unknown, slug: string, pid: number): HookMessages | null {
  if (typeof rawPayload !== "object" || rawPayload === null) return null;
  const payload = rawPayload as Record<string, unknown>;
  const hookEventName = payload.hook_event_name;
  const sessionId = payload.session_id;
  if (typeof hookEventName !== "string" || typeof sessionId !== "string") return null;

  return {
    hello: { v: PROTOCOL_VERSION, type: "hello", role: "hook", slug, pid, event: hookEventName },
    event: { v: PROTOCOL_VERSION, type: "event", slug, hook_event_name: hookEventName, session_id: sessionId, payload },
  };
}
