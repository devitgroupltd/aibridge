import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Message } from "@aibridge/protocol";
import { PipeClient } from "./pipe-client.ts";
import { resolveSlug } from "./resolve-slug.ts";
import { createChannelHandlers } from "./channel-handlers.ts";

// This component only exists spawned either by the Bridge (§2.4) or by the aibridge-telegram
// plugin (§10.1) - there is no meaningful way to run it standalone, so a missing var is a loud,
// immediate failure. See resolve-slug.ts for why there are two valid sources.
const slug = resolveSlug(process.env);
if (!slug) {
  throw new Error(
    "could not determine this session's slug - neither AIBRIDGE_SLUG nor CLAUDE_PROJECT_DIR is set; this channel server must be spawned by the Bridge or the aibridge-telegram plugin",
  );
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
      "To show the operator a screenshot: for a web page, use the playwright MCP tools (already",
      `registered) - browser_take_screenshot saves into ${process.env.AIBRIDGE_PLAYWRIGHT_SHARED_DIR ?? "<AIBRIDGE_PLAYWRIGHT_SHARED_DIR>"},`,
      "a directory shared with every other session on this repo, so move (Bash mv) the file into",
      `${process.env.AIBRIDGE_OUTBOX_DIR ?? "<AIBRIDGE_OUTBOX_DIR>"} before calling send_file - send_file only accepts`,
      "paths inside that directory. For a desktop app or the whole screen instead, run",
      `${process.env.AIBRIDGE_SCREENSHOT_SCRIPT ?? "<AIBRIDGE_SCREENSHOT_SCRIPT>"} via Bash with -Out <a path already`,
      "inside AIBRIDGE_OUTBOX_DIR> (and optionally -WindowTitle) - no move needed, it writes there directly.",
      "Either way, then call send_file with that topic_id and the file's path.",
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
    {
      name: "send_file",
      description:
        "Send a file (e.g. a screenshot) already saved under $AIBRIDGE_OUTBOX_DIR to the operator's Telegram topic, as a photo or document.",
      inputSchema: {
        type: "object",
        properties: {
          topic_id: { type: "string" },
          path: { type: "string", description: "Absolute path under $AIBRIDGE_OUTBOX_DIR." },
          caption: { type: "string" },
        },
        required: ["topic_id", "path"],
      },
    },
  ],
}));

// The actual request/notification handling (P1-8, codebase-hardening-plan.md) lives in
// channel-handlers.ts, unit-tested there against fake `pipe`/`server` - this file is now just
// wiring. `pipe` is constructed with a forward-referenced `onMessage` (assigned right after
// `handlers` exists) since `handlers.handleFromBridge` needs `pipe` for its own two handlers
// (`callTool`/`handlePermissionRequestNotification`), a small circular dependency resolved the
// same way `sendResumeNudge`/`LateBound` resolves the analogous one in the Bridge composition root.
let handleFromBridge: (msg: Message) => void = () => {};

// AIBRIDGE_PIPE_PATH overrides the default pipe path - used by integration tests to run several
// isolated Bridge/channel-server pairs concurrently without colliding on \\.\pipe\aibridge.
const pipe = new PipeClient({ slug, pipePath: process.env.AIBRIDGE_PIPE_PATH, onMessage: (msg) => handleFromBridge(msg), log });
pipe.start();

const handlers = createChannelHandlers({ slug, pipe, server, log });
handleFromBridge = handlers.handleFromBridge;

server.setRequestHandler(CallToolRequestSchema, handlers.callTool);
server.fallbackNotificationHandler = handlers.handlePermissionRequestNotification;

const transport = new StdioServerTransport();
await server.connect(transport);
log("INFO", "channel server connected over stdio");
log("INFO", `client capabilities: ${JSON.stringify(server.getClientCapabilities())}`);
