import type { CostTracker } from "./cost-tracker.ts";
import { FIVE_HOURS_MS } from "./cost-tracker.ts";
import type { RateGovernor } from "./rate-governor.ts";
import { isValidTransition, type SessionStore } from "./session-store.ts";
import type { SendMessageSource } from "./telegram.ts";

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

/** §10.5 point 2's burn-rate alarm - this project's own choice of threshold, not a number the plan
 * specifies (same convention as §10.4.1's prompts-per-hour warning), overridable for a laptop that
 * wants a tighter or looser guardrail. */
export const DEFAULT_BURN_RATE_THRESHOLD_USD = 10;
/** Keeps a session that's genuinely burning through quota from posting on every single API call
 * once it crosses the line - "an alarm that fires constantly is an alarm nobody reads" (§10.5). */
export const DEFAULT_BURN_RATE_ALARM_COOLDOWN_MS = 60 * 60 * 1000;

export interface QuotaAlarmsOptions {
  sessionStore: SessionStore;
  costTracker: CostTracker;
  /** Shared reference, same as feed-wiring.ts's own `feedGovernor` - this module doesn't own the
   * governor, index.ts (composition root) does, since it's used pervasively for other P1 sends. */
  feedGovernor: RateGovernor;
  controlBot: SendMessageSource;
  supergroupChatId: string;
  log?: LogFn;
  burnRateThresholdUsd?: number;
  burnRateAlarmCooldownMs?: number;
  /** Injectable clock, mirrors session-supervisor.ts's `now` option - defaults to the real ISO
   * timestamp, overridable so tests don't depend on wall-clock time. */
  now?: () => string;
}

export interface QuotaAlarms {
  slugForSessionId(sessionId: string): string | undefined;
  markQuotaStopped(slug: string): void;
  maybeFireBurnRateAlarm(nowMs: number): void;
}

/**
 * §10.5's usage-limit/burn-rate guardrails: `markQuotaStopped` reacts to either signal that a
 * session has hit a rate limit (the OTLP `api_error` log event or a `StopFailure` hook carrying a
 * rate-limit error, wired by the OTLP listener and feed-wiring.ts respectively), and
 * `maybeFireBurnRateAlarm` watches fleet-wide spend for the separate "about to hit one" warning.
 */
export function createQuotaAlarms(opts: QuotaAlarmsOptions): QuotaAlarms {
  const { sessionStore, costTracker, feedGovernor, controlBot, supergroupChatId } = opts;
  const log = opts.log ?? (() => {});
  const burnRateThresholdUsd = opts.burnRateThresholdUsd ?? DEFAULT_BURN_RATE_THRESHOLD_USD;
  const burnRateAlarmCooldownMs = opts.burnRateAlarmCooldownMs ?? DEFAULT_BURN_RATE_ALARM_COOLDOWN_MS;
  const now = opts.now ?? (() => new Date().toISOString());

  let lastBurnAlarmMs = 0;

  function slugForSessionId(sessionId: string): string | undefined {
    return sessionStore.getBySessionId(sessionId)?.slug;
  }

  /** §10.5 point 3: marks a session `quota_stopped` and posts a one-time notice, from either signal
   * - the OTLP `api_error` log event or a `StopFailure` hook carrying a rate-limit error (wired via
   * feed-wiring.ts's `handleHookEvent`). Idempotent: a session already `quota_stopped` (or `dead`)
   * is left alone rather than re-posting on every subsequent error in the same stopped window. */
  function markQuotaStopped(slug: string): void {
    const row = sessionStore.get(slug);
    if (!row || row.state === "quota_stopped" || row.state === "dead") return;
    if (!isValidTransition(row.state, "quota_stopped")) return;
    sessionStore.setState(slug, "quota_stopped", now());
    feedGovernor
      .scheduleAsync("P1", () =>
        controlBot.sendMessage(supergroupChatId, row.topicId, `⚠️ "${slug}" stopped on a usage limit (§10.5) - this looks frozen but isn't wedged; it should resume once the window resets.`),
      )
      .catch((err) => log("WARN", `failed to post quota-stop notice for "${slug}": ${(err as Error).message}`));
  }

  function maybeFireBurnRateAlarm(nowMs: number): void {
    if (nowMs - lastBurnAlarmMs < burnRateAlarmCooldownMs) return;
    const fleetFiveHour = costTracker.fleetSpendSince(FIVE_HOURS_MS, nowMs);
    if (fleetFiveHour < burnRateThresholdUsd) return;
    lastBurnAlarmMs = nowMs;
    const breakdown = sessionStore
      .all()
      .filter((r) => r.sessionId)
      .map((r) => ({ slug: r.slug, spend: costTracker.spendSince(r.sessionId as string, FIVE_HOURS_MS, nowMs) }))
      .filter((r) => r.spend > 0)
      .sort((a, b) => b.spend - a.spend)
      .map((r) => `  ${r.slug}: $${r.spend.toFixed(2)}`)
      .join("\n");
    feedGovernor
      .scheduleAsync("P1", () =>
        controlBot.sendMessage(
          supergroupChatId,
          undefined,
          `⚠️ Burn-rate alarm: fleet has spent $${fleetFiveHour.toFixed(2)} in the last 5h (threshold $${burnRateThresholdUsd.toFixed(2)}).\n${breakdown}`,
        ),
      )
      .catch((err) => log("WARN", `failed to post burn-rate alarm: ${(err as Error).message}`));
  }

  return { slugForSessionId, markQuotaStopped, maybeFireBurnRateAlarm };
}
