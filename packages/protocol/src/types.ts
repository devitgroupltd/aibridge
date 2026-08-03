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

// --- channel server <-> Bridge (Phase 2, defined now, unused until then) ------------------

export interface PermissionRequestMessage extends EnvelopeBase {
  type: "permission_request";
  // Exact fields are the "four relay fields" of §6.3, not yet read/verified for this stage -
  // deliberately left loose rather than guessed.
  [key: string]: unknown;
}

export interface VerdictMessage extends EnvelopeBase {
  type: "verdict";
  request_id: string;
  behavior: "allow" | "deny";
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
