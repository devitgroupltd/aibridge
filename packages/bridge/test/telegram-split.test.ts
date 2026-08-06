import { describe, expect, test } from "bun:test";
import { splitForTelegram } from "../src/pipe-server.ts";
import { isPermanentEditFailure } from "../src/telegram.ts";

// §9's silent-wrong bar: Telegram rejects both an empty message and one over 4096 UTF-16 code units
// with a plain 400. Nothing capped a `reply`, and because a 400 is not a 429 the governor burned its
// three retries on the same oversized payload and then dropped it - and since the "🤔 Thinking..."
// placeholder had already been consumed, the topic was left showing a turn that never ended and no
// answer at all. Both halves of that failure are invisible without a test.
describe("splitForTelegram", () => {
  test("text within the limit is one chunk, unchanged", () => {
    expect(splitForTelegram("hello")).toEqual(["hello"]);
  });

  test("empty or whitespace-only text yields no chunks at all", () => {
    // Telegram 400s on an empty message too - and a reply can become empty legitimately, after
    // `secret-scrub.ts` redacts everything in it.
    expect(splitForTelegram("")).toEqual([]);
    expect(splitForTelegram("   \n  \n")).toEqual([]);
  });

  test("splits at line boundaries and every chunk is within the limit", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i} of some output`).join("\n");
    const chunks = splitForTelegram(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3900);
    // Nothing lost, nothing duplicated: the lines come back in order.
    expect(chunks.join("\n").split("\n")).toEqual(text.split("\n"));
  });

  test("a single line longer than the whole budget is hard-split rather than dropped", () => {
    const chunks = splitForTelegram("x".repeat(10_000));
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3900);
    expect(chunks.join("").length).toBe(10_000);
  });

  test("a long line mixed with short ones keeps both intact", () => {
    const text = `short before\n${"y".repeat(5000)}\nshort after`;
    const chunks = splitForTelegram(text);

    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3900);
    const rejoined = chunks.join("");
    expect(rejoined).toContain("short before");
    expect(rejoined).toContain("short after");
    expect(rejoined).toContain("y".repeat(5000));
  });

  test("the boundary case: exactly at the limit stays one chunk, one over becomes two", () => {
    expect(splitForTelegram("z".repeat(3900))).toHaveLength(1);
    expect(splitForTelegram("z".repeat(3901))).toHaveLength(2);
  });
});

// The feed card's flush branches on this to decide whether to invalidate its cached `message_id`.
// Getting it wrong either way is silent: too strict and the session's feed stays dead for the life of
// the process, too loose and it posts duplicate cards.
describe("isPermanentEditFailure", () => {
  test("recognises the Bot API's unrecoverable edit errors", () => {
    expect(isPermanentEditFailure(new Error("Bad Request: message to edit not found"))).toBe(true);
    expect(isPermanentEditFailure(new Error("Bad Request: message can't be edited"))).toBe(true);
    expect(isPermanentEditFailure(new Error("Bad Request: MESSAGE_ID_INVALID"))).toBe(true);
    expect(isPermanentEditFailure(new Error("Bad Request: message thread not found"))).toBe(true);
  });

  test("does not classify a transient or unrelated failure as permanent", () => {
    expect(isPermanentEditFailure(new Error("Bad Request: message is not modified"))).toBe(false);
    expect(isPermanentEditFailure(new Error("fetch failed"))).toBe(false);
    expect(isPermanentEditFailure(new Error("Too Many Requests: retry after 5"))).toBe(false);
    expect(isPermanentEditFailure(undefined)).toBe(false);
  });
});
