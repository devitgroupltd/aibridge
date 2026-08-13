import http from "node:http";
import type { LogFn } from "./logger.ts";

/**
 * §5.7's OTLP/HTTP listener. Ingests Claude Code's own telemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY`
 * + `OTEL_EXPORTER_OTLP_ENDPOINT` pointed here via `settings.ts`'s generated `env` block) on
 * `127.0.0.1:4318`.
 *
 * **Live spike, 2026-08-04** (a throwaway `claude -p` run against a capture-only HTTP server, same
 * discipline as every other unverified-payload build in this project): the plan's §5.7 design assumed
 * the `/v1/metrics` `claude_code.cost.usage` metric as the cost source, needing per-session delta
 * accumulation across export intervals (`aggregationTemporality: 1` is DELTA, confirmed live, not
 * CUMULATIVE). The real capture showed a strictly better source sitting right next to it on
 * `/v1/logs`: a `claude_code.api_request` log record fires once per actual API call and already
 * carries a complete `cost_usd`, `session.id`, `model`, and all four token-type counts as flat
 * attributes - no cross-interval accumulation needed. This listener parses that log record and
 * ignores `/v1/metrics` entirely (drained and 200'd so Claude Code's own exporter never sees a
 * failure, but not parsed) - a deliberate, evidence-based deviation from the plan's original design,
 * not an oversight.
 *
 * `claude_code.api_error` (§10.5 point 3, the quota-stop detector) was **not** independently
 * observed in the spike - forcing a real rate-limit response wasn't practical to stage. It's parsed
 * defensively (any log record whose body is `claude_code.api_error`, `session.id` pulled the same
 * way, every other attribute passed through raw) so the caller can act on whatever arrives, but the
 * exact attribute set is unverified against a real payload - flagged here rather than glossed over,
 * same as the plan's own honesty convention elsewhere (`/mode`'s cycle order, `/effort`'s dialog).
 *
 * Protocol choice: `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, not the plan's originally-written
 * `http/protobuf` - confirmed live that Claude Code honours the env var and sends plain JSON, which
 * this listener parses with zero protobuf dependency. Sending protobuf and parsing it would need a
 * `.proto`-generated decoder for no benefit only the wire format changes, not the data.
 */

export interface OtlpAttribute {
  key: string;
  value?: { stringValue?: string; intValue?: number; doubleValue?: number; boolValue?: boolean };
}

export interface OtlpLogRecord {
  timeUnixNano?: string;
  body?: { stringValue?: string };
  attributes?: OtlpAttribute[];
}

export interface OtlpLogsBody {
  resourceLogs?: { scopeLogs?: { logRecords?: OtlpLogRecord[] }[] }[];
}

function attrsToMap(attributes: OtlpAttribute[] | undefined): Map<string, string | number | boolean> {
  const map = new Map<string, string | number | boolean>();
  for (const attr of attributes ?? []) {
    const v = attr.value;
    if (!v) continue;
    if (v.stringValue !== undefined) map.set(attr.key, v.stringValue);
    else if (v.intValue !== undefined) map.set(attr.key, v.intValue);
    else if (v.doubleValue !== undefined) map.set(attr.key, v.doubleValue);
    else if (v.boolValue !== undefined) map.set(attr.key, v.boolValue);
  }
  return map;
}

function allLogRecords(body: OtlpLogsBody): OtlpLogRecord[] {
  const records: OtlpLogRecord[] = [];
  for (const rl of body.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      records.push(...(sl.logRecords ?? []));
    }
  }
  return records;
}

export interface ApiRequestEvent {
  sessionId: string;
  model: string;
  costUsd: number;
  atMs: number;
}

export interface ApiErrorEvent {
  sessionId: string;
  atMs: number;
  raw: Record<string, string | number | boolean>;
}

/** Parses a `/v1/logs` OTLP/JSON body into the two event kinds this Bridge acts on. Every other log
 * record (`user_prompt`, `mcp_server_connection`, `assistant_response`, ...) is real per the live
 * capture but irrelevant to cost tracking or quota-stop detection, so it's silently skipped rather
 * than logged - this endpoint fires on every single API call, and a log line per skipped record
 * would drown the Bridge's own log. */
export function parseOtlpLogsBody(body: OtlpLogsBody): { apiRequests: ApiRequestEvent[]; apiErrors: ApiErrorEvent[] } {
  const apiRequests: ApiRequestEvent[] = [];
  const apiErrors: ApiErrorEvent[] = [];

  for (const record of allLogRecords(body)) {
    const kind = record.body?.stringValue;
    if (kind !== "claude_code.api_request" && kind !== "claude_code.api_error") continue;

    const attrs = attrsToMap(record.attributes);
    const sessionId = attrs.get("session.id");
    if (typeof sessionId !== "string") continue;
    const atMs = record.timeUnixNano ? Number(BigInt(record.timeUnixNano) / 1_000_000n) : Date.now();

    if (kind === "claude_code.api_request") {
      const model = attrs.get("model");
      const costUsd = attrs.get("cost_usd");
      if (typeof model !== "string" || typeof costUsd !== "number") continue;
      apiRequests.push({ sessionId, model, costUsd, atMs });
    } else {
      apiErrors.push({ sessionId, atMs, raw: Object.fromEntries(attrs) });
    }
  }

  return { apiRequests, apiErrors };
}

export interface OtlpListenerOptions {
  port: number;
  onApiRequest: (event: ApiRequestEvent) => void;
  onApiError: (event: ApiErrorEvent) => void;
  log: LogFn;
}

/** Binds to `127.0.0.1:<port>` only - never on a fleet-wide interface, matching every other
 * localhost-only listener in this codebase (the pipe server, the dev control port). Telemetry is
 * strictly read-only input (§5.7): a malformed body or a parse failure is logged and the request
 * still gets a 200, so a listener hiccup degrades `/ls`/`/budget` and nothing else, never the
 * session itself (Claude Code doesn't retry-block on export failure, but there's no reason to risk it). */
export function startOtlpListener(opts: OtlpListenerOptions): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/logs") {
      // `/v1/metrics` (and anything else) lands here - drained and 200'd, never parsed. See the
      // module doc for why metrics are deliberately not the cost source.
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OtlpLogsBody;
        const { apiRequests, apiErrors } = parseOtlpLogsBody(parsed);
        for (const event of apiRequests) opts.onApiRequest(event);
        for (const event of apiErrors) opts.onApiError(event);
      } catch (err) {
        opts.log("WARN", `otlp-listener: failed to parse /v1/logs body: ${(err as Error).message}`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  server.listen(opts.port, "127.0.0.1", () => {
    opts.log("INFO", `otlp listener on http://127.0.0.1:${opts.port}`);
  });
  return server;
}
