import { describe, expect, test } from "bun:test";
import { formatStaleAge, isStaleInbound, STALE_INBOUND_THRESHOLD_MS, hasAttachment } from "../src/stale-inbound.ts";

describe("isStaleInbound (§7.4)", () => {
  test("a message sent seconds ago is not stale", () => {
    const nowMs = 1_000_000_000_000;
    const messageDateSec = Math.floor(nowMs / 1000) - 5;
    expect(isStaleInbound(messageDateSec, nowMs)).toBe(false);
  });

  test("a message exactly at the 30-minute threshold is not yet stale", () => {
    const nowMs = 1_000_000_000_000;
    const messageDateSec = Math.floor((nowMs - STALE_INBOUND_THRESHOLD_MS) / 1000);
    expect(isStaleInbound(messageDateSec, nowMs)).toBe(false);
  });

  test("a message one second past the threshold is stale", () => {
    const nowMs = 1_000_000_000_000;
    const messageDateSec = Math.floor((nowMs - STALE_INBOUND_THRESHOLD_MS - 1000) / 1000);
    expect(isStaleInbound(messageDateSec, nowMs)).toBe(true);
  });

  test("a two-hour-old backlog message (the plan's own 'yes, push it' example) is stale", () => {
    const nowMs = 1_000_000_000_000;
    const messageDateSec = Math.floor(nowMs / 1000) - 2 * 60 * 60;
    expect(isStaleInbound(messageDateSec, nowMs)).toBe(true);
  });

  test("a custom threshold is honoured", () => {
    const nowMs = 1_000_000_000_000;
    const messageDateSec = Math.floor(nowMs / 1000) - 61;
    expect(isStaleInbound(messageDateSec, nowMs, 60_000)).toBe(true);
    expect(isStaleInbound(messageDateSec, nowMs, 120_000)).toBe(false);
  });
});

describe("formatStaleAge", () => {
  test("formats minutes under an hour", () => {
    const nowMs = 1_000_000_000_000;
    const messageDateSec = Math.floor(nowMs / 1000) - 42 * 60;
    expect(formatStaleAge(messageDateSec, nowMs)).toBe("42m ago");
  });

  test("formats whole hours with no leftover minutes", () => {
    const nowMs = 1_000_000_000_000;
    const messageDateSec = Math.floor(nowMs / 1000) - 2 * 60 * 60;
    expect(formatStaleAge(messageDateSec, nowMs)).toBe("2h ago");
  });

  test("formats hours plus leftover minutes", () => {
    const nowMs = 1_000_000_000_000;
    const messageDateSec = Math.floor(nowMs / 1000) - (3 * 60 * 60 + 15 * 60);
    expect(formatStaleAge(messageDateSec, nowMs)).toBe("3h15m ago");
  });

  test("never reports a negative age (clock skew, message.date slightly ahead of nowMs)", () => {
    const nowMs = 1_000_000_000_000;
    const messageDateSec = Math.floor(nowMs / 1000) + 5;
    expect(formatStaleAge(messageDateSec, nowMs)).toBe("0m ago");
  });
});

/**
 * The staleness gate runs before every per-kind handler in `index.ts`, so it has to tell "content I
 * would have acted on" apart from a Telegram service message. Getting that wrong is silent-wrong in a
 * user-visible way: a backlog replay after downtime posts a spurious "an attachment arrived while
 * offline" notice for every topic Telegram re-announces.
 */
describe("hasAttachment", () => {
  test("recognises each media kind §5.6's handlers actually land in the inbox", () => {
    expect(hasAttachment({ photo: [{}, {}] })).toBe(true);
    expect(hasAttachment({ document: {} })).toBe(true);
    expect(hasAttachment({ video: {} })).toBe(true);
    expect(hasAttachment({ audio: {} })).toBe(true);
    expect(hasAttachment({ video_note: {} })).toBe(true);
  });

  test("an empty photo array is not an attachment", () => {
    // Telegram sends one entry per resolution; an empty array carries nothing to download.
    expect(hasAttachment({ photo: [] })).toBe(false);
  });

  test("service messages and unhandled kinds are not attachments", () => {
    // These previously fell through to `if (!message.text) return` and must keep doing so.
    expect(hasAttachment({})).toBe(false);
    expect(hasAttachment({ forum_topic_created: {} } as never)).toBe(false);
    expect(hasAttachment({ pinned_message: {} } as never)).toBe(false);
    expect(hasAttachment({ new_chat_members: [{}] } as never)).toBe(false);
    expect(hasAttachment({ sticker: {} } as never)).toBe(false);
    expect(hasAttachment({ poll: {} } as never)).toBe(false);
  });
});
