import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { assertValidBehavior, buildMeta, PROTOCOL_VERSION } from "@aibridge/protocol";
import type { InboundMessage, Message, PermissionRequestMessage, ReplyMessage, VerdictMessage } from "@aibridge/protocol";
import { PipeClient } from "./pipe-client.ts";

// This component only ever exists because the Bridge spawned it with AIBRIDGE_SLUG set (§2.4) -
// there is no meaningful way to run it standalone, so a missing var is a loud, immediate failure.
const slug = process.env.AIBRIDGE_SLUG;
if (!slug) {
  throw new Error("AIBRIDGE_SLUG is not set - this channel server must be spawned by the Bridge");
}

// stdout is the MCP transport (StdioServerTransport); all logging goes to stderr (§9). Claude
// Code does not surface an MCP server's stderr anywhere visible, so AIBRIDGE_DEBUG_LOG_FILE also
// appends to a plain file when set - the only way to observe this process's own log lines during
// manual verification (Stage 7).
const debugLogFile = process.env.AIBRIDGE_DEBUG_LOG_FILE;
function log(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] channel-server(${slug}): ${message}\n`;
  process.stderr.write(line);
  if (debugLogFile) {
    try {
      appendFileSync(debugLogFile, line);
    } catch {
      // best-effort only
    }
  }
}

// §3.1: Phase 2 - `claude/channel/permission` opts in to the permission relay. Live-verified
// 2026-08-03: a real `Write` call under manual mode produced exactly the notification shape below,
// and a `notifications/claude/channel/permission` verdict genuinely closed the local dialog with
// no keystroke sent to the terminal - the plan's one open risk here is resolved, not assumed.
const server = new Server(
  { name: "aibridge", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: [
      'Messages from the operator arrive as <channel source="aibridge" topic_id="..." msg_id="...">.',
      "To answer the operator, call the reply tool and pass back the topic_id from the tag.",
      "Reply as you would in a terminal: the operator is reading on a phone, so be brief.",
      "Do not narrate tool use in replies; the operator already sees a live activity feed.",
    ].join(" "),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a reply to the operator in their Telegram topic for this session.",
      inputSchema: {
        type: "object",
        properties: {
          topic_id: { type: "string" },
          text: { type: "string" },
        },
        required: ["topic_id", "text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "reply") {
    throw new Error(`unknown tool "${request.params.name}"`);
  }
  const args = request.params.arguments;
  if (typeof args?.topic_id !== "string" || typeof args?.text !== "string") {
    throw new Error("reply requires { topic_id: string, text: string }");
  }

  // §3.3: forwarding to the Bridge is independent of the pipe's own connection state - if
  // disconnected, PipeClient queues it (reply is priority) rather than dropping it.
  const msg: ReplyMessage = {
    v: PROTOCOL_VERSION,
    type: "reply",
    slug,
    topic_id: args.topic_id,
    text: args.text,
  };
  pipe.send(msg);

  return { content: [{ type: "text", text: "sent" }] };
});

async function forwardInbound(msg: InboundMessage): Promise<void> {
  const meta = buildMeta(msg.meta);
  log("INFO", `forwarding inbound to Claude via notification: content=${JSON.stringify(msg.content)} meta=${JSON.stringify(meta)}`);
  await server.notification({
    method: "notifications/claude/channel",
    params: { content: msg.content, meta },
  });
  log("INFO", "server.notification() resolved without error");
}

/** §6.3's send-side: relays a Bridge verdict back to Claude Code, closing the local dialog. */
async function sendVerdictToClaude(msg: VerdictMessage): Promise<void> {
  assertValidBehavior(msg.behavior);
  await server.notification({
    method: "notifications/claude/channel/permission",
    params: { request_id: msg.request_id, behavior: msg.behavior },
  });
  log("INFO", `sent verdict for request_id=${msg.request_id}: ${msg.behavior}`);
}

function handleFromBridge(msg: Message): void {
  log("INFO", `received from Bridge: type=${msg.type}`);
  if (msg.type === "inbound") {
    forwardInbound(msg).catch((err) => {
      log("ERROR", `failed to deliver inbound notification: ${(err as Error).message}`);
    });
  } else if (msg.type === "verdict") {
    sendVerdictToClaude(msg).catch((err) => {
      log("ERROR", `failed to deliver verdict: ${(err as Error).message}`);
    });
  }
  // hello_ack / ack: nothing to do with these.
}

/**
 * §6.3's receive-side: Claude Code emits this notification (not a request - there is no reply
 * expected inline) when a gated tool call raises a local permission prompt. Forwarded to the
 * Bridge over the pipe verbatim; `permission_request` is already priority-queued by
 * `pipe-client.ts`'s `isPriority()` if the pipe happens to be disconnected.
 */
server.fallbackNotificationHandler = async (notification) => {
  if (notification.method !== "notifications/claude/channel/permission_request") {
    log("WARN", `unhandled notification from Claude Code: ${notification.method}`);
    return;
  }
  const params = notification.params as
    | { request_id?: unknown; tool_name?: unknown; description?: unknown; input_preview?: unknown }
    | undefined;
  if (
    typeof params?.request_id !== "string" ||
    typeof params.tool_name !== "string" ||
    typeof params.description !== "string" ||
    typeof params.input_preview !== "string"
  ) {
    log("ERROR", `malformed permission_request notification: ${JSON.stringify(notification)}`);
    return;
  }
  const msg: PermissionRequestMessage = {
    v: PROTOCOL_VERSION,
    type: "permission_request",
    slug,
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
  };
  log("INFO", `forwarding permission_request ${params.request_id} (${params.tool_name}) to Bridge`);
  pipe.send(msg);
};

// AIBRIDGE_PIPE_PATH overrides the default pipe path - used by integration tests to run several
// isolated Bridge/channel-server pairs concurrently without colliding on \\.\pipe\aibridge.
const pipe = new PipeClient({ slug, pipePath: process.env.AIBRIDGE_PIPE_PATH, onMessage: handleFromBridge, log });
pipe.start();

const transport = new StdioServerTransport();
await server.connect(transport);
log("INFO", "channel server connected over stdio");
log("INFO", `client capabilities: ${JSON.stringify(server.getClientCapabilities())}`);
