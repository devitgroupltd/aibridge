import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildMeta, PROTOCOL_VERSION } from "@aibridge/protocol";
import type { InboundMessage, Message, ReplyMessage } from "@aibridge/protocol";
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

// §3.1: Phase 1 declares only `claude/channel` + `tools` - no `claude/channel/permission` yet (Phase 2).
const server = new Server(
  { name: "aibridge", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
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

function handleFromBridge(msg: Message): void {
  log("INFO", `received from Bridge: type=${msg.type}`);
  if (msg.type === "inbound") {
    forwardInbound(msg).catch((err) => {
      log("ERROR", `failed to deliver inbound notification: ${(err as Error).message}`);
    });
  }
  // hello_ack / ack / verdict: nothing to do with these yet in Phase 1.
}

// AIBRIDGE_PIPE_PATH overrides the default pipe path - used by integration tests to run several
// isolated Bridge/channel-server pairs concurrently without colliding on \\.\pipe\aibridge.
const pipe = new PipeClient({ slug, pipePath: process.env.AIBRIDGE_PIPE_PATH, onMessage: handleFromBridge, log });
pipe.start();

const transport = new StdioServerTransport();
await server.connect(transport);
log("INFO", "channel server connected over stdio");
log("INFO", `client capabilities: ${JSON.stringify(server.getClientCapabilities())}`);
