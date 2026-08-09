# aibridge codebase hardening plan

Audit date: 2026-08-09 · Baseline: `5f9795c` · 1255 tests pass, `tsc --noEmit` clean per package.

Scope: correctness/concurrency defects, leaks, hot-path performance, SOLID/DRY/KISS cleanups,
test gaps, and tooling gaps. Findings are ordered by severity, each with the concrete evidence
that produced it. Nothing here has been applied yet.

## Overall read

The codebase is in good shape: high cohesion, one concern per module, dependency injection
throughout, an unusually strong documentation culture, and a genuinely well-designed composition
root. The confirm registries are already DRY'd behind `ConfirmRegistry`; `outbox.ts`'s path gate
(realpath + slug validation + case-insensitive containment) is correct. Most of what follows is
hardening, not rescue — with one exception (P0-1), which can take the whole daemon down.

---

## P0 — correctness and concurrency

### P0-1. A `/rm` or `/kill` during the resume backoff crashes the Bridge or resurrects a dead session

[session-supervisor.ts:228-258](packages/bridge/src/session-supervisor.ts#L228-L258)

`handleUnexpectedExit` captures `row` *before* `await delay(delayMs)` (1s / 15s / 60s), then calls
`resumeSession(row)` with that stale snapshot. Nothing re-reads the store or cancels the pending
resume. Two distinct failures:

- **Daemon death.** If the operator `/rm`s the session during the wait, the row is gone.
  `resumeSession` calls `sessionStore.setState(...)` at
  [session-supervisor.ts:270](packages/bridge/src/session-supervisor.ts#L270) / [:274](packages/bridge/src/session-supervisor.ts#L274)
  — both *outside* its own `try` — and `setState` throws `unknown slug` by design
  ([session-store.ts:247](packages/bridge/src/session-store.ts#L247)). That rejection propagates
  through `handleUnexpectedExit` to the bare `void handleUnexpectedExit(...)` in the `onExit` handler
  ([session-supervisor.ts:216](packages/bridge/src/session-supervisor.ts#L216)), becomes an unhandled
  rejection, and hits `process.on("unhandledRejection") → process.exit(1)`
  ([index.ts:70-73](packages/bridge/src/index.ts#L70-L73)). **One `/rm` at the wrong moment kills every
  session in the fleet.**
- **Zombie resurrection.** If `/kill` lands during the wait instead, the row survives as `dead` but the
  pending resume still fires: `launchSession` + `wireSession` + `routing.add` bring back a session the
  operator explicitly killed, against a worktree `/rm` may have already deleted.

Fix: re-read `sessionStore.get(slug)` after the delay and bail if the row is gone or `dead`; hold a
per-slug cancellation token that `killAndUntrack`/`untrack` clear; move `resumeSession`'s pre-flight
`setState` calls inside its `try`.

### P0-2. ~45 fire-and-forget `void asyncFn()` sites against a fatal `unhandledRejection` handler

`grep -n "\bvoid [a-zA-Z_$]" packages/bridge/src/*.ts` returns ~45 call sites
(`command-dispatch.ts`, `callback-query-router.ts`, `inbound-media.ts`, `pipe-server.ts`,
`session-supervisor.ts`, `index.ts`). Every one relies on the callee having an internal `try/catch`
— an unenforced convention with no test and no type-level guard. Combined with
[index.ts:70-73](packages/bridge/src/index.ts#L70-L73)'s `process.exit(1)`, a single missed `catch`
anywhere in a handler is a full-fleet outage. P0-1 is one already-reachable instance; the systemic
risk is the finding.

Fix: a single `fireAndForget(promise, log, context)` helper that logs and swallows, and replace every
bare `void` with it. Cheap, mechanical, removes a whole class of outage. Add a lint rule
(`no-floating-promises`) once ESLint exists (P1-6).

### P0-3. `killAndUntrack` contradicts the documented kill/crash discrimination contract

[session-supervisor.ts:338-341](packages/bridge/src/session-supervisor.ts#L338-L341) does
`get(slug)?.kill()` **then** `delete(slug)`. But `handleUnexpectedExit`'s own doc comment
([:224](packages/bridge/src/session-supervisor.ts#L224)) states the invariant it depends on as
*"`/kill`/`/rm` both delete the map entry before calling `.kill()`"*, and
[:314](packages/bridge/src/session-supervisor.ts#L314) claims `resumeSession` uses "the same
kill-then-delete ordering `killAndUntrack` uses". Three statements, two orderings, one of them wrong.

It works today only because node-pty's `onExit` is asynchronous. If it ever emits synchronously (or a
future refactor awaits between the two lines), a deliberate `/kill` is misclassified as a crash and
auto-resumed. Fix: swap to delete-then-kill so code matches the stated invariant, and reconcile the
three comments.

### P0-4. Concurrent replies for one slug can interleave their chunks

[pipe-server.ts:475](packages/bridge/src/pipe-server.ts#L475) dispatches `void handleReply(msg)` per
message with no per-slug serialization. `handleReply` awaits `onBeforeReply` and then sends chunks in
a loop ([:292-303](packages/bridge/src/pipe-server.ts#L292-L303)). Two replies arriving close together
(or one arriving while another is mid-`onBeforeReply`) interleave: reply A chunk 1, reply B chunk 1,
reply A chunk 2. `handleAsk` has the same shape for multi-question cards
([:429-436](packages/bridge/src/pipe-server.ts#L429-L436)).

`4d1f09c` serialized the governor's *lane*, which fixed cross-message ordering — it does not make a
multi-chunk reply atomic. Fix: a per-slug promise chain around `handleReply`/`handleAsk`.

---

## P1 — leaks, hot-path performance, tooling

### P1-1. `ConfirmRegistry.answeredAt` grows without bound

[confirm-registry.ts](packages/bridge/src/confirm-registry.ts) — `take()` writes into `answeredAt`,
but the only removal is inside `wasRecentlyAnswered(id)`, for that one id. A card tapped once and
never re-tapped keeps its entry **forever**; `takeExpired()` doesn't touch the map either. The doc
comment explicitly claims the opposite ("Sweeps its own entry past the retention window so this map
can't outlive the process on a long-idle daemon") — so the overclaiming comment is part of the fix.

Fix: sweep `answeredAt` inside `takeExpired()` (already called every 60s from
[index.ts:686-689](packages/bridge/src/index.ts#L686-L689)), and correct the comment.

### P1-2. Supervisor per-slug maps are never cleared on teardown

`lastPtyActivityBySlug` and `resumeAttempts`
([session-supervisor.ts:116-117](packages/bridge/src/session-supervisor.ts#L116-L117)) are written on
every PTY chunk / crash but never deleted by `untrack`/`killAndUntrack`, and `/rm`
([session-lifecycle-commands.ts:191-221](packages/bridge/src/session-lifecycle-commands.ts#L191-L221))
clears `sessionStore`, `routing` and `feedWiring` but not these. Small per-slug leak on a daemon
designed to run for weeks across many `/new`+`/rm` cycles — and a stale `resumeAttempts` entry can
make a *fresh* session reusing the same slug give up early.

Fix: clear both in `untrack` (and have `killAndUntrack` delegate).

### P1-3. `log()` does a `statSync` syscall on every single line

[logger.ts:53-77](packages/bridge/src/logger.ts#L53-L77) — `rotateIfNeeded` stats the file before
every `appendFileSync`. Two synchronous syscalls per log line, on the hottest path in the process
(every hook event, PTY chunk, feed edit, governor decision).

Fix: track appended bytes in a module-level counter, `statSync` only on init and when the counter
crosses `MAX_LOG_BYTES`. Behaviour-identical, ~1 syscall per line.

### P1-4. A 50MB `readFileSync` blocks the whole fleet

[pipe-server.ts:335-340](packages/bridge/src/pipe-server.ts#L335-L340) — `send_file` stats and reads
up to `MAX_SEND_FILE_BYTES` (50MB) synchronously. The Bridge is single-threaded and serves every
session: for the duration of that read, no `getUpdates`, no permission card, no reply, for anyone.
Same shape (smaller ceiling) at [attachment-inbox.ts:73](packages/bridge/src/attachment-inbox.ts#L73)
and, once per inbound update, at [telegram-offset.ts:22](packages/bridge/src/telegram-offset.ts#L22).

Fix: `fs/promises` in all three. The surrounding functions are already `async`.

### P1-5. `SessionStore` re-prepares every statement on every call

[session-store.ts:215-290](packages/bridge/src/session-store.ts#L215-L290) — each accessor/mutator
calls `this.db.prepare(...)` inline, so every `get`/`setState`/`all` re-parses SQL. `slugs()` even
goes through the full `all()` + `fromSql` mapping just to collect keys. Statements are also never
finalized.

Fix: prepare once in the constructor into private fields; `slugs()` → `SELECT slug FROM sessions`.

### P1-6. No CI, no `typecheck` script — despite §9 mandating the gate

`.github/workflows/` does not exist, and `package.json` has only `"test": "bun test"`. CLAUDE.md §9
states *"Type gate: `tsc --noEmit`. Both are meant to run in CI per package."* Today the type gate
exists only as something a human remembers to run. (It does currently pass — verified per package.)

Fix: add `"typecheck"` (loop over the five package tsconfigs) and a GitHub Actions workflow running
`bun test` + `typecheck` on push/PR.

### P1-7. CLAUDE.md is severely stale and actively misleading

CLAUDE.md's first heading reads **"Status: design complete, no code written yet"** and *"No build,
lint, or test tooling exists yet because no source code exists yet."* Reality: 5 packages, ~33k lines,
92 test files, 1255 tests. It also says Phase 1 "has not been started" while Phases 1-5 are visibly
complete (supervisor, fleet commands, deploy, voice, NL router).

This is the highest-leverage *non-code* fix in the audit — it is the first thing every future agent
session reads, and it is wrong about the single most important fact.

### P1-8. Modules with no test file at all

`card-senders.ts`, `fleet-reporting-commands.ts` (bridge); `channel-server/src/index.ts`;
`hook-client/src/{index,send-once,ask-once}.ts`; `protocol/src/types.ts`.

`hook-client/src/ask-once.ts` is the notable one — it implements the §6.4 blocking-ask reconnect
protocol that `pipe-server.handleAsk` explicitly branches on, which is exactly §9's "protocol contract
another component branches on" test bar.

---

## P2 — DRY / SOLID / KISS

### P2-1. `TelegramClient`: 14 methods, one repeated body (~200 lines removable)

[telegram.ts:315-572](packages/bridge/src/telegram.ts#L315-L572) — every JSON method is literally
`fetchWithTimeout(this.url(m), {method:"POST", headers:{"content-type":"application/json"},
body: JSON.stringify(params)}, DEFAULT_TIMEOUT_MS)` + `parseTelegramResponse(res, m)`. The three
multipart methods share a second identical shape.

Fix: private `callJson<T>(method, params, timeoutMs?)` and `callMultipart<T>(method, form)`. Largest
single DRY win in the repo, and it removes 14 places a future timeout/header change could be missed.

### P2-2. `SessionStore`: eight identical one-line setters + an accreting `migrate()` if-chain

[session-store.ts:256-290](packages/bridge/src/session-store.ts#L256-L290) and
[:175-186](packages/bridge/src/session-store.ts#L175-L186). Every new column costs a hand-written
setter *and* a hand-written `if (!columns.has(...))` branch. Fix: a `MIGRATIONS` table of
`{column, ddl}` iterated in `migrate()`, and a private `setColumn(slug, column, value)` the typed
setters delegate to (keeping the typed public API — this is internal deduplication, not API collapse).

### P2-3. `RateGovernor` carries redundant state

[rate-governor.ts](packages/bridge/src/rate-governor.ts) — `drainRetryTimer !== undefined` and
`drainRetryTimerArmed` encode the same fact in two fields that must be kept in sync by hand across
three methods (`pump`, `armDrainRetry`, the timer callback). Separately, `p2DroppedCount` duplicates
what `p2Outcomes.filter(o => o.dropped)` already knows, differing only in window. Fix: drop
`drainRetryTimerArmed`; keep `p2DroppedCount` only if `droppedP2Count` has a real consumer (check —
it may be dead code).

### P2-4. `pipe-server.completeAsk` / `cancelAsk` are the same function

[pipe-server.ts:607-628](packages/bridge/src/pipe-server.ts#L607-L628) differ only in the payload
(`{answers}` vs `{cancel:true}`). Fix: one `finishAsk(id, payload)`.

### P2-5. Two real dependency cycles in the composition root

[index.ts](packages/bridge/src/index.ts) is 947 lines (mostly excellent comments) but contains two
`let`-declared forward references resolved after construction — `commandDispatch`
([:313](packages/bridge/src/index.ts#L313)) and `fleetConfirmFlow`
([:562](packages/bridge/src/index.ts#L562)). Both are heavily documented and safe today, but they are
genuine cycles: `inboundMedia ↔ commandDispatch` and `sessionLifecycle ↔ fleetConfirmFlow`.

This is a *design* item, not a bug — worth an explicit decision rather than a silent refactor. The
cheap option is a tiny typed `LateBound<T>` wrapper making "assigned once, before first call" an
enforced invariant instead of a comment. The expensive option (an event bus / mediator between the
dispatch layer and the media/confirm layers) is probably not worth it. **Recommend the cheap option.**

### P2-6. `startPolling`: a throwing `onUpdate` silently skips one update

[telegram.ts:620-635](packages/bridge/src/telegram.ts#L620-L635) — `onUpdate` runs inside the loop's
`try`. A synchronous throw aborts the rest of the batch; because `offset` was already advanced past
the *failing* update, the remainder is re-fetched 1s later (so nothing is permanently lost) but the
failing update is dropped with only a generic `getUpdates failed` log that names the wrong cause.
Also: `retryDelayMs` is a flat 1s with no backoff, so a sustained Telegram outage polls forever at
1 req/s. Fix: per-update `try/catch` with an accurate log line; exponential backoff with a cap on
consecutive `getUpdates` failures.

---

## Missing tests (§9's silent-wrong bar)

Each of these is a silent-wrong or protocol-contract case with no current coverage:

1. `/rm` during the resume backoff → no throw, no relaunch (P0-1).
2. `/kill` during the resume backoff → pending resume does not fire (P0-1).
3. `resumeSession` against an already-removed row → bails cleanly (P0-1).
4. Deliberate-kill vs crash discrimination after the ordering fix (P0-3).
5. Two concurrent multi-chunk replies for one slug → chunks stay grouped per reply (P0-4).
6. `ConfirmRegistry.takeExpired()` sweeps `answeredAt` (P1-1).
7. `untrack` clears `resumeAttempts`/`lastPtyActivityBySlug`; a slug reused after `/rm` starts with a
   clean attempt count (P1-2).
8. `log()` issues one `statSync` per rotation, not per line (P1-3).
9. `startPolling`: a throwing `onUpdate` doesn't stop the loop and doesn't lose later updates (P2-6).
10. `hook-client/ask-once.ts` reconnect: re-sending `hello`+`ask` with the same `request_id` rebinds
    rather than reposting (P1-8) — pairs with the existing `pipe-server` side.

## Redundant / low-value tests

Deliberately short: the suite is well-targeted. Cross-file duplicate test *names* (~20) are parallel
structures over genuinely different modules, not redundancy. The one real observation is
`fleet-commands.test.ts` at 108 tests — many are single-flag permutations of `normalizeDashFlags`
that would read better as one table-driven case. **Consolidation only, no coverage loss, low
priority.**

---

## Suggested sequencing

| Stage | Contents | Risk |
|---|---|---|
| 1 | P1-7 (CLAUDE.md), P1-6 (CI + `typecheck`) | none — do first, they protect everything after |
| 2 | P0-1, P0-3 + tests 1-4 | medium — core supervisor; behaviour-preserving except the fixed races |
| 3 | P0-2 (`fireAndForget` sweep), P0-4 + test 5 | low — mechanical, wide blast radius, easy to review |
| 4 | P1-1, P1-2 + tests 6-7 | low |
| 5 | P1-3, P1-4, P1-5 + test 8 | low — measurable win on a busy fleet |
| 6 | P2-1, P2-2, P2-3, P2-4 | low — pure refactor, suite is the safety net |
| 7 | P2-5 decision, P2-6 + test 9, P1-8 + test 10 | low |

Stages 1 and 2 carry nearly all the value. Stages 6-7 are optional polish; the code is already
readable without them.

## Verification per stage

- `bun test` (1255 baseline, must not drop)
- `tsc --noEmit` per package
- For stages 2-5: restart the daemon (`bun run bridge:restart`) and live-verify via
  `scripts/telegram-automation/` — specifically `/new` → `/kill` → `/rm` under a crashing session,
  which is the exact P0-1 path and is not reachable from unit tests alone.
