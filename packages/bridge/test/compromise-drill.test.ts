import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "bun:test";
import { PermissionRegistry, sweepExpiredPermissions } from "../src/permission-registry.ts";
import { startPolling, TelegramClient, validateTokens } from "../src/telegram.ts";
import type { TelegramUpdate } from "../src/telegram.ts";
import type { VerdictBehavior } from "@aibridge/protocol";

/**
 * §13 check 8, the compromise drill: **revoke the control bot token and confirm the fleet fails
 * closed** - sessions keep running locally, no Telegram control, no silent auto-approvals, and the
 * feed bot alone cannot approve anything.
 *
 * The check is specified as manual because revoking a token is a BotFather step no script can
 * perform. But §13's own standing lesson is that a check is scriptable until a physical or
 * credential-level step proves otherwise, and only *one* step here is credential-level. What a
 * revoked token actually does to the Bridge is an ordinary, reproducible HTTP condition: every Bot
 * API call answers `401 {"ok":false,"error_code":401,"description":"Unauthorized"}`. That is what
 * `revokedTelegram()` below serves, so the four fail-closed claims can be measured on every run
 * rather than once, by hand, on the day someone remembers to try it.
 *
 * What this leaves genuinely manual: confirming that BotFather's revocation produces exactly that
 * 401 (rather than, say, a 404 or a silent 200 with an empty update list), and that the operator's
 * own recovery path works. Those need the real credential. Everything below is the part that would
 * otherwise be asserted by reasoning alone.
 *
 * The pre-existing tests this deliberately does *not* duplicate: `telegram.test.ts` already covers
 * `validateTokens` rejecting a bad token via a hand-rolled rejecting `GetMeSource`, and
 * `permission-registry.test.ts` already covers `sweepExpiredPermissions` sending a deny. Neither
 * goes through a real 401 response, and nothing anywhere covered a *running* poll loop whose token
 * is revoked mid-flight, which is the actual shape of a compromise.
 */

/** A stand-in for Telegram after the token has been revoked. `flip()` switches a healthy server to
 * the revoked one in place, so a poll loop can be running and *then* lose its token, which is the
 * order a real compromise happens in - as opposed to never having had a valid one. */
function revokedTelegram(startRevoked: boolean): {
  baseUrl: string;
  flip: () => void;
  calls: () => number;
  stop: () => void;
} {
  let revoked = startRevoked;
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (revoked) {
      // Telegram's real shape for a revoked/invalid token, verified against the Bot API docs: a 401
      // with an `ok: false` envelope. Both halves matter - a client that only checked the HTTP
      // status, or only the envelope, would still pass one of them.
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    const url = req.url ?? "";
    if (url.includes("/getMe")) {
      res.end(JSON.stringify({ ok: true, result: { id: 1, username: "control_bot" } }));
      return;
    }
    // A healthy but idle getUpdates: no updates, so the loop keeps polling without side effects.
    res.end(JSON.stringify({ ok: true, result: [] }));
  });
  server.listen(0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    flip: () => {
      revoked = true;
    },
    calls: () => calls,
    stop: () => server.close(),
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
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

describe("§13 check 8 - compromise drill: the fleet fails closed on a revoked control token", () => {
  test("claim 1 of 4: a revoked token is refused at boot, naming which token it was", async () => {
    const telegram = revokedTelegram(true);
    try {
      const controlBot = new TelegramClient("revoked-control-token", telegram.baseUrl);
      const feedBot = new TelegramClient("revoked-feed-token", telegram.baseUrl);

      // Through a real 401 response, not a stubbed rejection: this is what proves the client treats
      // Telegram's own revoked-token envelope as a failure rather than parsing `{ok:false}` as a
      // result and carrying on with an undefined username.
      await expect(validateTokens(controlBot, feedBot)).rejects.toThrow(/CONTROL_BOT_TOKEN is invalid/);
    } finally {
      telegram.stop();
    }
  });

  test("claim 2 of 4: revoking mid-flight stops Telegram control without stopping the daemon", async () => {
    const telegram = revokedTelegram(false);
    try {
      const controlBot = new TelegramClient("control-token", telegram.baseUrl);
      await validateTokens(controlBot, controlBot);

      const updates: TelegramUpdate[] = [];
      const errors: unknown[] = [];
      const stop = startPolling(controlBot, {
        timeoutSec: 1,
        retryDelayMs: 5,
        maxRetryDelayMs: 20,
        onUpdate: (u) => updates.push(u),
        onError: (err) => errors.push(err),
      });

      // Healthy first, so this is a loop that was working and then lost its token.
      await waitFor(() => telegram.calls() >= 1);
      telegram.flip();

      // The load-bearing assertion is not that it errors - it is that it *keeps going*. A poll loop
      // that threw out of its own async body here would take the whole Bridge down through
      // index.ts's `unhandledRejection` handler, turning a revoked token into a dead daemon: every
      // live session killed with the process, which is failing open in the worst direction (no
      // supervision, no crash-resume, no way to say so).
      await waitFor(() => errors.length >= 3);
      const callsAfterRevocation = telegram.calls();
      await waitFor(() => telegram.calls() > callsAfterRevocation);

      stop();

      // No Telegram control: nothing was delivered as an update, so no command, no button tap, and
      // no callback query can reach any handler.
      expect(updates).toEqual([]);
      expect(errors.length).toBeGreaterThanOrEqual(3);
    } finally {
      telegram.stop();
    }
  });

  test("claim 3 of 4: a permission left pending by an unreachable operator resolves to deny, never allow", () => {
    // The crux of "no silent auto-approvals". With the control token revoked, a permission card is
    // posted (or not) but can never be *tapped* - so the only thing that can still resolve the
    // request is the TTL sweep. If that resolved to allow, or resolved to nothing at all while
    // telling the channel server it had succeeded, a compromise would silently become an approval.
    // An advancing clock, not a frozen one: `add` stamps `createdAt` from this same function, so a
    // clock that never moves makes the entry permanently zero milliseconds old and the sweep finds
    // nothing - which is a test that passes for the wrong reason if the assertion is written the
    // other way round. The TTL is a real 30 minutes here rather than a token 1ms, so what is being
    // asserted is the actual production window elapsing.
    let clockMs = 0;
    const registry = new PermissionRegistry({ ttlMs: 30 * 60 * 1000, now: () => clockMs });
    registry.add({
      requestId: "aaaaa",
      slug: "fix-bug",
      toolName: "Bash",
      description: "git push",
      inputPreview: '{"command":"git push origin main"}',
      topicId: 7,
      messageId: 11,
    });

    const verdicts: Array<{ slug: string; requestId: string; behavior: VerdictBehavior }> = [];
    const resolved: string[] = [];

    // Before the TTL, nothing resolves at all: an unreachable operator must not cause an early
    // verdict in *either* direction while the request is still legitimately outstanding.
    clockMs = 29 * 60 * 1000;
    sweepExpiredPermissions(registry, (slug, requestId, behavior) => verdicts.push({ slug, requestId, behavior }), async () => {}, (slug) => resolved.push(slug), () => {});
    expect(verdicts).toEqual([]);
    expect(registry.get("aaaaa")).toBeDefined();

    // Past it, the only resolution available is the sweep's, and it denies.
    clockMs = 31 * 60 * 1000;
    sweepExpiredPermissions(registry, (slug, requestId, behavior) => verdicts.push({ slug, requestId, behavior }), async () => {}, (slug) => resolved.push(slug), () => {});

    expect(verdicts).toEqual([{ slug: "fix-bug", requestId: "aaaaa", behavior: "deny" }]);
    expect(resolved).toEqual(["fix-bug"]);
    // And the entry is gone, so a tap arriving later from a restored token cannot re-resolve it into
    // an approval of a request the session has already been told was denied.
    expect(registry.get("aaaaa")).toBeUndefined();
  });

  test("claim 4 of 4: only the control bot ever polls, so the feed token is not a second way in", async () => {
    // The feed bot is send-only by construction (§2.1): it exists to post activity, and every
    // approval path - the permission card, its keyboard, `answerCallbackQuery`, and the verdict -
    // runs on the control bot. This is what makes revoking *only* the control token sufficient.
    //
    // The mechanism is narrow enough to state exactly: an approval is a tap, a tap arrives as a
    // `callback_query` update, and updates only ever arrive through `getUpdates`. So "the feed bot
    // alone cannot approve anything" reduces to "nothing polls the feed token" - and the regression
    // that would break it is somebody adding a second `startPolling` call.
    //
    // Asserted against the composition root's source rather than its behaviour, deliberately, and it
    // is worth being explicit about why: `index.ts` is a `main()` with real side effects (two live
    // tokens, a SQLite file, a PTY spawn) and nothing in this suite stands it up. The alternative
    // was a test that constructs its own poller and asserts it polls what it was told to, which
    // cannot fail for the right reason - it would restate the wiring instead of checking it. A
    // source-level assertion is cruder, but it fails exactly when the invariant is actually broken.
    const indexSource = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const pollerCalls = [...indexSource.matchAll(/startPolling\(\s*(\w+)/g)].map((m) => m[1]);

    expect(pollerCalls).toEqual(["controlBot"]);

    // And the feed client is a perfectly working client - the point is not that it is broken, but
    // that nothing it can do constitutes an approval.
    const telegram = revokedTelegram(false);
    try {
      const feedBot = new TelegramClient("feed-token", telegram.baseUrl);
      await expect(feedBot.getMe()).resolves.toMatchObject({ username: "control_bot" });
    } finally {
      telegram.stop();
    }
  });
});
