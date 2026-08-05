/**
 * §7.4: "Treat any inbound message older than 30 minutes as stale: acknowledge it with 'received
 * while offline, still want this?' rather than acting on it." Telegram queues updates for 24
 * hours while the Bridge is offline (laptop asleep, process down), so on resume a backlog burst
 * can contain a command typed hours ago - acting on a two-hour-old "yes, push it" is exactly the
 * kind of surprise this design must not produce.
 *
 * Deliberately just the age check, kept pure and separate from `index.ts`'s confirm-card wiring
 * (`stale-confirm.ts`) so the "is this stale" question is unit-testable on its own, table-driven,
 * against `message.date` values rather than against a live Telegram round trip.
 */

/** This project's own choice - the plan names the 30-minute threshold but not this constant's
 * name, so it is spelled out here for the one call site and every test to share. */
export const STALE_INBOUND_THRESHOLD_MS = 30 * 60 * 1000;

/** `messageDateUnixSec` is Telegram's own `message.date` field (Unix seconds, UTC, set by
 * Telegram's servers when the message was sent - not when the Bridge finally saw it), compared
 * against wall-clock `nowMs`. Wall-clock, not monotonic, is correct here: staleness is about how
 * long ago a *human* sent this relative to real time, which a monotonic clock cannot answer since
 * it has no fixed epoch (§7.4's monotonic-clock guidance is for *durations* like a 30-minute TTL,
 * not for anchoring to an external wall-clock timestamp like this one). */
export function isStaleInbound(messageDateUnixSec: number, nowMs: number, thresholdMs = STALE_INBOUND_THRESHOLD_MS): boolean {
  return nowMs - messageDateUnixSec * 1000 > thresholdMs;
}

/** For the confirm card's own text - "received while offline (42m ago)" reads better than raw ms. */
export function formatStaleAge(messageDateUnixSec: number, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - messageDateUnixSec * 1000);
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin === 0 ? `${hours}h ago` : `${hours}h${remainMin}m ago`;
}
