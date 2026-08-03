import { describe, expect, test } from "bun:test";
import { buildMeta } from "../src/meta.ts";

describe("buildMeta", () => {
  // §9 scenario 1: meta keys survive
  test("snake_case keys pass through untouched", () => {
    const meta = buildMeta({ topic_id: "42", msg_id: "7", from: "oleg", seq: 1 });
    expect(meta).toEqual({ topic_id: "42", msg_id: "7", from: "oleg", seq: 1 });
  });

  // §9 scenario 2: hyphenated meta keys are rejected at build time, not silently dropped
  test("throws on a hyphenated key", () => {
    expect(() => buildMeta({ "topic-id": "42" })).toThrow(/invalid/);
  });

  // §3.2: source is reserved by Claude Code and must never appear in meta
  test("throws on a reserved source key", () => {
    expect(() => buildMeta({ source: "aibridge" })).toThrow(/reserved/);
  });

  test("throws on any key outside [A-Za-z0-9_]", () => {
    expect(() => buildMeta({ "topic.id": "42" })).toThrow(/invalid/);
    expect(() => buildMeta({ "topic id": "42" })).toThrow(/invalid/);
  });
});
