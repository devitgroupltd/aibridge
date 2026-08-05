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

/**
 * §5.8's outbound counterpart to attachment-inbox.ts's inbound path: `path` must resolve inside
 * this session's own `$STATE/sessions/<slug>/outbox/` (enforced Bridge-side by `outbox.ts`, never
 * trusted from the channel server) - a screenshot Claude saved there, or any other file it wants
 * the operator to see, gets forwarded as a Telegram photo or document depending on its extension.
 */
export interface SendFileMessage extends EnvelopeBase {
  type: "send_file";
  topic_id: string;
  path: string;
  caption?: string;
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

/**
 * `§5.1`'s hook client: one process per hook firing, forwarding the raw payload Claude Code piped
 * to its stdin. `hook_event_name` and `session_id` are pulled out because every handler needs them
 * to route and normalise (`hook-events.ts`); the rest of the payload is forwarded verbatim in
 * `payload` rather than re-typed per event, since `§6.5` already showed one assumed field
 * (`tool_use_id` on `PermissionRequest`) turning out not to exist - the normalizer treats every
 * field access as possibly absent rather than this type vouching for a specific shape.
 */
export interface HookEventMessage extends EnvelopeBase {
  type: "event";
  hook_event_name: string;
  session_id: string;
  payload: Record<string, unknown>;
}

/**
 * §6.4's shape, live-verified 2026-08-03 against a real `AskUserQuestion` `PreToolUse` call:
 * `tool_input.questions[]` carries `question`, an optional `header`, `options` (always
 * `{ label, description }` objects, never bare strings), and `multiSelect` - multi-select
 * questions aren't specially handled yet (every option still renders as its own single-choice
 * button), a known gap rather than an invented one. `request_id` is the tool's own
 * `tool_use_id`, present on this event unlike `PermissionRequest`'s (§6.5) - used here as a
 * stable key across hook-client reconnects (§2.5) rather than something the Bridge invents.
 */
export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskQuestionOption[];
  multiSelect?: boolean;
}

export interface HookAskMessage extends EnvelopeBase {
  type: "ask";
  request_id: string;
  questions: AskQuestion[];
}

/**
 * §6.4: `answers` is keyed by each question's own `question` text (live-verified accepted shape
 * for `hookSpecificOutput.updatedInput.answers`); `cancel` is the 3540s Bridge-side ceiling
 * (§6.4) - "no answer in an hour, cancelling the question" - never both set.
 */
export interface HookAnswerMessage extends EnvelopeBase {
  type: "answer";
  answers?: Record<string, string>;
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
  | HookAnswerMessage
  | SendFileMessage;
