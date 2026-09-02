import { createServer } from "node:net";
import { describe, expect, test } from "bun:test";
import { StubTelegramServer } from "@aibridge/stub-telegram";
import { RateLimitedError } from "../src/rate-governor.ts";
import { awaitTokenValidation, buildTopicDeepLink, fetchWithTimeout, isTransportFailure, startPolling, TelegramClient, validateTokens } from "../src/telegram.ts";
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

describe("buildTopicDeepLink", () => {
  // The `/new`-confirmation "open this session" button's whole mechanism: a t.me/c/ link straight
  // into a forum topic, confirmed against Telegram's own deep-link docs (core.telegram.org/api/links).
  test("strips the Bot API's -100 supergroup prefix and appends the topic id", () => {
    expect(buildTopicDeepLink("-1004470540564", 37)).toBe("https://t.me/c/4470540564/37");
  });

  test("accepts a numeric chat id the same way", () => {
    expect(buildTopicDeepLink(-1004470540564, 37)).toBe("https://t.me/c/4470540564/37");
  });

  // A malformed/unexpected config value should produce an obviously-broken link (easy for the
  // operator to notice: a "-" mid-URL) rather than a silently wrong one that just doesn't work.
  test("leaves a chat id that doesn't start with -100 unmangled, rather than guessing", () => {
    expect(buildTopicDeepLink("-4470540564", 37)).toBe("https://t.me/c/-4470540564/37");
  });
});

describe("fetchWithTimeout", () => {
  // Found live 2026-08-06: every Telegram call used a bare `fetch` with no client-side timeout,
  // so one stalled connection could wedge the whole per-origin connection pool - including
  // `getUpdates` and every other outbound call - with the Bridge process staying alive and
  // "Responding" the entire time. This spins a real TCP server that accepts the connection and
  // then never writes a response, the exact shape of a stalled socket, and checks the timeout
  // actually fires rather than hanging forever.
  test("rejects with a named timeout instead of hanging on a stalled connection", async () => {
    const server = createServer((socket) => {
      // Deliberately never write a response or close the socket.
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      await expect(fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 200)).rejects.toThrow(/timed out after 200ms/);
    } finally {
      server.close();
    }
  });

  // Found during the /deep-check sweep: the first fix cleared the timer as soon as fetch()
  // resolved - i.e. as soon as headers arrived - not once the body was actually read. A connection
  // that sends headers and then stalls mid-body reproduced the exact unbounded hang this function
  // exists to prevent, just one phase later. This server writes real HTTP headers (with a
  // Content-Length promising a body) and then never writes that body.
  test("rejects with a named timeout when headers arrive but the body then stalls", async () => {
    const server = createServer((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n");
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 200);
      await expect(res.json()).rejects.toThrow(/timed out after 200ms while reading the response body/);
    } finally {
      server.close();
    }
  });

  test("a fast server resolves normally, unaffected by the timeout budget", async () => {
    const stub = new StubTelegramServer();
    const { baseUrl } = stub.start(0);
    try {
      const res = await fetchWithTimeout(`${baseUrl}/botcontrol-token/getMe`, {}, 5000);
      expect(res.ok).toBe(true);
    } finally {
      stub.stop();
    }
  });
});

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

  // The wording is what sent a real diagnosis to the wrong place on 2026-09-02: an unreachable
  // Telegram was reported as "CONTROL_BOT_TOKEN is invalid", which reads as "go to BotFather".
  test("says unreachable, not invalid, when the network is down", async () => {
    const down: GetMeSource = { getMe: async () => { throw new TypeError("fetch failed"); } };
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    await expect(validateTokens(down, ok)).rejects.toThrow(/CONTROL_BOT_TOKEN could not be validated - Telegram is unreachable/);
  });

  // Both fail at once whenever the host is offline, so the "which failure do we report" tiebreak
  // isn't hypothetical: reporting the transport half of this pair would send a revoked feed token
  // into awaitTokenValidation's retry loop forever instead of refusing to boot.
  test("a real rejection wins over a transport failure when both tokens fail", async () => {
    const down: GetMeSource = { getMe: async () => { throw new TypeError("fetch failed"); } };
    const revoked: GetMeSource = { getMe: async () => { throw new Error("Telegram getMe failed: Unauthorized"); } };
    await expect(validateTokens(down, revoked)).rejects.toThrow(/FEED_BOT_TOKEN is invalid/);
  });
});

describe("isTransportFailure", () => {
  test("recognises undici's opaque wrapper and fetchWithTimeout's own aborts", () => {
    expect(isTransportFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isTransportFailure(new Error("Telegram request timed out after 20000ms: https://api.telegram.org/x"))).toBe(true);
    expect(isTransportFailure(new Error("Telegram request timed out after 20000ms while reading the response body: https://x"))).toBe(true);
  });

  // Not a synthetic shape: measured on this host 2026-09-02. Bun reports a refused connection AND a
  // DNS failure identically, with neither `fetch failed` nor an errno code - so a Node-only
  // classifier calls every Bun network failure an invalid token. That matters because a `/restart`
  // from Telegram respawns the Bridge under `bun run`, not Node (scripts/dev-bridge.sh's own note).
  test("recognises Bun's connect failure, which shares nothing with Node's", () => {
    const bunErr = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
    expect(isTransportFailure(bunErr)).toBe(true);
    // Either half alone is enough - Bun's code strings aren't a documented stable API, and the
    // message is prose that could be reworded; a miss here is a fatal misdiagnosis, not a warning.
    expect(isTransportFailure(new Error("Unable to connect. Is the computer able to access the url?"))).toBe(true);
    expect(isTransportFailure(Object.assign(new Error("reworded by a future Bun"), { code: "ConnectionRefused" }))).toBe(true);
  });

  // The live version of the test above, and the one that cannot rot: it asks the *actual* runtime
  // running this suite what a dead endpoint looks like, through the real client. If Bun (or Node)
  // ever changes its error shape, this fails instead of the Bridge silently regaining the
  // fatal-exit-on-boot bug.
  test("classifies a real dead endpoint on whatever runtime is running this suite", async () => {
    // Port 9 (discard) with nothing bound: refused immediately, no timeout, no network needed.
    const client = new TelegramClient("tok", "http://127.0.0.1:9");
    let thrown: unknown;
    try {
      await client.getMe();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(isTransportFailure(thrown)).toBe(true);
  });

  test("digs the real code out of a nested cause chain", () => {
    const err = new TypeError("fetch failed", { cause: new Error("boom", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) }) });
    expect(isTransportFailure(err)).toBe(true);
  });

  // The load-bearing half. §13 check 8 / compromise-drill claim 1: a revoked token must refuse to
  // boot, and it only stays fatal for as long as this returns false for it.
  test("a revoked token is NOT transport, however it is phrased", () => {
    expect(isTransportFailure(new Error("Telegram getMe failed: Unauthorized"))).toBe(false);
    expect(isTransportFailure(new Error("401 Unauthorized"))).toBe(false);
    expect(isTransportFailure(new Error("Telegram getMe failed: Not Found"))).toBe(false);
  });

  // Telegram's own side failing is not a verdict on the token. Both shapes measured: a 5xx with a
  // JSON envelope, and a captive portal / proxy answering with HTML, which makes res.json() throw a
  // SyntaxError whose wording differs per runtime and so can never be matched on text.
  test("Telegram's own 5xx and a non-JSON body are transport, not a bad token", async () => {
    // Driven through a real server so the whole getMe -> parseTelegramResponse path runs, rather
    // than a hand-built Response that skips fetchWithTimeout's body-read wrapper.
    const { createServer } = await import("node:http");
    for (const [status, body, type] of [
      [502, "<html>502 Bad Gateway</html>", "text/html"],
      [500, JSON.stringify({ ok: false, description: "Internal Server Error" }), "application/json"],
    ] as const) {
      const server = createServer((_req, res) => { res.writeHead(status, { "content-type": type }); res.end(body); });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      try {
        let thrown: unknown;
        try { await new TelegramClient("tok", `http://127.0.0.1:${port}`).getMe(); } catch (err) { thrown = err; }
        expect(thrown).toBeDefined();
        expect(isTransportFailure(thrown)).toBe(true);
      } finally {
        server.close();
      }
    }
  });

  // res.json() is happy with the JSON literal `null`; reading .ok off it would throw a TypeError
  // from inside a response handler, which then reaches the boot classifier as "not transport".
  test("a body that parses but isn't a Bot API envelope is transport, not a crash", async () => {
    const { createServer } = await import("node:http");
    for (const body of ["null", '"just a string"', "[1,2,3]"]) {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      try {
        let thrown: unknown;
        try { await new TelegramClient("tok", `http://127.0.0.1:${port}`).getMe(); } catch (err) { thrown = err; }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).name).not.toBe("TypeError");
        expect(isTransportFailure(thrown)).toBe(true);
      } finally {
        server.close();
      }
    }
  });

  // The boundary that keeps §13 check 8 intact: 401 is a verdict, 500 is an outage.
  test("a 401 stays fatal even though a 500 does not", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      let thrown: unknown;
      try { await new TelegramClient("revoked", `http://127.0.0.1:${port}`).getMe(); } catch (err) { thrown = err; }
      expect(isTransportFailure(thrown)).toBe(false);
    } finally {
      server.close();
    }
  });

  // Conservative by construction: an error shape it doesn't recognise stays fatal rather than
  // being retried forever with nobody able to see it.
  test("an unrecognised failure is not treated as transport", () => {
    expect(isTransportFailure(new Error("something else entirely"))).toBe(false);
    expect(isTransportFailure("fetch failed but as a string")).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
  });

  test("does not match a message that merely mentions fetch failing", () => {
    expect(isTransportFailure(new Error("Telegram getMe failed: fetch failed on their side"))).toBe(false);
  });
});

describe("awaitTokenValidation", () => {
  // Exactly 0, on the real clock, not "small": index.ts branches on `> 0` to decide whether to post
  // an "the fleet was dark" card, so timing the happy path would fire that card on a clean boot
  // whenever Date.now() happened to tick during the call.
  test("returns exactly zero, with no wait, when the first attempt succeeds", async () => {
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    const slept: number[] = [];
    const waitedMs = await awaitTokenValidation(ok, ok, { sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([]);
    expect(waitedMs).toBe(0);
  });

  // The 2026-09-02 scenario end to end: unreachable at logon, reachable some minutes later.
  test("waits out an unreachable Telegram and comes up when it returns", async () => {
    let attempts = 0;
    // Distinct from the feed source on purpose: each attempt calls getMe once per token, so a
    // single shared double counts two calls per round and quietly halves the round count.
    const flaky: GetMeSource = {
      getMe: async () => {
        attempts += 1;
        if (attempts <= 4) throw new TypeError("fetch failed");
        return { id: 1, username: "ok" };
      },
    };
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    const slept: number[] = [];
    const waiting: number[] = [];
    let clock = 0;
    const waitedMs = await awaitTokenValidation(flaky, ok, {
      retryDelayMs: 1000,
      maxRetryDelayMs: 4000,
      sleep: async (ms) => { slept.push(ms); clock += ms; },
      now: () => clock,
      onWaiting: (_err, attempt) => waiting.push(attempt),
    });
    // Doubling, capped - the same shape startPolling uses, so a sustained outage settles at the cap
    // rather than either hammering the endpoint or backing off without bound.
    expect(slept).toEqual([1000, 2000, 4000, 4000]);
    expect(waiting).toEqual([1, 2, 3, 4]);
    expect(waitedMs).toBe(11_000);
  });

  // The one piece of evidence the tests above cannot provide: everything else in this describe
  // block drives `awaitTokenValidation` with a mocked `GetMeSource` and a fake clock, which proves
  // the retry *logic* but never touches a real socket. `fetchWithTimeout`'s own doc comment
  // (telegram.ts) explains the specific risk that leaves open: Node/Bun pool connections per
  // origin, and one earlier version of that pooling left an indefinitely-stalled request wedging
  // every later call to the same origin, with the process staying alive throughout. A classifier
  // that is correct on paper is not evidence the *pool* recovers - only a real down-to-up
  // transition, on the real runtime's real fetch, is. This is the permanent form of a check that
  // was run by hand and its script discarded on 2026-09-02: a real `TelegramClient` against a port
  // nothing is listening on yet, brought up mid-wait by an actual `http` server.
  test("a real socket that starts refused and comes up mid-wait is not left wedged", async () => {
    const { createServer } = await import("node:http");
    // Reserve a free port by briefly binding and releasing it, so the client's first few attempts
    // hit a real, immediate ECONNREFUSED (nothing listening) rather than a synthetic one.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const client = new TelegramClient("tok", `http://127.0.0.1:${port}`);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { id: 1, username: "late_bot" } }));
    });
    const bringUpAfterMs = 300;
    const startedAt = Date.now();
    setTimeout(() => server.listen(port, "127.0.0.1"), bringUpAfterMs);
    try {
      const waitedMs = await awaitTokenValidation(client, client, { retryDelayMs: 100, maxRetryDelayMs: 100 });
      // Real elapsed time, not a fake clock - loose bounds because this is a real timer racing a
      // real socket, not the deterministic sleeps used everywhere else in this file.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(bringUpAfterMs);
      expect(waitedMs).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  // A blackholed network spends the whole timeout inside each getMe rather than in the sleeps, so
  // timing from the failure would drop a full timeout from the total. index.ts subtracts this from
  // the deploy-marker clock, and an undercount there is a good /merge rolled back.
  test("counts time spent inside the failing call, not just the sleeps between them", async () => {
    let clock = 0;
    let attempts = 0;
    const blackholed: GetMeSource = {
      getMe: async () => {
        attempts += 1;
        clock += 20_000; // the full DEFAULT_TIMEOUT_MS, as a stalled connection would burn
        if (attempts <= 2) throw new Error("Telegram request timed out after 20000ms: https://x");
        return { id: 1, username: "ok" };
      },
    };
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    const waitedMs = await awaitTokenValidation(blackholed, ok, {
      retryDelayMs: 1000,
      maxRetryDelayMs: 1000,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    // Three calls of 20s plus two 1s sleeps - all of it offline. Timing from the first *failure*
    // instead would report 42s, silently losing the first 20s.
    expect(waitedMs).toBe(62_000);
  });

  test("reports the elapsed wait so the caller can say the fleet was dark", async () => {
    let attempts = 0;
    const flaky: GetMeSource = {
      getMe: async () => {
        attempts += 1;
        if (attempts <= 2) throw new TypeError("fetch failed");
        return { id: 1, username: "ok" };
      },
    };
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    let clock = 1_000_000;
    const waitedMs = await awaitTokenValidation(flaky, ok, {
      retryDelayMs: 60_000,
      maxRetryDelayMs: 60_000,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    expect(waitedMs).toBe(120_000);
  });

  // §13 check 8's fail-closed guarantee, at the one call site that could quietly undo it.
  test("a revoked token throws on the first attempt instead of being retried", async () => {
    let attempts = 0;
    const revoked: GetMeSource = {
      getMe: async () => { attempts += 1; throw new Error("Telegram getMe failed: Unauthorized"); },
    };
    const ok: GetMeSource = { getMe: async () => ({ id: 1, username: "ok" }) };
    const slept: number[] = [];
    await expect(awaitTokenValidation(revoked, ok, { sleep: async (ms) => { slept.push(ms); } }))
      .rejects.toThrow(/CONTROL_BOT_TOKEN is invalid/);
    expect(attempts).toBe(1);
    expect(slept).toEqual([]);
  });

  test("a revoked token behind an unreachable one is still fatal, not retried", async () => {
    const down: GetMeSource = { getMe: async () => { throw new TypeError("fetch failed"); } };
    const revoked: GetMeSource = { getMe: async () => { throw new Error("Telegram getMe failed: Unauthorized"); } };
    const slept: number[] = [];
    await expect(awaitTokenValidation(down, revoked, { sleep: async (ms) => { slept.push(ms); } }))
      .rejects.toThrow(/FEED_BOT_TOKEN is invalid/);
    expect(slept).toEqual([]);
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

  test("a throwing onUpdate is reported via onUpdateError, not onError, and does not stop the rest of the batch from running (§9, found live 2026-08-09)", async () => {
    const batches: TelegramUpdate[][] = [[{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }], []];
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
    const received: number[] = [];
    const errors: unknown[] = [];
    const updateErrors: Array<{ updateId: number; err: unknown }> = [];
    const stop = startPolling(source, {
      onUpdate: (u) => {
        received.push(u.update_id);
        if (u.update_id === 2) throw new Error("handler blew up");
      },
      onError: (e) => errors.push(e),
      onUpdateError: (u, err) => updateErrors.push({ updateId: u.update_id, err }),
      retryDelayMs: 5,
    });

    await waitFor(() => received.length >= 3);
    stop();

    // Every update in the batch still ran, including the ones after the failing one.
    expect(received).toEqual([1, 2, 3]);
    // Reported through the update-specific channel, not misattributed to a transport failure.
    expect(errors).toEqual([]);
    expect(updateErrors).toEqual([{ updateId: 2, err: new Error("handler blew up") }]);
  });

  test("consecutive getUpdates failures back off exponentially, capped at maxRetryDelayMs, and reset after a success", async () => {
    // Real timers, small values - measures the actual wall-clock gap between call attempts rather
    // than intercepting `setTimeout` globally (this file's own fakes already use real timers for
    // every other startPolling test, and a global monkeypatch would also catch unrelated timers -
    // this loop's own successful-poll delay, `waitFor`'s internal polling, ... - producing noise
    // instead of a signal).
    let calls = 0;
    const callTimestamps: number[] = [];
    const source: UpdatesSource = {
      getUpdates: async () => {
        callTimestamps.push(Date.now());
        calls++;
        if (calls <= 4) throw new Error("still down");
        if (calls === 5) return [{ update_id: 1 }];
        // Same microtask-starvation care the other tests in this file already document: a fake
        // that resolves instantly forever turns the loop into a busy-spin that starves the event
        // loop's timer phase, hanging `waitFor`'s own polling indefinitely.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [];
      },
    };
    const received: number[] = [];
    const stop = startPolling(source, {
      onUpdate: (u) => received.push(u.update_id),
      retryDelayMs: 20,
      maxRetryDelayMs: 60,
    });
    await waitFor(() => received.length >= 1);
    stop();

    // At least the 5 attempts this test cares about - `stop()` can't interrupt an in-flight 6th
    // call already started by the time `waitFor` notices the 5th succeeded.
    expect(callTimestamps.length).toBeGreaterThanOrEqual(5);
    const gaps = callTimestamps.slice(1, 5).map((t, i) => t - callTimestamps[i]!);
    // 20, 40, 60 (would be 80, capped), 60 (capped again) - asserted as a floor rather than an exact
    // value, since real timers are never perfectly precise, but the doubling-then-capped shape must
    // hold: each gap is at least its expected floor, and the 3rd/4th never grow past the cap.
    expect(gaps[0]).toBeGreaterThanOrEqual(15);
    expect(gaps[1]).toBeGreaterThanOrEqual(35);
    expect(gaps[2]).toBeGreaterThanOrEqual(55);
    expect(gaps[2]).toBeLessThan(100); // capped at 60 (+jitter), nowhere near an uncapped 80
    expect(gaps[3]).toBeGreaterThanOrEqual(55);
    expect(gaps[3]).toBeLessThan(100); // still capped, not still doubling toward 160
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

  test("deleteMessage forwards the message_id to Telegram", async () => {
    const stub = new StubTelegramServer();
    const { baseUrl } = stub.start(0);
    try {
      const client = new TelegramClient("control-token", baseUrl);
      await client.deleteMessage(-1, 42);
      expect(stub.getDeletedMessageIds("control-token")).toEqual([42]);
    } finally {
      stub.stop();
    }
  });

  test("§5.4: a real 429 becomes a RateLimitedError carrying the response's own retry_after", async () => {
    const stub = new StubTelegramServer();
    const { baseUrl } = stub.start(0);
    try {
      const client = new TelegramClient("control-token", baseUrl);
      stub.force429("control-token", "sendMessage", 7);
      let caught: unknown;
      try {
        await client.sendMessage(-1, 3, "hello");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RateLimitedError);
      expect((caught as InstanceType<typeof RateLimitedError>).retryAfterSec).toBe(7);
    } finally {
      stub.stop();
    }
  });

  test("a non-429 failure (e.g. sendChatAction - not implemented by the stub) stays a plain Error, not RateLimitedError", async () => {
    const stub = new StubTelegramServer();
    const { baseUrl } = stub.start(0);
    try {
      const client = new TelegramClient("control-token", baseUrl);
      let caught: unknown;
      try {
        await client.sendChatAction(-1, 3, "typing");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(RateLimitedError);
    } finally {
      stub.stop();
    }
  });

  test("§5.5: sendDocument uploads the details log as a real file, not inline text", async () => {
    const stub = new StubTelegramServer();
    const { baseUrl } = stub.start(0);
    try {
      const client = new TelegramClient("control-token", baseUrl);
      const content = "line 1\nline 2\nline 3";
      await client.sendDocument(-1, 3, "session-turn1-details.txt", content);
      const sent = stub.getSent("control-token")[0];
      expect(sent).toMatchObject({ method: "sendDocument", chat_id: -1, message_thread_id: 3, text: content, filename: "session-turn1-details.txt" });
    } finally {
      stub.stop();
    }
  });

  test("voice-input: getFile resolves a file_id, downloadFile fetches the CDN bytes at that path", async () => {
    const stub = new StubTelegramServer();
    const { baseUrl } = stub.start(0);
    try {
      const client = new TelegramClient("control-token", baseUrl);
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      stub.presetFile("control-token", "voice-file-id-1", bytes);

      const { file_path } = await client.getFile("voice-file-id-1");
      expect(file_path).toBe("voice-file-id-1");

      const downloaded = await client.downloadFile(file_path);
      expect([...downloaded]).toEqual([1, 2, 3, 4, 5]);
    } finally {
      stub.stop();
    }
  });

  test("downloadFile throws on a 404 (no such path registered)", async () => {
    const stub = new StubTelegramServer();
    const { baseUrl } = stub.start(0);
    try {
      const client = new TelegramClient("control-token", baseUrl);
      await expect(client.downloadFile("nonexistent")).rejects.toThrow(/404/);
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
