import { describe, expect, test } from "bun:test";
import { buildContextPrefix } from "../src/message-context.ts";

describe("buildContextPrefix", () => {
  test("neither forwarded nor a reply - empty string", () => {
    expect(buildContextPrefix({})).toBe("");
  });

  test("forwarded from a user with a username", () => {
    const prefix = buildContextPrefix({ forward_origin: { type: "user", sender_user: { username: "alice", first_name: "Alice" } } });
    expect(prefix).toBe("[Forwarded from @alice]\n\n");
  });

  test("forwarded from a user with no username falls back to first name", () => {
    const prefix = buildContextPrefix({ forward_origin: { type: "user", sender_user: { first_name: "Bob" } } });
    expect(prefix).toBe("[Forwarded from Bob]\n\n");
  });

  test("forwarded from a user with neither username nor first name", () => {
    const prefix = buildContextPrefix({ forward_origin: { type: "user", sender_user: {} } });
    expect(prefix).toBe("[Forwarded from someone]\n\n");
  });

  test("forwarded from a privacy-hidden user uses their display name", () => {
    const prefix = buildContextPrefix({ forward_origin: { type: "hidden_user", sender_user_name: "Carol" } });
    expect(prefix).toBe("[Forwarded from Carol]\n\n");
  });

  test("forwarded from a chat or channel prefers title, falls back to username", () => {
    expect(buildContextPrefix({ forward_origin: { type: "chat", sender_chat: { title: "Ops Group" } } })).toBe("[Forwarded from Ops Group]\n\n");
    expect(buildContextPrefix({ forward_origin: { type: "chat", sender_chat: { username: "opsgroup" } } })).toBe("[Forwarded from opsgroup]\n\n");
    expect(buildContextPrefix({ forward_origin: { type: "channel", chat: { title: "Announcements" } } })).toBe("[Forwarded from Announcements]\n\n");
  });

  test("a reply quotes the earlier message's text", () => {
    const prefix = buildContextPrefix({ reply_to_message: { message_id: 42, text: "the build is failing on main" } });
    expect(prefix).toBe('[Replying to an earlier message: "the build is failing on main"]\n\n');
  });

  test("a reply to media with a caption quotes the caption", () => {
    const prefix = buildContextPrefix({ reply_to_message: { message_id: 42, caption: "see this screenshot" } });
    expect(prefix).toBe('[Replying to an earlier message: "see this screenshot"]\n\n');
  });

  test("a reply to media with no text/caption says so rather than showing nothing", () => {
    const prefix = buildContextPrefix({ reply_to_message: { message_id: 42 } });
    expect(prefix).toBe("[Replying to an earlier message with no text/caption]\n\n");
  });

  test("a long quoted message is truncated to the preview length", () => {
    const longText = "x".repeat(300);
    const prefix = buildContextPrefix({ reply_to_message: { message_id: 42, text: longText } });
    expect(prefix).toContain("x".repeat(200));
    expect(prefix).not.toContain("x".repeat(201));
    expect(prefix).toContain("…");
  });

  test("forwarded AND a reply at once stacks both lines", () => {
    const prefix = buildContextPrefix({
      forward_origin: { type: "hidden_user", sender_user_name: "Carol" },
      reply_to_message: { message_id: 42, text: "earlier point" },
    });
    expect(prefix).toBe('[Forwarded from Carol]\n[Replying to an earlier message: "earlier point"]\n\n');
  });
});
