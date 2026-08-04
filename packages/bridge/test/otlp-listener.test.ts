import { describe, expect, test } from "bun:test";
import type { OtlpLogRecord, OtlpLogsBody } from "../src/otlp-listener.ts";
import { parseOtlpLogsBody } from "../src/otlp-listener.ts";

/** Trimmed to the fields the parser actually reads, but the shape (attributes as a flat array of
 * {key, value: {stringValue|intValue|doubleValue|boolValue}}, `body.stringValue` naming the event)
 * is verbatim from the 2026-08-04 live spike against a real `claude -p` run with
 * `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` - see otlp-listener.ts's own doc comment. */
function apiRequestRecord(overrides: { sessionId?: string; model?: string; costUsd?: number; timeUnixNano?: string } = {}): OtlpLogRecord {
  return {
    timeUnixNano: overrides.timeUnixNano ?? "1785831600799000000",
    body: { stringValue: "claude_code.api_request" },
    attributes: [
      { key: "session.id", value: { stringValue: overrides.sessionId ?? "bf0f1d11-01c5-4796-a6f1-9e4341fc63fb" } },
      { key: "model", value: { stringValue: overrides.model ?? "claude-sonnet-5" } },
      { key: "input_tokens", value: { intValue: 2 } },
      { key: "output_tokens", value: { intValue: 6 } },
      { key: "cache_read_tokens", value: { intValue: 0 } },
      { key: "cache_creation_tokens", value: { intValue: 45344 } },
      { key: "cost_usd", value: { doubleValue: overrides.costUsd ?? 0.27216 } },
      { key: "query_source", value: { stringValue: "main" } },
    ],
  };
}

function wrap(records: OtlpLogRecord[]): OtlpLogsBody {
  return { resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] };
}

describe("parseOtlpLogsBody", () => {
  test("parses a real claude_code.api_request record into an ApiRequestEvent", () => {
    const { apiRequests, apiErrors } = parseOtlpLogsBody(wrap([apiRequestRecord()]));
    expect(apiErrors).toEqual([]);
    expect(apiRequests).toEqual([
      { sessionId: "bf0f1d11-01c5-4796-a6f1-9e4341fc63fb", model: "claude-sonnet-5", costUsd: 0.27216, atMs: 1785831600799 },
    ]);
  });

  test("irrelevant log records (user_prompt, mcp_server_connection, ...) are silently skipped", () => {
    const { apiRequests, apiErrors } = parseOtlpLogsBody(
      wrap([
        { body: { stringValue: "claude_code.user_prompt" }, attributes: [{ key: "session.id", value: { stringValue: "sess-1" } }] },
        { body: { stringValue: "claude_code.mcp_server_connection" }, attributes: [{ key: "session.id", value: { stringValue: "sess-1" } }] },
      ]),
    );
    expect(apiRequests).toEqual([]);
    expect(apiErrors).toEqual([]);
  });

  test("a claude_code.api_error record (unverified shape - see module doc) parses session.id and passes every other attribute through raw", () => {
    const { apiErrors } = parseOtlpLogsBody(
      wrap([
        {
          timeUnixNano: "1785831600799000000",
          body: { stringValue: "claude_code.api_error" },
          attributes: [
            { key: "session.id", value: { stringValue: "sess-err" } },
            { key: "error_type", value: { stringValue: "rate_limit" } },
          ],
        },
      ]),
    );
    expect(apiErrors).toEqual([{ sessionId: "sess-err", atMs: 1785831600799, raw: { "session.id": "sess-err", error_type: "rate_limit" } }]);
  });

  test("a record missing session.id, model or cost_usd is dropped rather than producing a partial/garbage event", () => {
    const { apiRequests } = parseOtlpLogsBody(
      wrap([
        { body: { stringValue: "claude_code.api_request" }, attributes: [{ key: "model", value: { stringValue: "claude-sonnet-5" } }] },
      ]),
    );
    expect(apiRequests).toEqual([]);
  });

  test("multiple resourceLogs/scopeLogs groups are all walked", () => {
    const body = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [apiRequestRecord({ sessionId: "sess-a" })] }] }, { scopeLogs: [{ logRecords: [apiRequestRecord({ sessionId: "sess-b" })] }] }],
    };
    const { apiRequests } = parseOtlpLogsBody(body);
    expect(apiRequests.map((r) => r.sessionId).sort()).toEqual(["sess-a", "sess-b"]);
  });
});
