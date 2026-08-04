import { describe, expect, test } from "bun:test";
import { StubTelegramServer } from "@aibridge/stub-telegram";
import { startPolling, TelegramClient, validateTokens } from "../src/telegram.ts";
import type { GetMeSource, TelegramUpdate, UpdatesSource } from "../src/telegram.ts";

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("validateTokens", () => {
  test("passes when both tokens resolve", async () => {
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    await expect(validateTokens(ok, ok)).resolves.toBeUndefined();
  });

  test("names the control token when it fails", async () => {
    const bad: GetMeSource = { getMe: async () => { throw new Error("401 Unauthorized"); } };
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    await expect(validateTokens(bad, ok)).rejects.toThrow(/CONTROL_BOT_TOKEN/);
  });

  test("names the feed token when it fails", async () => {
    const bad: GetMeSource = { getMe: async () => { throw new Error("401 Unauthorized"); } };
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    await expect(validateTokens(ok, bad)).rejects.toThrow(/FEED_BOT_TOKEN/);
  });
});

describe("startPolling", () => {
  test("advances the offset past the highest update_id seen", async () => {
    // A real long-poll only ever resolves empty after blocking for `timeout` seconds; a fake
    // that resolves empty instantly turns the loop into a microtask busy-spin that starves the
    // event loop's timer phase (this hung the test suite before the delay below was added).
    const batches: TelegramUpdate[][] = [[{ update_id: 10 }, { update_id: 11 }], []];
    const seenOffsets: number[] = [];
    const source: UpdatesSource = {
      getUpdates: async (offset) => {
        seenOffsets.push(offset);
        const batch = batches.shift();
        if (batch === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return [];
        }
        return batch;
      },
    };

    const received: number[] = [];
    const stop = startPolling(source, { onUpdate: (u) => received.push(u.update_id), retryDelayMs: 5 });

    await waitFor(() => received.length >= 2);
    await waitFor(() => (seenOffsets.at(-1) ?? 0) >= 12);
    stop();

    expect(received).toEqual([10, 11]);
    expect(seenOffsets[0]).toBe(0);
  });

  test("resumes from initialOffset instead of 0", async () => {
    const seenOffsets: number[] = [];
    const source: UpdatesSource = {
      getUpdates: async (offset) => {
        seenOffsets.push(offset);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [];
      },
    };
    const stop = startPolling(source, { initialOffset: 42, onUpdate: () => {}, retryDelayMs: 5 });
    await waitFor(() => seenOffsets.length >= 1);
    stop();
    expect(seenOffsets[0]).toBe(42);
  });

  test("onOffsetChange fires with the new offset before onUpdate, for every update", async () => {
    // §4.5.1: a restart triggered from inside onUpdate (e.g. /restart) must not race ahead of the
    // offset actually being persisted - this is the ordering that closes that race.
    const batches: TelegramUpdate[][] = [[{ update_id: 5 }], []];
    const source: UpdatesSource = {
      getUpdates: async () => {
        const batch = batches.shift();
        if (batch === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return [];
        }
        return batch;
      },
    };
    const order: string[] = [];
    const stop = startPolling(source, {
      onOffsetChange: (offset) => order.push(`offset:${offset}`),
      onUpdate: (u) => order.push(`update:${u.update_id}`),
      retryDelayMs: 5,
    });
    await waitFor(() => order.length >= 2);
    stop();
    expect(order).toEqual(["offset:6", "update:5"]);
  });

  test("a failed getUpdates call retries rather than crashing the loop", async () => {
    // Same microtask-starvation care as above: once past the induced failures, subsequent calls
    // must pace themselves like a real long-poll rather than resolving instantly forever.
    let calls = 0;
    const source: UpdatesSource = {
      getUpdates: async () => {
        calls++;
        if (calls < 3) throw new Error("network blip");
        if (calls === 3) return [{ update_id: 99 }];
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [];
      },
    };
    const errors: unknown[] = [];
    const received: number[] = [];
    const stop = startPolling(source, {
      onUpdate: (u) => received.push(u.update_id),
      onError: (e) => errors.push(e),
      retryDelayMs: 5,
    });

    await waitFor(() => received.length >= 1);
    stop();

    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(received).toEqual([99]);
  });

  test("delivers callback_query updates alongside message updates", async () => {
    const stub = new StubTelegramServer();
    const { baseUrl } = stub.start(0);
    try {
      const token = "control-token";
      const client = new TelegramClient(token, baseUrl);
      await validateTokens(client, client);

      const updates: TelegramUpdate[] = [];
      const stop = startPolling(client, { timeoutSec: 1, retryDelayMs: 5, onUpdate: (u) => updates.push(u) });

      stub.pushCallbackQuery(token, { chatId: -1, data: "run:builtin:compact", messageThreadId: 3 });
      await waitFor(() => updates.length >= 1);
      stop();

      expect(updates[0]?.callback_query).toMatchObject({ data: "run:builtin:compact" });
    } finally {
      stub.stop();
    }
  });
});

describe("TelegramClient", () => {
  test("answerCallbackQuery records the callback_query_id against the right token", async () => {
    const stub = new StubTelegramServer();
    const { baseUrl } = stub.start(0);
    try {
      const client = new TelegramClient("control-token", baseUrl);
      await client.answerCallbackQuery("42");
      expect(stub.getAnsweredCallbackQueries("control-token")).toEqual(["42"]);
    } finally {
      stub.stop();
    }
  });

  test("sendMessage forwards an inline keyboard as reply_markup", async () => {
    const stub = new StubTelegramServer();
    const { baseUrl } = stub.start(0);
    try {
      const client = new TelegramClient("control-token", baseUrl);
      const keyboard = { inline_keyboard: [[{ text: "/compact", callback_data: "run:builtin:compact" }]] };
      await client.sendMessage(-1, 3, "Available commands:", keyboard);
      expect(stub.getSent("control-token")[0]?.reply_markup).toEqual(keyboard);
    } finally {
      stub.stop();
    }
  });

  test("§4.2's topic lifecycle: createForumTopic, editForumTopic (rename-once), closeForumTopic (/kill), deleteForumTopic (/rm)", async () => {
    const stub = new StubTelegramServer();
    const { baseUrl } = stub.start(0);
    try {
      const client = new TelegramClient("control-token", baseUrl);
      const { message_thread_id } = await client.createForumTopic(-1, "fix the login bug");
      expect(stub.getTopic("control-token", message_thread_id)).toMatchObject({ name: "fix the login bug", closed: false, deleted: false });

      await client.editForumTopic(-1, message_thread_id, "renamed title");
      expect(stub.getTopic("control-token", message_thread_id)?.name).toBe("renamed title");

      await client.closeForumTopic(-1, message_thread_id);
      expect(stub.getTopic("control-token", message_thread_id)?.closed).toBe(true);

      await client.deleteForumTopic(-1, message_thread_id);
      expect(stub.getTopic("control-token", message_thread_id)?.deleted).toBe(true);
    } finally {
      stub.stop();
    }
  });
});
