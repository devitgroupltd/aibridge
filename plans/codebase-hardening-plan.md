---
version: 1.4.0
status: solid
last_modified_utc: 2026-08-12T19:21:30Z
changelog:
  - "0.1.0 (2026-08-12): Frontmatter added — plan previously lacked valid frontmatter"
  - "1.0.0 (2026-08-12): /plan-craft full review. Re-verified every finding against current source: P0-1–P0-4, P1-1–P1-8 (except its still-open test-gap list), and P2-1–P2-6 were already fixed by commit `a511834` (2026-08-09, same day as the audit) — this document's \"Nothing here has been applied yet\" framing has been stale since that commit landed. Restructured around that: only P0-5 (added earlier today) is a live finding; everything else moved to a compact ## Resolved record. Trimmed \"Missing tests\" from 10 items to the 1 (5b/P0-5) that isn't already covered — 9 of 10 already have passing tests. Corrected P1-5's \"statements are never finalized\" overstatement (bun:sqlite finalizes via GC; the real fix was re-parse cost). Refined P0-5's fix direction to reuse the existing `turn_card_msg`-column persistence pattern instead of proposing a new mechanism, noted that `RESUME_NUDGE_FOLLOWUP_DELAY_MS`'s follow-up nudge shares the same in-memory-only limitation (not a mitigation), and flagged Telegram's bot-message edit-age limit as unverified from docs (defensive fallback recommended). Rewrote \"Suggested sequencing\" and \"Verification per stage\" to reflect only the remaining work."
  - "1.1.0 (2026-08-12): /plan-craft pass 2. Corrected a real overclaim: P2-2's \"Resolved\" entry said a private setColumn now exists — it doesn't; only the migrate() if-chain half of that finding was actually fixed, so P2-2 is now marked partially resolved with the remaining setter-unification cleanup carried into ## Still open. Named a third plan (attachment-triggered-session-creation-plan.md) also citing this document's resolved P1-6/P0-2 findings, found by cross-plan re-verification. De-quoted a §4.5 \"convention\" that was this document's own paraphrase, not a literal quote. Softened the turn_card_msg restart-survival rationale to attribute it to the table (per §4.3), not specifically to that column. Removed inconsistent invented §N prefixes from frontmatter section labels so they match actual heading text exactly. Added the P2-2 setter cleanup as a third sequencing stage — it was in ## Still open but missing from the table."
  - "1.1.1 (2026-08-12): /plan-craft pass 3. Fixed 3 stale numeric citations found by a full re-verification of all 18 Resolved bullets: inbound-media.ts's fireAndForget call count was 8, actually 7; fleet-commands.test.ts's test count was 108, actually 133; and the P0-5 live-incident narrative internally said \"three\" restarts/placeholders while also describing \"a fourth\" — corrected to a consistent four (15:50/16:38/16:54/16:59 local), with the two directly-log-confirmed message_ids (3008, 3015) distinguished from the two inferred-by-code-path ones."
  - "1.1.2 (2026-08-12): /plan-craft pass 4. fleet-commands.test.ts's count had already drifted again mid-review (133 → 140, the file is under active development concurrently with this review) — corrected and added a note that any cited test count here is a point-in-time snapshot, not a fact to defend. Cross-plan and codebase re-verification passes both now report zero remaining findings — marked solid."
  - "1.2.0 (2026-08-12): implemented P0-5 and the remaining P2-2 setter cleanup for real, not just documented. P0-5: added a nullable `thinking_placeholder_msg` SessionStore column (same shape as `turn_card_msg`), a `persist` hook on `thinking-placeholder.ts`'s `start`/`consume` (covers every placeholder, not just resume-nudge ones - no special-casing needed since the nudge already shares `sendChannelText`), and a `relabelStalePlaceholder` callback `runStartupReconciliation` now calls for any leftover from the previous process, edited to an honest \"interrupted by a restart\" notice instead of staying \"Thinking...\" forever. P2-2: added the private `setColumn` every typed setter now delegates to. 8 new tests (`thinking-placeholder.test.ts`, `session-supervisor.test.ts`); `tsc --noEmit` clean across all 5 packages; 1632/1632 tests passing monorepo-wide. Moved both to ## Resolved, removed the now-empty P0-5 open section and the P2-2 Still-open entry, closed out missing-test item 1, and rewrote Suggested sequencing/Verification per stage around the one thing not yet done: a live restart-test against the real Bridge, deliberately left for the operator to trigger rather than done unprompted."
  - "1.2.1 (2026-08-12): P0-5 live-verified against the real Bridge, per operator request. Two real restarts against a throwaway session (`p0-5-check`), reproducing the `unify-work-with-voice-and` scenario exactly: both placeholders got correctly relabeled to \"Interrupted by a restart - resuming...\", none left stuck; the pre-existing lost-pending-question mechanism fired correctly alongside it with no interference. Throwaway session killed and removed afterward. Removed stage 1 (P0-5 live-verify) from Suggested sequencing - only the P1-8 test-gap stage remains."
  - "1.4.0 (2026-08-12): new finding P0-6, found and fixed the same evening from a real incident - `resolveHookClientBinary`'s stale-binary rebuild threw out of `execFileSync` on the launch path (Windows `EPERM`: `bun build --compile` can't replace a mapped `.exe`, and a blocked `--ask` hook client keeps the old one mapped indefinitely), surfacing as an uncaught exception that killed the daemon seconds after a `/restart` and took the whole fleet down over a merely-stale binary. Extracted `ensureHookBinary` (fresh/stale/missing state + degrade-to-existing-binary-with-WARN on failure, rethrowing only when there is no binary at all), stopped caching a degraded resolution so the next launch retries, and threaded the launch `log` through. Second half of the same incident: bun orphans a ~94MB `.<hash>-NNNNNNNN.bun-build` temp file in the *package* dir (not `dist/`) when the rename fails, so it showed up as untracked in `git status` - `*.bun-build` added to `.gitignore`, with the sweep-on-failure alternative deliberately rejected (a concurrent launch's in-progress build writes an indistinguishable temp file). 7 new tests; `tsc --noEmit` clean across all 5 packages; 1704/1704 passing; live-verified by a real restart."
  - "1.3.0 (2026-08-12): closed out the last open item - P1-8's remaining test gaps - for real, not just documented. card-senders.ts/fleet-reporting-commands.ts got real wiring/guard coverage (their own doc comments' low-risk claim confirmed, not assumed). channel-server/src/index.ts and hook-client/src/index.ts were both genuinely untestable as entry-point scripts, so each got a small, behavior-preserving extraction (channel-handlers.ts, run-hook.ts) making the real dispatch logic injectable. send-once.ts got real socket-level tests despite its own doc comment arguing against them, surfacing a real bun-vs-Node socket-backpressure difference worth recording. protocol/src/types.ts (no runtime behavior beyond assertValidBehavior, already covered elsewhere) got a compile-time exhaustiveness check locking the Message union's own completeness. 61 new tests; tsc --noEmit clean across all 5 packages; 1697/1697 passing monorepo-wide. Nothing remains open in this document - Suggested sequencing is now empty by design."
v100_touched_sections:
  - section: "Overall read"
    type: modified
    summary: "Corrected stale \"nothing applied yet\" framing; records that a511834 already fixed almost everything and names the other plans that still cite it as open."
  - section: "P0 — correctness and concurrency (open)"
    type: modified
    summary: "Removed resolved P0-1–P0-4 (moved to ## Resolved); kept and refined P0-5, the only live P0."
  - section: "P1 — leaks, hot-path performance, tooling"
    type: removed
    summary: "All 8 items fixed in a511834 — folded into ## Resolved as one-line records."
  - section: "P2 — DRY / SOLID / KISS"
    type: removed
    summary: "All 6 items fixed in a511834 — folded into ## Resolved as one-line records."
  - section: "Resolved (verified against current code, 2026-08-12)"
    type: added
    summary: "New compact historical record for all findings confirmed already fixed, with what changed and any correction to the original claim."
  - section: "Still open"
    type: added
    summary: "Carries forward P1-8's genuinely-still-untested file list, separated from the resolved parent finding."
  - section: "Missing tests (§9's silent-wrong bar)"
    type: modified
    summary: "Trimmed from 10 items to 1 — 9 already have passing tests (verified against packages/bridge/test/)."
  - section: "Suggested sequencing"
    type: modified
    summary: "Replaced the 7-stage table (mostly already done) with the 2 stages of work that remain."
  - section: "Verification per stage"
    type: modified
    summary: "Updated to target only the remaining work; flagged the original 1255-test baseline as stale (predates a511834's own test additions)."
v110_touched_sections:
  - section: "Resolved (verified against current code, 2026-08-12)"
    type: modified
    summary: "Corrected P2-2 overclaim — migrate() if-chain was fixed but the eight-setter unification was not; marked partially resolved."
  - section: "Still open"
    type: modified
    summary: "Added the remaining P2-2 setter-unification cleanup as a carried-forward low-priority item."
  - section: "Overall read"
    type: modified
    summary: "Named attachment-triggered-session-creation-plan.md as a third plan citing this document's resolved P1-6/P0-2 findings."
  - section: "P0 — correctness and concurrency (open)"
    type: modified
    summary: "De-quoted a paraphrased (not literal) §4.5 convention citation; corrected turn_card_msg's restart-survival rationale to attribute it to the table, not the specific column."
  - section: "Suggested sequencing"
    type: modified
    summary: "Added stage 3 for the P2-2 setter cleanup, which was in ## Still open but missing from the table."
v111_touched_sections:
  - section: "Overall read"
    type: modified
    summary: "Corrected fireAndForget call-site count for inbound-media.ts: 8 → 7."
  - section: "Redundant / low-value tests"
    type: modified
    summary: "Corrected fleet-commands.test.ts's test count: 108 → 133."
  - section: "P0 — correctness and concurrency (open)"
    type: modified
    summary: "Fixed an internal contradiction in the P0-5 live-incident narrative (said \"three\" restarts/placeholders while also describing \"a fourth\") — now a consistent four, with directly-log-confirmed message_ids distinguished from code-path-inferred ones."
v112_touched_sections:
  - section: "Redundant / low-value tests"
    type: modified
    summary: "fleet-commands.test.ts's count had drifted again (133 → 140) since pass 3's own fix, minutes earlier — corrected and flagged as a moving target."
v120_touched_sections:
  - section: "Overall read"
    type: modified
    summary: "States that P0-5 and the P2-2 setter cleanup are now implemented, not just documented."
  - section: "P0 — correctness and concurrency (open)"
    type: removed
    summary: "Emptied out - its one item (P0-5) is implemented and moved to ## Resolved."
  - section: "Resolved (verified against current code, 2026-08-12)"
    type: modified
    summary: "Added the P0-5 implementation record; upgraded P2-2 from partially to fully resolved."
  - section: "Still open"
    type: modified
    summary: "Removed the P2-2 setter-cleanup entry (now done) - only the P1-8 test-gap list remains."
  - section: "Missing tests (§9's silent-wrong bar)"
    type: modified
    summary: "Closed out item 1 (P0-5) with the actual test files/blocks that now cover it - zero remaining gaps."
  - section: "Suggested sequencing"
    type: modified
    summary: "Replaced the implementation stages (done) with the one thing actually left: a live restart-test against the real Bridge."
  - section: "Verification per stage"
    type: modified
    summary: "Recorded the real bun test/tsc results (1632/1632, clean) and explained why the live-restart check wasn't done as part of this pass."
v121_touched_sections:
  - section: "Suggested sequencing"
    type: modified
    summary: "Removed the P0-5 live-verify stage - completed. Only the P1-8 test-gap stage remains."
  - section: "Verification per stage"
    type: modified
    summary: "Recorded the completed live-verification result (two restarts, two correct relabels) against the real Bridge/Telegram client."
v130_touched_sections:
  - section: "Overall read"
    type: modified
    summary: "States that every finding in the document is now implemented, tested, and (where applicable) live-verified - nothing remains open."
  - section: "Resolved (verified against current code, 2026-08-12)"
    type: modified
    summary: "Added the P1-8 closeout record (5 files, 2 behavior-preserving extractions, 61 new tests)."
  - section: "Suggested sequencing"
    type: modified
    summary: "Emptied - the only remaining stage (P1-8 test gaps) is done. Kept as an empty table by design for any future finding."
  - section: "Verification per stage"
    type: modified
    summary: "Recorded the final bun test/tsc results (1697/1697, clean)."
v140_touched_sections:
  - section: "Overall read"
    type: modified
    summary: "Records P0-6 (hook-binary rebuild failure killed the daemon), found from a live incident on 2026-08-12 and fixed the same evening; updates the test/typecheck totals."
  - section: "Resolved (verified against current code, 2026-08-12)"
    type: modified
    summary: "Added the P0-6 record: ensureHookBinary's degrade-instead-of-throw fix plus the *.bun-build gitignore half, including the rejected sweep-on-failure alternative."
  - section: "Verification per stage"
    type: modified
    summary: "Recorded P0-6's results (1704/1704, tsc clean) and its live restart verification against the real dev Bridge."
---

# aibridge codebase hardening plan

Audit date: 2026-08-09 · Baseline: `5f9795c` · Re-verified against current source: 2026-08-12.

Scope: correctness/concurrency defects, leaks, hot-path performance, SOLID/DRY/KISS cleanups,
test gaps, and tooling gaps.

## Overall read

The 2026-08-09 audit below (P0-1 through P0-4, P1-1 through P1-8, P2-1 through P2-6) was fixed
the same day, in commit `a511834` ("Codebase hardening pass: fix fleet-wide crash race, DRY
cleanups, perf, CI") plus a follow-up DRY/SOLID/KISS pass (`f49d18d`) — confirmed directly against
current source on 2026-08-12, item by item. This document's original "Nothing here has been
applied yet" line has been stale since `a511834` landed; `plans/resume-nudge-on-lost-permission-plan.md`
noted the staleness in passing without correcting it, `plans/bypass-and-autoanswer-plan.md` (v0.25.0,
as of 2026-08-11) still cites this document's already-fixed P1-6 as an open gap, and
`plans/attachment-triggered-session-creation-plan.md` (v0.4.0, 2026-08-09) carries the same stale
P1-6 claim plus a now-inaccurate P0-2 claim that `inbound-media.ts` still relies on an unenforced
bare-`void` convention — that file now uses `fireAndForget` exclusively (7 call sites). Pointers for
whoever reads those plans next, not something this document can fix on its own.

**Every finding in this document has been implemented, tested, and (where it was a live behavioral
bug rather than a documentation/cleanup item) live-verified, as of 2026-08-12** — P0-5's persist-and-
relabel mechanism, P2-2's setter cleanup, P1-8's remaining test gaps, and P0-6 (added late the same
evening from a real fleet-down incident) all closed the same day. `tsc --noEmit` is clean across all
5 packages; the full suite is at 1704/1704 tests passing. Nothing in this document is currently open.
Every item is recorded compactly under **## Resolved** for traceability rather than deleted
outright.

---

## Resolved (verified against current code, 2026-08-12)

All items below were open in the 2026-08-09 audit and confirmed fixed in commit `a511834` (same
day) unless noted otherwise. Kept as a compact record for traceability — see that commit for
implementation detail.

- **P0-6** (a failed hook-client rebuild on the launch path killed the whole daemon - live incident
  2026-08-12 19:07Z, found while asking why an untracked `.bun-build` file was in `git status`) —
  found and fixed the same evening; not part of the 2026-08-09 audit. `resolveHookClientBinary`'s
  staleness check (added for the good reason recorded at `newestSourceMtimeMs`: a stale binary had
  silently kept running old behaviour once already) called `execFileSync("bun build --compile")`
  unguarded. On Windows that rename cannot replace a *mapped* executable, and hook clients invoked
  with `--ask` block indefinitely by design (§5.1), so two hook processes left over from an
  unanswered question - alive ~57 minutes - were enough to make every rebuild fail with
  `failed to move executable to ...\dist\aibridge-hook.exe: EPERM`. The throw propagated out of
  `launchSession` as `uncaught exception` and killed the Bridge ~2s after a `/restart` had relaunched
  it, i.e. the entire fleet went down because a binary was *newer in source than on disk* - strictly
  worse than running the previous build for one more session. Fix: a new exported
  `ensureHookBinary({exePath, state, build, log})` with an explicit `fresh | stale | missing` state;
  `stale` + build failure now logs a WARN naming the likely cause and the manual
  `bun run build` recovery, and returns the existing binary, while `missing` (nothing to degrade to)
  still rethrows. A degraded resolution is deliberately not written to `cachedHookClientPath`, so the
  next launch retries instead of pinning the daemon's whole lifetime to one transient `EPERM`. The
  launch-path `log` is threaded in so the WARN actually reaches `bridge.log`. Second half of the same
  incident, tooling: bun writes the whole ~94MB binary to a `.<hash>-NNNNNNNN.bun-build` temp file in
  the *package* dir - not `dist/`, so the existing `dist/` ignore never covered it - and orphans it
  when the rename fails, which is how this surfaced. `*.bun-build` added to `.gitignore` with a
  comment pointing at `ensureHookBinary`. Sweeping orphaned temps on failure was considered and
  rejected: a concurrent launch's in-progress build writes an indistinguishable temp file into the
  same directory, so a pattern delete could break a build that was about to succeed - disk cleanup
  stays manual, and the doc comment says so. 7 new tests (`session-launcher.test.ts`'s
  `ensureHookBinary` block: each state's build-or-skip decision, the stale-degrade path including
  WARN content, the missing-rethrow path, a non-`Error` throw, and a degrade with no log callback);
  `tsc --noEmit` clean across all 5 packages; 1704/1704 passing. Live-verified - the two wedged
  `--ask` processes cleared, the orphan deleted, `bun run build` landed the pending source edit, and
  the daemon restarted clean (pid 13364) and relaunched its session with no `EPERM`.
- **P0-5** (a resume nudge's "🤔 Thinking..." placeholder couldn't survive the Bridge restart that
  triggered it - live-confirmed 2026-08-12, `unify-work-with-voice-and`) — fixed 2026-08-12, same
  day as the write-up. Added a nullable `thinking_placeholder_msg` column to `SessionStore` (same
  shape/migration pattern as `turn_card_msg`); `thinking-placeholder.ts` gained an optional
  `persist` hook (`resolveSlug`/`save`/`clear`) that `start`/`consume` call so every placeholder's
  message_id survives a restart, not just resume-nudge ones - a strict superset of the original
  fix, no special-casing needed since the nudge already goes through the same `sendChannelText` path
  as every other inbound turn. `runStartupReconciliation` now checks each live session's persisted
  column at boot and calls a new `relabelStalePlaceholder` (wired to `editMessageText`, falling back
  to `sendMessage` if the edit fails) before that row's own resume nudge creates a fresh one - closes
  the exact "stuck reading 🤔 Thinking... forever" gap, with the leftover relabeled to "⚠️ Interrupted
  by a restart - resuming..." instead. 8 new tests (`thinking-placeholder.test.ts`'s persist-hook
  contract in isolation, `session-supervisor.test.ts`'s `runStartupReconciliation` relabel/clear
  behavior) cover missing-test item 1 below. **Not yet live-verified** against the real Bridge
  (`scripts/telegram-automation/` + an actual restart) - see Verification per stage.
- **P0-1** (a `/rm`/`/kill` during the resume backoff could crash the whole Bridge, or resurrect a
  session the operator had just killed) — `resumeSession` now re-reads `sessionStore.get(slug)`
  after the wait and bails cleanly if the row is gone or `dead`.
- **P0-2** (~45 fire-and-forget `void asyncFn()` sites against a fatal `unhandledRejection`
  handler) — a `fireAndForget()` helper now exists and is used ~59 times; the 3 remaining bare
  `void` calls are safe (non-async, already `.catch`-guarded, or internally try/caught).
- **P0-3** (`killAndUntrack` did kill-then-delete, contradicting its own documented
  kill-then-crash-discrimination invariant) — now delete-then-kill, matching the invariant, with a
  code comment recording the fix.
- **P0-4** (concurrent replies for one slug could interleave their chunks) — `pipe-server.ts` now
  serializes per-slug via `serializedPerSlug()`, with a test confirming two concurrent multi-chunk
  replies stay grouped.
- **P1-1** (`ConfirmRegistry.answeredAt` grew without bound) — `takeExpired()` now sweeps it.
- **P1-2** (supervisor per-slug maps never cleared on teardown) — `untrack()` now clears both
  `resumeAttempts` and `lastPtyActivityBySlug`.
- **P1-3** (`log()` did a `statSync` syscall per line) — now tracks appended bytes and stats only
  once per rotation.
- **P1-4** (a 50MB synchronous `readFileSync` in `send_file` blocked the whole fleet) —
  `pipe-server.ts` now uses `fs/promises`. Smaller synchronous reads remain in
  `attachment-inbox.ts`/`telegram-offset.ts`, but those are small config/exclude files outside the
  original finding's scope, not a fleet-blocking path.
- **P1-5** (`SessionStore` re-prepared every SQL statement on every call) — now prepares once into
  a private cache; `slugs()` is a plain `SELECT slug FROM sessions`. *Correction to the original
  finding:* "statements are also never finalized" overstated the risk — `bun:sqlite` finalizes
  prepared statements automatically on GC, so the real (and now-fixed) cost was re-parsing, not an
  unbounded leak.
- **P1-6** (no CI, no `typecheck` script despite §9 mandating the gate) — `.github/workflows/ci.yml`
  and a `typecheck` script both exist now. (`plans/bypass-and-autoanswer-plan.md` still cited this
  as open as of 2026-08-11 — that reference is stale and worth a fix in that document, not this
  one.)
- **P1-7** (CLAUDE.md was severely stale, claiming "no code written yet") — CLAUDE.md's status line
  now reads "implemented through Phase 5, hardening ongoing."
- **P1-8** (modules with no test file at all) — `hook-client/src/ask-once.ts` now has
  `ask-once.test.ts`, including the reconnect-with-same-`request_id` scenario originally listed as
  missing test #10. The rest of the original list is still genuinely untested — carried forward
  below under **## Still open**.
- **P2-1** (`TelegramClient`'s 14 methods shared one repeated fetch body) — private
  `callJson`/`callMultipart` helpers now exist.
- **P2-2** (`SessionStore`'s eight identical setters + an accreting `migrate()` if-chain) — both
  halves now fixed: the `COLUMN_MIGRATIONS` table (fixed 2026-08-09) plus a private
  `setColumn(slug, column, value)` (fixed 2026-08-12) every typed setter now delegates to -
  `setState` deliberately excluded, since it validates the transition and touches a second column,
  unlike every other setter.
- **P2-3** (`RateGovernor` carried redundant state) — `drainRetryTimerArmed` is gone.
- **P2-4** (`completeAsk`/`cancelAsk` were the same function) — unified into one `finishAsk`.
- **P2-5** (two real dependency cycles in the composition root) — a `LateBound<T>` wrapper now
  wires `commandDispatch`/`fleetConfirmFlow` (the audit's recommended cheap option was the one
  taken).
- **P2-6** (`startPolling`'s throwing `onUpdate` silently skipped one update, and retried at a flat
  1s with no backoff) — per-update `try/catch` with an accurate log line, plus exponential backoff,
  now exist with tests.
- **P1-8** (modules with no test file at all) — closed out in full 2026-08-12: `card-senders.ts`
  and `fleet-reporting-commands.ts` got real coverage of the wiring/guard logic they actually own
  (both files' own doc comments called this low-risk, which the tests confirm rather than assume -
  neither re-tests the already-tested renderers/registries they wrap). `channel-server/src/index.ts`
  and `hook-client/src/index.ts` were both genuinely untestable as entry-point scripts (`index.ts`
  either throws on import without env vars, or ends in a top-level `process.exit(0)` that would kill
  the test runner's own process) - each got a small, behavior-preserving extraction
  (`channel-handlers.ts`, `run-hook.ts`) so the real request/dispatch logic is injectable and
  testable, leaving `index.ts` as thin wiring. `send-once.ts`'s own doc comment argued it was "thin
  enough... it isn't unit-tested directly" - tested against a real local socket anyway (same pattern
  `pipe-client.test.ts` already uses), which surfaced a real runtime nuance worth recording: a
  passive-but-connected peer doesn't reliably reproduce a genuine hang under `bun`'s own socket
  implementation the way it does under plain Node, so the timeout-specific branch couldn't be forced
  deterministically - the test instead pins the invariant that actually matters (never hangs past its
  timeout, regardless of which internal path resolves it). `protocol/src/types.ts` has no runtime
  behavior beyond `assertValidBehavior` (already covered by `verdict.test.ts`, not duplicated) - its
  new test instead locks the `Message` union's own completeness via a compile-time exhaustiveness
  switch, the actual "silent-wrong" risk a pure-types file carries (a future variant added to the
  union with no matching case in a consumer's `switch` silently falls through to a `default`,
  unnoticed). 61 new tests total; `tsc --noEmit` clean across all 5 packages; 1697/1697 tests passing
  monorepo-wide.

---

## Missing tests (§9's silent-wrong bar)

Re-checked against `packages/bridge/test/` on 2026-08-12: 9 of the original 10 items already had
passing tests (the resume/kill-race scenarios in `session-supervisor.test.ts`, the registry sweep
in `confirm-registry.test.ts`, the polling-backoff case in `telegram.test.ts`, the interleaving case
in `pipe-server.test.ts`, and the `ask-once.ts` reconnect scenario in `ask-once.test.ts`). The one
remaining gap is now covered too:

1. ~~A resume nudge's placeholder outstanding when boot-reconciliation runs again is found and
   relabeled (or otherwise resolved), not left reading "🤔 Thinking..." forever (P0-5).~~ **Covered
   2026-08-12**: `thinking-placeholder.test.ts`'s "persist hook (P0-5)" block (5 tests) plus
   `session-supervisor.test.ts`'s "runStartupReconciliation relabels a leftover thinking placeholder
   (P0-5)" block (3 tests).

All 10 items now have coverage — zero remaining gaps in this list.

## Redundant / low-value tests

Deliberately short: the suite is well-targeted. Cross-file duplicate test *names* (~20) are parallel
structures over genuinely different modules, not redundancy. The one real observation is
`fleet-commands.test.ts` at 140 tests (count as of 2026-08-12; this file is under active development
alongside this review and its count has already drifted twice in one day — treat any cited count as
a snapshot, not a fact to defend) — many are single-flag permutations of `normalizeDashFlags` that
would read better as one table-driven case. **Consolidation only, no coverage loss, low
priority.**

---

## Suggested sequencing

Nothing remains to sequence - every finding in this document (P0-1 through P0-5, P1-1 through
P1-8, P2-1 through P2-6) is implemented, tested, and (where it was a live behavioral bug rather
than a documentation/cleanup item) live-verified. This table is kept empty deliberately rather
than removed outright, so a future finding added to this plan has an obvious place to land.

| Stage | Contents | Risk |
|---|---|---|
| _(none - see above)_ | | |

## Verification per stage

- `bun test` — 1704/1704 passing as of P0-6 (2026-08-12, the final pass; 1697 at the P1-8 test-gap
  closeout earlier the same day). The plan's original "1255 baseline" predates `a511834`'s own test
  additions and was already stale even at the time this document was first written.
- `tsc --noEmit` per package — clean across all 5 packages as of the same commit.
- **P0-6 live-verified 2026-08-12** against the real dev Bridge, which was dead at the time from the
  very exception this finding is about: killed the two wedged `--ask` hook clients that had been
  holding `dist/aibridge-hook.exe` mapped, deleted the orphaned 94MB `.bun-build` temp, rebuilt the
  binary by hand (612ms, succeeded once nothing held the file), and restarted the daemon - which came
  up clean and relaunched its session with no `EPERM` and no rebuild WARN in `bridge-dev.log`. The
  degrade path itself is covered by unit tests rather than reproduced live, since forcing it again
  would mean deliberately wedging a hook process on the real fleet.
- **P0-5 live-verified 2026-08-12** via `scripts/telegram-automation/`, against a real throwaway
  session (`p0-5-check`) and two real Bridge restarts, reproducing the exact `unify-work-with-voice-and`
  scenario that surfaced this finding: sent an inbound message (creates a placeholder), restarted
  the daemon mid-turn, confirmed the placeholder was edited to "⚠️ Interrupted by a restart -
  resuming..." (not left stuck) before the resume nudge created a fresh one; restarted again while
  that nudge's own turn was still in flight (mid-`AskUserQuestion`) and confirmed the *second*
  placeholder was relabeled the same way. Two restarts, two correct relabels, zero stuck
  "🤔 Thinking..." messages - matches the unit tests' behavior exactly. Also confirmed the
  pre-existing "pending question was lost - please re-ask" mechanism (resume-nudge-on-lost-permission-plan.md)
  fired correctly for the in-flight `AskUserQuestion` on the second restart, with no interference
  between the two restart-survival mechanisms. Throwaway session killed and removed afterward.
