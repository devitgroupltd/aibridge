import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../src/types.ts";
import type {
  Ack,
  HelloAck,
  HelloFromChannel,
  HelloFromHook,
  HookAnswerMessage,
  HookAskMessage,
  HookEventMessage,
  InboundMessage,
  Message,
  PermissionRequestMessage,
  ReplyMessage,
  SendFileMessage,
  VerdictMessage,
} from "../src/types.ts";

/** P1-8 (codebase-hardening-plan.md): `types.ts` itself has no runtime behavior beyond
 * `assertValidBehavior` (already covered by `verdict.test.ts`) and `PROTOCOL_VERSION` - everything
 * else is erased at compile time, so there's nothing to unit-test in the usual sense. What *is*
 * worth locking down, and what every other protocol/*.test.ts file leaves untouched, is the
 * `Message` union's own completeness: every component that branches on `msg.type`
 * (pipe-server.ts's `handleMessage`, channel-handlers.ts's `handleFromBridge`) does so via a
 * `switch` - this file's exhaustiveness check below fails to *compile* if a future variant is
 * added to the union without a matching case here, which is exactly the "silent-wrong" a runtime
 * `expect()` can't catch on its own (nothing throws; a consumer's `default` branch would just
 * silently ignore the new type forever, unnoticed, per pipe-server.ts's own `handleMessage`). */

const ALL_MESSAGES: Message[] = [
  { v: PROTOCOL_VERSION, type: "hello", role: "channel", slug: "fix-bug", pid: 111 } satisfies HelloFromChannel,
  { v: PROTOCOL_VERSION, type: "hello", role: "hook", slug: "fix-bug", pid: 222, event: "PreToolUse" } satisfies HelloFromHook,
  { v: PROTOCOL_VERSION, type: "hello_ack", slug: "fix-bug", topic_id: 5, session_state: "idle" } satisfies HelloAck,
  { v: PROTOCOL_VERSION, type: "reply", slug: "fix-bug", topic_id: "5", text: "hi" } satisfies ReplyMessage,
  { v: PROTOCOL_VERSION, type: "ack", slug: "fix-bug" } satisfies Ack,
  {
    v: PROTOCOL_VERSION,
    type: "permission_request",
    slug: "fix-bug",
    request_id: "req-1",
    tool_name: "Write",
    description: "Write to file.ts",
    input_preview: "...",
  } satisfies PermissionRequestMessage,
  {
    v: PROTOCOL_VERSION,
    type: "inbound",
    slug: "fix-bug",
    content: "hello",
    meta: { topic_id: "5", msg_id: "1", from: "operator", seq: 1 },
  } satisfies InboundMessage,
  { v: PROTOCOL_VERSION, type: "verdict", slug: "fix-bug", request_id: "req-1", behavior: "allow" } satisfies VerdictMessage,
  {
    v: PROTOCOL_VERSION,
    type: "event",
    slug: "fix-bug",
    hook_event_name: "PreToolUse",
    session_id: "sess-1",
    payload: {},
  } satisfies HookEventMessage,
  {
    v: PROTOCOL_VERSION,
    type: "ask",
    slug: "fix-bug",
    request_id: "req-1",
    questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
  } satisfies HookAskMessage,
  { v: PROTOCOL_VERSION, type: "answer", slug: "fix-bug", answers: { "Continue?": "Yes" } } satisfies HookAnswerMessage,
  { v: PROTOCOL_VERSION, type: "send_file", slug: "fix-bug", topic_id: "5", path: "/outbox/x.png" } satisfies SendFileMessage,
];

/** Exhaustive by construction: TypeScript rejects this function if `Message` ever gains a member
 * with no matching `case` below (the `never` assignment in `default` is the actual check - it only
 * typechecks when `msg` has been narrowed to nothing) - this is the compile-time half of the
 * completeness guarantee ALL_MESSAGES's runtime assertions verify below. */
function discriminantOf(msg: Message): string {
  switch (msg.type) {
    case "hello":
      return `hello:${msg.role}`;
    case "hello_ack":
      return "hello_ack";
    case "reply":
      return "reply";
    case "ack":
      return "ack";
    case "permission_request":
      return "permission_request";
    case "inbound":
      return "inbound";
    case "verdict":
      return "verdict";
    case "event":
      return "event";
    case "ask":
      return "ask";
    case "answer":
      return "answer";
    case "send_file":
      return "send_file";
    default: {
      const exhaustive: never = msg;
      throw new Error(`unreachable - unhandled Message variant: ${JSON.stringify(exhaustive)}`);
    }
  }
}

describe("Message union completeness", () => {
  test("every listed fixture actually narrows to a real, distinct discriminant", () => {
    const discriminants = ALL_MESSAGES.map(discriminantOf);
    expect(discriminants).toEqual([
      "hello:channel",
      "hello:hook",
      "hello_ack",
      "reply",
      "ack",
      "permission_request",
      "inbound",
      "verdict",
      "event",
      "ask",
      "answer",
      "send_file",
    ]);
    // No accidental duplicate discriminant slipped in (e.g. two fixtures both narrowing to the
    // same case, silently leaving a real union member unexercised above).
    expect(new Set(discriminants).size).toBe(discriminants.length);
  });

  test("every fixture carries the shared envelope fields every message needs", () => {
    for (const msg of ALL_MESSAGES) {
      expect(msg.v).toBe(PROTOCOL_VERSION);
      expect(typeof msg.slug).toBe("string");
    }
  });

  // pipe-server.ts's `handleMessage` switches on exactly this subset (found live: `handleMessage`
  // has no case for "hello_ack"/"ack"/"inbound"/"verdict"/"answer" - those flow the *other*
  // direction, Bridge/channel-server to hook-client/channel-server, never arriving here) - pinning
  // the two discriminant sets separately means a variant moving between "inbound to the Bridge" and
  // "outbound from it" is a deliberate, visible change to this list, not a silent reclassification.
  test("the subset pipe-server.ts's handleMessage actually switches on is exactly this", () => {
    const inboundToBridge = ["hello", "reply", "permission_request", "event", "ask", "send_file"];
    const rest = ALL_MESSAGES.map((m) => m.type).filter((t) => !inboundToBridge.includes(t));
    expect(new Set(rest)).toEqual(new Set(["hello_ack", "ack", "inbound", "verdict", "answer"]));
  });
});

describe("PROTOCOL_VERSION", () => {
  test("is pinned to 1 - a bump is a deliberate, visible change, not an accidental one", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
