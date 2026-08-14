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
 * **Not verified across a real suspend, and not verifiable on this host.** §7.4 names the exact
 * risk: Node's `process.hrtime.bigint()` is backed by Windows' `QueryPerformanceCounter`, which the
 * plan states *should* keep advancing through modern standby - "verify rather than assume."
 *
 * An earlier version of this comment deferred that to "§13's manual sleep/resume check" and called
 * it a modern-standby question. Both are wrong for this machine, measured 2026-08-13: it is a VMware
 * guest (`Win32_ComputerSystem` reports `VMware, Inc.`, no battery, chassis type 1), `powercfg /a`
 * reports S3, hibernation **and S0 Low Power Idle** all unsupported with only S1 available, and
 * `powercfg /q SCHEME_CURRENT SUB_BUTTONS` publishes no lid-close action at all - Windows only
 * publishes one when a lid exists. So there is no modern standby *here* to survive, and no lid in
 * this guest to close.
 *
 * That does not make check 2 moot, because this VM runs on a laptop (confirmed with the operator
 * 2026-08-13). Closing the **host's** lid suspends this guest wholesale, so the check is triggerable
 * - just not from inside, and not by any script that lives in here. What reaches the guest is not an
 * S-state transition at all but a **clock discontinuity**, which is the only part of a suspend this
 * module was ever exposed to.
 *
 * Note the direction, because it is the opposite of the one §7.4 describes and the more dangerous
 * one. A suspended VM's clock stops; on resume, absent a resync, guest wall time is *behind* real
 * time by the suspend duration. §7.4 worries about `Date.now()` jumping **forward** and mass-expiring
 * pending prompts, which is what this module prevents and what `clock-jump-check.js` measures. A
 * guest clock running **slow** does something different and worse: `stale-inbound.ts` compares
 * Telegram's server-set `message.date` against local wall time, so a lagging clock makes genuinely
 * old commands look fresh and they execute - precisely the surprise §7.4 exists to prevent, arriving
 * by a route §7.4 does not describe. Whether that lag actually survives resume here is unknown and
 * measurable: `VMwareToolboxCmd timesync status` reports periodic sync **Disabled** and `w32time` is
 * **Stopped**, but VMware's one-shot resume sync is a separate host-side `.vmx` setting this guest
 * cannot read. Measure it on the next real lid close (guest clock vs. real time on resume) before
 * assuming either way.
 */
const startHrtimeNs = process.hrtime.bigint();

/** Milliseconds elapsed since this module was first loaded (i.e. since Bridge startup) - not a
 * wall-clock timestamp, and not meaningful except as a difference between two calls, which is
 * exactly what every TTL/expiry check needs. */
export function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() - startHrtimeNs) / 1e6;
}
