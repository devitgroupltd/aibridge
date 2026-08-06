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

describe("UTF-8 across chunk boundaries", () => {
  // The silent-wrong case, and the reason this decoder holds a StringDecoder: `chunk.toString("utf8")`
  // per chunk replaces the halves of a split codepoint with U+FFFD and still produces *valid JSON*,
  // so nothing throws and nothing logs. A permission card's `input_preview` or a reply arrives
  // quietly mangled - and this operator's text is routinely Cyrillic and emoji-heavy.
  test("a multi-byte character split mid-codepoint survives intact", () => {
    const decoder = new NdjsonDecoder();
    const line = Buffer.from(encodeMessage({ ...sample, text: "привет 🎉" }), "utf8");

    // Split inside the emoji's 4-byte sequence: the last byte of the line is "\n", so backing off
    // two bytes from the end lands mid-codepoint for a 4-byte character.
    const splitAt = line.length - 3;
    expect(decoder.push(line.subarray(0, splitAt))).toEqual([]);
    const decoded = decoder.push(line.subarray(splitAt));

    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({ text: "привет 🎉" });
    expect(JSON.stringify(decoded[0])).not.toContain("�");
  });

  test("a Cyrillic payload split at every possible byte offset always decodes intact", () => {
    const line = Buffer.from(encodeMessage({ ...sample, text: "тест ёжик 🚀 ok" }), "utf8");
    for (let splitAt = 1; splitAt < line.length; splitAt++) {
      const decoder = new NdjsonDecoder();
      const out = [...decoder.push(line.subarray(0, splitAt)), ...decoder.push(line.subarray(splitAt))];
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ text: "тест ёжик 🚀 ok" });
    }
  });
});

describe("malformed lines", () => {
  // Parsing the whole chunk with one `map` meant a single corrupt line discarded every well-formed
  // message sharing that chunk - including, in the worst case, a hook's `hello`+`ask` pair, leaving
  // Claude blocked for the full hour over one bad byte elsewhere.
  test("one bad line is skipped without losing the good messages around it", () => {
    const seen: string[] = [];
    const decoder = new NdjsonDecoder((line) => seen.push(line));
    const chunk = encodeMessage(sample) + "{not json\n" + encodeMessage({ ...sample, text: "after" });

    const decoded = decoder.push(chunk);

    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toMatchObject({ text: "hello" });
    expect(decoded[1]).toMatchObject({ text: "after" });
    expect(seen).toEqual(["{not json"]);
  });

  test("with no onError handler a bad line still throws, so it can never pass unnoticed", () => {
    const decoder = new NdjsonDecoder();
    expect(() => decoder.push("{not json\n")).toThrow();
  });

  test("a peer that never sends a newline is cut off instead of growing the buffer forever", () => {
    const decoder = new NdjsonDecoder();
    // 9MB with no newline - past MAX_LINE_BYTES. Without the cap this grows until the daemon is
    // OOM-killed, taking every session with it.
    expect(() => decoder.push("x".repeat(9 * 1024 * 1024))).toThrow(/exceeded/);
    // The buffer is dropped, so the connection can be torn down without leaking it.
    expect(decoder.push(encodeMessage(sample))).toEqual([sample]);
  });
});
