/**
 * §7.4: "Use a monotonic clock for all timers. Wall-clock deltas across a suspend produce instant
 * expiry of every pending prompt." `Date.now()` is wall-clock and can jump arbitrarily across a
 * laptop sleep/resume, an NTP correction, or a manual clock change; every TTL/expiry check in this
 * codebase (`permission-registry.ts`, `ask-registry.ts`, `fleet-confirm.ts`, `stale-confirm.ts`)
 * only ever computes `now() - createdAt`, a duration, never an absolute time - exactly the case a
 * monotonic clock is for, and the case a wall clock actively gets wrong: a laptop that sleeps for
 * two hours would otherwise make `Date.now() - createdAt` read as "two hours old" for a prompt
 * that's actually one minute old by elapsed real time, expiring every pending prompt at once on
 * resume - a mass silent denial, not a loud failure.
 *
 * Not the same module as `stale-inbound.ts`'s check, which is deliberately wall-clock: that one
 * anchors to Telegram's own `message.date` (an external, absolute timestamp with no relationship
 * to this process's uptime), which a monotonic clock has no epoch to compare against.
 *
 * **Not independently verified on this host across a real modern-standby suspend.** §7.4 names the
 * exact risk: Node's `process.hrtime.bigint()` is backed by Windows' `QueryPerformanceCounter`,
 * which the plan states *should* keep advancing through modern standby - "verify rather than
 * assume." That verification is §13's manual sleep/resume check, not something this module can
 * prove by running; it exists here as the mechanism, live-verified across a real suspend has not.
 */
const startHrtimeNs = process.hrtime.bigint();

/** Milliseconds elapsed since this module was first loaded (i.e. since Bridge startup) - not a
 * wall-clock timestamp, and not meaningful except as a difference between two calls, which is
 * exactly what every TTL/expiry check needs. */
export function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() - startHrtimeNs) / 1e6;
}
