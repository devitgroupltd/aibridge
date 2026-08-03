import { describe, expect, test } from "bun:test";
import { encodeMessage, NdjsonDecoder } from "../src/framing.ts";
import type { ReplyMessage } from "../src/types.ts";

const sample: ReplyMessage = {
  v: 1,
  slug: "test-session",
  type: "reply",
  topic_id: "3",
  text: "hello",
};

describe("NDJSON framing", () => {
  test("encode/decode round trip", () => {
    const decoder = new NdjsonDecoder();
    const [decoded] = decoder.push(encodeMessage(sample));
    expect(decoded).toEqual(sample);
  });

  test("a line split across two chunks is only emitted once complete", () => {
    const decoder = new NdjsonDecoder();
    const line = encodeMessage(sample);
    const splitAt = Math.floor(line.length / 2);

    const firstHalf = decoder.push(line.slice(0, splitAt));
    expect(firstHalf).toEqual([]);

    const secondHalf = decoder.push(line.slice(splitAt));
    expect(secondHalf).toEqual([sample]);
  });

  test("multiple messages in one chunk all decode", () => {
    const decoder = new NdjsonDecoder();
    const chunk = encodeMessage(sample) + encodeMessage({ ...sample, text: "world" });
    const decoded = decoder.push(chunk);
    expect(decoded).toHaveLength(2);
    expect(decoded[1]).toMatchObject({ text: "world" });
  });

  test("buffer retains a trailing partial line across pushes", () => {
    const decoder = new NdjsonDecoder();
    const two = encodeMessage(sample) + encodeMessage(sample).slice(0, -1); // drop trailing \n
    const first = decoder.push(two);
    expect(first).toEqual([sample]);

    const second = decoder.push("\n");
    expect(second).toEqual([sample]);
  });
});
