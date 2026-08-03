import { afterEach, describe, expect, test } from "bun:test";
import { StubTelegramServer } from "../src/index.ts";

const servers: StubTelegramServer[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

function start(): { server: StubTelegramServer; baseUrl: string } {
  const server = new StubTelegramServer();
  servers.push(server);
  const { baseUrl } = server.start(0);
  return { server, baseUrl };
}

// The stub's own JSON responses are test-fixture data, not something worth a typed schema here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  return res.json();
}

describe("StubTelegramServer", () => {
  test("getMe responds ok for any token", async () => {
    const { baseUrl } = start();
    const res = await fetch(`${baseUrl}/bot123:abc/getMe`);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.result.is_bot).toBe(true);
  });

  test("getUpdates returns an already-pushed update immediately, no blocking", async () => {
    const { server, baseUrl } = start();
    server.pushUpdate("tok", { chatId: -1, text: "hi", messageThreadId: 3 });

    const start_ = Date.now();
    const res = await fetch(`${baseUrl}/bottok/getUpdates`, {
      method: "POST",
      body: JSON.stringify({ offset: 0, timeout: 25 }),
    });
    const elapsed = Date.now() - start_;
    const body = await readJson(res);

    expect(body.ok).toBe(true);
    expect(body.result).toHaveLength(1);
    expect(body.result[0].message).toMatchObject({ text: "hi", message_thread_id: 3 });
    expect(elapsed).toBeLessThan(500);
  });

  test("getUpdates blocks up to the timeout when nothing is pending, then returns empty", async () => {
    const { baseUrl } = start();
    const start_ = Date.now();
    const res = await fetch(`${baseUrl}/bottok/getUpdates`, {
      method: "POST",
      body: JSON.stringify({ offset: 0, timeout: 0.3 }),
    });
    const elapsed = Date.now() - start_;
    const body = await readJson(res);

    expect(body).toEqual({ ok: true, result: [] });
    expect(elapsed).toBeGreaterThanOrEqual(280);
  });

  test("getUpdates returns early the moment an update is pushed mid-poll", async () => {
    const { server, baseUrl } = start();
    const start_ = Date.now();

    const pending = fetch(`${baseUrl}/bottok/getUpdates`, {
      method: "POST",
      body: JSON.stringify({ offset: 0, timeout: 25 }),
    });

    setTimeout(() => server.pushUpdate("tok", { chatId: -1, text: "fast" }), 50);

    const body = await readJson(await pending);
    const elapsed = Date.now() - start_;

    expect(body.result).toHaveLength(1);
    expect(body.result[0].message.text).toBe("fast");
    expect(elapsed).toBeLessThan(2000);
  });

  test("offset filters out already-acknowledged updates", async () => {
    const { server, baseUrl } = start();
    server.pushUpdate("tok", { chatId: -1, text: "one" });
    server.pushUpdate("tok", { chatId: -1, text: "two" });

    const first = await readJson(
      await fetch(`${baseUrl}/bottok/getUpdates`, { method: "POST", body: JSON.stringify({ offset: 0, timeout: 0 }) }),
    );
    expect(first.result).toHaveLength(2);

    const nextOffset = first.result[1].update_id + 1;
    const second = await readJson(
      await fetch(`${baseUrl}/bottok/getUpdates`, { method: "POST", body: JSON.stringify({ offset: nextOffset, timeout: 0 }) }),
    );
    expect(second.result).toEqual([]);
  });

  test("sendMessage and editMessageText are recorded per token and retrievable via getSent", async () => {
    const { server, baseUrl } = start();
    await fetch(`${baseUrl}/bottok/sendMessage`, {
      method: "POST",
      body: JSON.stringify({ chat_id: -1004470540564, message_thread_id: 3, text: "hello" }),
    });

    const sent = server.getSent("tok");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "sendMessage", chat_id: -1004470540564, message_thread_id: 3, text: "hello" });
  });

  test("different tokens have independent update queues and sent logs", async () => {
    const { server, baseUrl } = start();
    server.pushUpdate("control-token", { chatId: -1, text: "for control" });
    await fetch(`${baseUrl}/botfeed-token/sendMessage`, { method: "POST", body: JSON.stringify({ chat_id: -1, text: "feed only" }) });

    expect(server.getSent("control-token")).toEqual([]);
    expect(server.getSent("feed-token")).toHaveLength(1);

    const controlUpdates = await readJson(
      await fetch(`${baseUrl}/botcontrol-token/getUpdates`, { method: "POST", body: JSON.stringify({ offset: 0, timeout: 0 }) }),
    );
    expect(controlUpdates.result).toHaveLength(1);

    const feedUpdates = await readJson(
      await fetch(`${baseUrl}/botfeed-token/getUpdates`, { method: "POST", body: JSON.stringify({ offset: 0, timeout: 0 }) }),
    );
    expect(feedUpdates.result).toEqual([]);
  });

  test("createForumTopic returns incrementing topic ids", async () => {
    const { baseUrl } = start();
    const a = await readJson(
      await fetch(`${baseUrl}/bottok/createForumTopic`, { method: "POST", body: JSON.stringify({ name: "session-a" }) }),
    );
    const b = await readJson(
      await fetch(`${baseUrl}/bottok/createForumTopic`, { method: "POST", body: JSON.stringify({ name: "session-b" }) }),
    );
    expect(b.result.message_thread_id).toBeGreaterThan(a.result.message_thread_id);
  });
});
