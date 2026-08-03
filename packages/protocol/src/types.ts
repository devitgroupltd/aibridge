/**
 * Wire types for the aibridge socket protocol (plan §2.5).
 *
 * Every message carries `v`, `type` and `slug`; messages that expect an answer carry `id`,
 * and the reply echoes it back in `re`. Phase 1 only wires Hello/HelloAck/Reply/Ack/Inbound;
 * the rest are defined now so Phase 2-4 don't renegotiate the shared contract, but are unused
 * until then. The plan's §2.5 table names the *request* shapes precisely; it does not name the
 * `hello`/`reply` ack message types, so `hello_ack` and `ack` below are this implementation's
 * own (reasonable, minimal) choice rather than something quoted from the plan.
 */

export const PROTOCOL_VERSION = 1;

interface EnvelopeBase {
  v: number;
  slug: string;
  id?: string;
  re?: string;
}

// --- channel server <-> Bridge (Phase 1) ---------------------------------------------------

export interface HelloFromChannel extends EnvelopeBase {
  type: "hello";
  role: "channel";
  pid: number;
}

export interface HelloAck extends EnvelopeBase {
  type: "hello_ack";
  topic_id: number;
  session_state: string;
}

export interface ReplyMessage extends EnvelopeBase {
  type: "reply";
  topic_id: string;
  text: string;
}

export interface Ack extends EnvelopeBase {
  type: "ack";
}

export interface ChannelMetaFields {
  topic_id: string;
  msg_id: string;
  from: string;
  seq: number;
  [key: string]: string | number;
}

export interface InboundMessage extends EnvelopeBase {
  type: "inbound";
  content: string;
  meta: ChannelMetaFields;
}

// --- channel server <-> Bridge (Phase 2) --------------------------------------------------

/**
 * §6.3's "four relay fields", live-verified 2026-08-03 against a real `Write` call gated by
 * manual mode: the notification arrives with exactly `request_id`, `tool_name`, `description`
 * and `input_preview`, matching the plan's worked example field-for-field.
 */
export interface PermissionRequestMessage extends EnvelopeBase {
  type: "permission_request";
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

export type VerdictBehavior = "allow" | "deny";

export interface VerdictMessage extends EnvelopeBase {
  type: "verdict";
  request_id: string;
  behavior: VerdictBehavior;
}

/**
 * §9 scenario 4: the verdict shape crosses a process boundary (Bridge to channel server, then
 * channel server to Claude Code as a notification), so `behavior` can't rely on the type system
 * alone - a typo or a future third state must throw loudly here rather than get forwarded as-is.
 */
export function assertValidBehavior(behavior: string): asserts behavior is VerdictBehavior {
  if (behavior !== "allow" && behavior !== "deny") {
    throw new Error(`invalid verdict behavior "${behavior}" - must be "allow" or "deny"`);
  }
}

// --- hook client <-> Bridge (Phase 3/4, defined now, unused until then) ------------------

export interface HelloFromHook extends EnvelopeBase {
  type: "hello";
  role: "hook";
  pid: number;
  event: string;
}

export interface HookEventMessage extends EnvelopeBase {
  type: "event";
  event: unknown;
}

export interface HookAskMessage extends EnvelopeBase {
  type: "ask";
  questions: unknown[];
}

export interface HookAnswerMessage extends EnvelopeBase {
  type: "answer";
  answers?: unknown;
  cancel?: true;
}

export type Message =
  | HelloFromChannel
  | HelloFromHook
  | HelloAck
  | ReplyMessage
  | Ack
  | PermissionRequestMessage
  | InboundMessage
  | VerdictMessage
  | HookEventMessage
  | HookAskMessage
  | HookAnswerMessage;
