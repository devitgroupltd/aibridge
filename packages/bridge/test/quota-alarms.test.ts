import { describe, expect, test } from "bun:test";
import { createQuotaAlarms, DEFAULT_BURN_RATE_ALARM_COOLDOWN_MS, DEFAULT_BURN_RATE_THRESHOLD_USD } from "../src/quota-alarms.ts";
import { CostTracker } from "../src/cost-tracker.ts";
import { RateGovernor } from "../src/rate-governor.ts";
import { SessionStore, type SessionRow } from "../src/session-store.ts";

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "fix-bug",
    topicId: 2,
    sessionId: "sess-1",
    worktreePath: "c:\\data\\worktrees\\fix-bug",
    branch: "claude/fix-bug-1",
    repoPath: "c:\\data\\projects\\seowrite",
    model: "sonnet",
    ptyPid: 1234,
    state: "working",
    turnCardMsg: null,
    thinkingPlaceholderMsg: null,
    paused: false,
    renamed: false,
    feedDetail: "compact",
    feedVerbose: false,
    bypassPermission: false,
    autoAnswer: false,
    mode: "manual",
    createdUtc: "2026-08-03T00:00:00.000Z",
    lastEventUtc: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

function fakeControlBot() {
  const sent: Array<{ topicId: number | undefined; text: string }> = [];
  return {
    sendMessage: async (_chatId: unknown, topicId: number | undefined, text: string) => {
      sent.push({ topicId, text });
      return { message_id: sent.length };
    },
    sent,
  };
}

function setup(overrides: Partial<Parameters<typeof createQuotaAlarms>[0]> = {}) {
  const sessionStore = new SessionStore(":memory:");
  const costTracker = new CostTracker();
  const feedGovernor = new RateGovernor({ log: () => {} });
  const controlBot = fakeControlBot();
  const quotaAlarms = createQuotaAlarms({
    sessionStore,
    costTracker,
    feedGovernor,
    controlBot,
    supergroupChatId: "-100",
    ...overrides,
  });
  return { quotaAlarms, sessionStore, costTracker, controlBot };
}

describe("createQuotaAlarms", () => {
  test("slugForSessionId looks up the row by session id", () => {
    const { quotaAlarms, sessionStore } = setup();
    sessionStore.insert(row());
    expect(quotaAlarms.slugForSessionId("sess-1")).toBe("fix-bug");
    expect(quotaAlarms.slugForSessionId("no-such-session")).toBeUndefined();
  });

  test("markQuotaStopped transitions a working session to quota_stopped and posts a notice", async () => {
    const { quotaAlarms, sessionStore, controlBot } = setup();
    sessionStore.insert(row({ state: "working" }));

    quotaAlarms.markQuotaStopped("fix-bug");
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionStore.get("fix-bug")?.state).toBe("quota_stopped");
    expect(controlBot.sent.length).toBe(1);
    expect(controlBot.sent[0]?.text).toContain("usage limit");
  });

  test("markQuotaStopped is a no-op for an unknown slug", () => {
    const { quotaAlarms, controlBot } = setup();
    quotaAlarms.markQuotaStopped("no-such-slug");
    expect(controlBot.sent).toEqual([]);
  });

  test("markQuotaStopped is idempotent - a session already quota_stopped or dead is left alone", () => {
    const { quotaAlarms, sessionStore, controlBot } = setup();
    sessionStore.insert(row({ state: "quota_stopped" }));
    quotaAlarms.markQuotaStopped("fix-bug");
    expect(controlBot.sent).toEqual([]);

    sessionStore.setState("fix-bug", "dead", "2026-08-03T00:00:00.000Z");
    quotaAlarms.markQuotaStopped("fix-bug");
    expect(controlBot.sent).toEqual([]);
  });

  test("markQuotaStopped respects isValidTransition and skips a state with no valid path to quota_stopped", () => {
    const { quotaAlarms, sessionStore, controlBot } = setup();
    sessionStore.insert(row({ state: "starting" }));
    quotaAlarms.markQuotaStopped("fix-bug");
    expect(sessionStore.get("fix-bug")?.state).toBe("starting");
    expect(controlBot.sent).toEqual([]);
  });

  test("maybeFireBurnRateAlarm does nothing below the threshold", () => {
    const { quotaAlarms, costTracker, controlBot } = setup({ burnRateThresholdUsd: 10 });
    costTracker.record("sess-1", 1000, 5);
    quotaAlarms.maybeFireBurnRateAlarm(1000);
    expect(controlBot.sent).toEqual([]);
  });

  test("maybeFireBurnRateAlarm posts a fleet-wide breakdown once the threshold is crossed", async () => {
    // burnRateAlarmCooldownMs: 0 - lastBurnAlarmMs starts at 0, so with the real default cooldown
    // (1h) nowMs itself would first have to exceed it before the very first alarm could ever fire;
    // zeroing the cooldown isolates the threshold check this test is actually about.
    const { quotaAlarms, sessionStore, costTracker, controlBot } = setup({ burnRateThresholdUsd: 10, burnRateAlarmCooldownMs: 0 });
    sessionStore.insert(row({ slug: "fix-bug", sessionId: "sess-1" }));
    sessionStore.insert(row({ slug: "other", sessionId: "sess-2", topicId: 3 }));
    costTracker.record("sess-1", 1000, 8);
    costTracker.record("sess-2", 1000, 4);

    quotaAlarms.maybeFireBurnRateAlarm(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(controlBot.sent.length).toBe(1);
    expect(controlBot.sent[0]?.text).toContain("Burn-rate alarm");
    expect(controlBot.sent[0]?.text).toContain("fix-bug");
    expect(controlBot.sent[0]?.text).toContain("other");
  });

  test("maybeFireBurnRateAlarm respects the cooldown - a second crossing within the window doesn't re-notify", async () => {
    const { quotaAlarms, sessionStore, costTracker, controlBot } = setup({
      burnRateThresholdUsd: 10,
      burnRateAlarmCooldownMs: 1000,
    });
    sessionStore.insert(row());
    costTracker.record("sess-1", 0, 20);

    // lastBurnAlarmMs starts at 0, so the first call's own nowMs must already clear the cooldown -
    // 1000 is exactly the cooldown boundary (1000 - 0 is not < 1000).
    quotaAlarms.maybeFireBurnRateAlarm(1000);
    await Promise.resolve();
    await Promise.resolve();
    quotaAlarms.maybeFireBurnRateAlarm(1500); // still within the cooldown
    await Promise.resolve();
    expect(controlBot.sent.length).toBe(1);

    quotaAlarms.maybeFireBurnRateAlarm(2500); // cooldown elapsed - fires again
    await Promise.resolve();
    await Promise.resolve();
    expect(controlBot.sent.length).toBe(2);
  });

  test("defaults match the documented constants when not overridden", () => {
    expect(DEFAULT_BURN_RATE_THRESHOLD_USD).toBe(20);
    expect(DEFAULT_BURN_RATE_ALARM_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });
});
