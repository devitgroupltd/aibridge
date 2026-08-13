---
version: 1.8.0
status: solid
last_modified_utc: 2026-08-13T06:30:00Z
changelog:
  - "1.8.0 (2026-08-13): two findings from running the last of §12's never-live-exercised checks. **P1-10 (found and fixed)**: `/attach` produced nothing at all the first time it ran against a real multi-line PTY tail - the rendered card passed Telegram's 4096-unit cap, the P1 send failed three times with \"message is too long\", and a failed command confirmation is only a log line, so the operator saw silence. The raw ring buffer is bounded at 4000 chars but `renderAttach` HTML-escapes it afterwards and PTY output is dense in `<`, `>` and `&`, each expanding 4-5x; the fix bounds the *rendered* message instead, trimming the escaped tail from the front and never through an entity (a half-cut `&amp;` would swap the error for \"can't parse entities\"), with a visible trimmed-to-fit marker. 5 new tests. **P0-8 (found, not fixed - see ## Open findings)**: `wedged-recovery.ts` kills a wedged session expecting the crash-resume path to relaunch it, but the killed process runs its own `SessionEnd` hook on the way out, which marks the row `dead` 33ms later, and `resumeSession` then correctly refuses to resume a dead row - the session stays dead and the operator's next messages are dropped with only a WARN. That module's doc comment reasons carefully about not untracking the PTY and misses that a deliberate kill runs hooks a real crash never gets to run. Recorded in the main plan rather than here: quiet mode and `quota_stopped` both live-exercised for the first time, plus the structural reason a tool-heavy storm does not trip quiet mode while a turn-heavy one does - the coalescer's interval scaling holds card edits at the feed budget by design, so it is per-turn card creates and details anchors that exceed it."
  - "1.7.0 (2026-08-12): implemented P0-7, closing the last open finding the same evening it was filed. New `isCoveredByBareToolRule` in `rule-derivation.ts` - placed next to `deriveAlwaysRule` as its exact counterpart (what one writes for a non-Bash tool, the other recognises; a test pins that round trip), and wired into `pipe-server.ts`'s `handlePermissionRequest`, which now reads the session settings file once per request and runs either the Bash compound path or this one. Deliberately conservative: it refuses unless the tool is allow-listed *and* no deny/ask entry mentions that tool in any form, so `♾️ Always` on `Edit`/`Read` still re-prompts (the baseline's `Edit(.env)`/`Edit(~/**)`/`Read(~/**)` rules would have to be matched per-call, i.e. Claude Code's own path globs reimplemented, where a subtle mistake silently auto-approves reads of the secrets those rules protect) while `Write`, `NotebookEdit`, `WebFetch` and MCP tools are fixed; `containsSensitivePath` guards the input preview as a second layer. One self-inflicted regression caught and closed in the same pass: the settings read moved onto every permission request, so a truncated file could have thrown and swallowed the operator's card - now try/caught, falling through to the card, never toward an approval. 17 new tests (precedence cases first, plus pipe-server wiring), 1742/1742, `tsc --noEmit` clean. Live-verified both directions with `always-rule-check.js`: the `write` variant that recorded the bug hours earlier now reports no second card with the file on disk and `auto-approved Write ... already allow-listed for this session` in the log, and the `bash` variant still passes, confirming the shared restructure left the compound path alone. `## Open findings` is empty again and the sequencing table is back to empty by design."
  - "1.6.1 (2026-08-12): P1-9 live-verified against the real Bridge by forcing an actual failing `/new` (a non-repo path registered in repos.toml, unregistered afterwards) - which found two defects in the fix that the unit tests could not have. The log entry spanned two lines, because `logger.ts` prefixes one line per entry while Node embeds the child's stderr in `err.message` with a newline, so `status:`/`stderr:` sat on an unprefixed continuation line and `grep ERROR bridge.log` showed the header without any of the diagnostics the whole finding is about; `formatExecFailureForLog` now collapses newlines to ` / ` and a test asserts it never emits one. And the line read `worktrees root undefined`, since that option is genuinely optional and `launchSession` supplies its own default - now `launcher default`. Also stopped duplicating a stderr that Node had already appended to the message. 3 more tests (1725/1725), `tsc --noEmit` still clean, and the second live run produced one grep-able line carrying slug, repo, root, git's own reason and `status: 128`."
  - "1.6.0 (2026-08-12): implemented P1-9 for real, not just documented, the same evening it was filed. New `exec-failure.ts` (`describeExecFailure`/`formatExitClause`/`formatExecFailureForLog`) pulls `message`/`status`/`signal`/`stderr` off a thrown value in the shape Node actually throws from `execFileSync`, populating each field only when genuinely present so a plain `Error` never gains a meaningless `exit 0`. Wired into *both* launch-failure paths rather than only the `/new` one the finding named - `handleNewCommand` and, more importantly, `resumeSession`, whose catch marks the row `dead` irreversibly and which runs `ensureWorktree` too, so the same `git worktree add` failure can kill a live session instead of merely refusing a new one. An empty stderr is logged as `stderr: (empty)` rather than omitted, since \"the child printed nothing\" is the observation that would have short-cut the original incident. 18 new tests: `exec-failure.test.ts` drives real non-zero-exit child processes rather than hand-built error objects, `session-lifecycle-commands.test.ts` reaches the real `launchSession` against a non-repo directory for a genuine exit 128 (the only launch-failure branch reachable from a unit test, since that module imports `launchSession` directly), and `session-supervisor.test.ts` covers the injectable resume path including the empty-stderr and plain-`Error` cases. 1722/1722 passing, `tsc --noEmit` clean across all 5 packages. P1-9 moved to ## Resolved and struck from the sequencing table; P0-7 is now the only open finding. This does not explain the original incident - its cause is still unknown - it makes a recurrence diagnosable."
  - "1.5.0 (2026-08-12): two new findings, both from running §12 Phase 2's long-open \"does an ♾️ Always tap take effect mid-conversation?\" question against the real fleet instead of reasoning about it (`scripts/telegram-automation/always-rule-check.js`, new). P0-7: the tap is inert for every non-`Bash` tool while the confirmation claims otherwise - a `Write` Always tap writes the derived rule, and the next `Write` in the same conversation raises a fresh card. The `Bash` case only looks correct because that call *also* still escalates and is short-circuited by `pipe-server.ts:582`'s per-request settings re-read, a branch gated on `tool_name === \"Bash\"`; the running Claude Code process never acts on a mid-conversation rule at all. Fix direction is to extend that short-circuit to the non-Bash case, carrying its deny/ask precedence checks with it - not to reword the confirmation. P1-9: a `/new` that dies inside `launchSession` posts `err.message` to Telegram and logs nothing, so a real incident the same evening (every `/new` failing at `git worktree add`, cleared by a restart, cause still unknown) left no trace in `bridge.log` and no exit status to reason from - Node appends a child's stderr to that message, so the empty tail means git exited non-zero printing nothing, which is diagnostic but invisible today. This document therefore reopens: `## Open findings` added, `## Overall read` corrected from \"nothing is currently open\", and the deliberately-empty sequencing table filled with the two stages (P1-9 first, being pure observability)."
  - "0.1.0 (2026-08-12): Frontmatter added — plan previously lacked valid frontmatter"
  - "1.0.0 (2026-08-12): /plan-craft full review. Re-verified every finding against current source: P0-1–P0-4, P1-1–P1-8 (except its still-open test-gap list), and P2-1–P2-6 were already fixed by commit `a511834` (2026-08-09, same day as the audit) — this document's \"Nothing here has been applied yet\" framing has been stale since that commit landed. Restructured around that: only P0-5 (added earlier today) is a live finding; everything else moved to a compact ## Resolved record. Trimmed \"Missing tests\" from 10 items to the 1 (5b/P0-5) that isn't already covered — 9 of 10 already have passing tests. Corrected P1-5's \"statements are never finalized\" overstatement (bun:sqlite finalizes via GC; the real fix was re-parse cost). Refined P0-5's fix direction to reuse the existing `turn_card_msg`-column persistence pattern instead of proposing a new mechanism, noted that `RESUME_NUDGE_FOLLOWUP_DELAY_MS`'s follow-up nudge shares the same in-memory-only limitation (not a mitigation), and flagged Telegram's bot-message edit-age limit as unverified from docs (defensive fallback recommended). Rewrote \"Suggested sequencing\" and \"Verification per stage\" to reflect only the remaining work."
  - "1.1.0 (2026-08-12): /plan-craft pass 2. Corrected a real overclaim: P2-2's \"Resolved\" entry said a private setColumn now exists — it doesn't; only the migrate() if-chain half of that finding was actually fixed, so P2-2 is now marked partially resolved with the remaining setter-unification cleanup carried into ## Still open. Named a third plan (attachment-triggered-session-creation-plan.md) also citing this document's resolved P1-6/P0-2 findings, found by cross-plan re-verification. De-quoted a §4.5 \"convention\" that was this document's own paraphrase, not a literal quote. Softened the turn_card_msg restart-survival rationale to attribute it to the table (per §4.3), not specifically to that column. Removed inconsistent invented §N prefixes from frontmatter section labels so they match actual heading text exactly. Added the P2-2 setter cleanup as a third sequencing stage — it was in ## Still open but missing from the table."
  - "1.1.1 (2026-08-12): /plan-craft pass 3. Fixed 3 stale numeric citations found by a full re-verification of all 18 Resolved bullets: inbound-media.ts's fireAndForget call count was 8, actually 7; fleet-commands.test.ts's test count was 108, actually 133; and the P0-5 live-incident narrative internally said \"three\" restarts/placeholders while also describing \"a fourth\" — corrected to a consistent four (15:50/16:38/16:54/16:59 local), with the two directly-log-confirmed message_ids (3008, 3015) distinguished from the two inferred-by-code-path ones."
  - "1.1.2 (2026-08-12): /plan-craft pass 4. fleet-commands.test.ts's count had already drifted again mid-review (133 → 140, the file is under active development concurrently with this review) — corrected and added a note that any cited test count here is a point-in-time snapshot, not a fact to defend. Cross-plan and codebase re-verification passes both now report zero remaining findings — marked solid."
  - "1.2.0 (2026-08-12): implemented P0-5 and the remaining P2-2 setter cleanup for real, not just documented. P0-5: added a nullable `thinking_placeholder_msg` SessionStore column (same shape as `turn_card_msg`), a `persist` hook on `thinking-placeholder.ts`'s `start`/`consume` (covers every placeholder, not just resume-nudge ones - no special-casing needed since the nudge already shares `sendChannelText`), and a `relabelStalePlaceholder` callback `runStartupReconciliation` now calls for any leftover from the previous process, edited to an honest \"interrupted by a restart\" notice instead of staying \"Thinking...\" forever. P2-2: added the private `setColumn` every typed setter now delegates to. 8 new tests (`thinking-placeholder.test.ts`, `session-supervisor.test.ts`); `tsc --noEmit` clean across all 5 packages; 1632/1632 tests passing monorepo-wide. Moved both to ## Resolved, removed the now-empty P0-5 open section and the P2-2 Still-open entry, closed out missing-test item 1, and rewrote Suggested sequencing/Verification per stage around the one thing not yet done: a live restart-test against the real Bridge, deliberately left for the operator to trigger rather than done unprompted."
  - "1.2.1 (2026-08-12): P0-5 live-verified against the real Bridge, per operator request. Two real restarts against a throwaway session (`p0-5-check`), reproducing the `unify-work-with-voice-and` scenario exactly: both placeholders got correctly relabeled to \"Interrupted by a restart - resuming...\", none left stuck; the pre-existing lost-pending-question mechanism fired correctly alongside it with no interference. Throwaway session killed and removed afterward. Removed stage 1 (P0-5 live-verify) from Suggested sequencing - only the P1-8 test-gap stage remains."
  - "1.4.0 (2026-08-12): new finding P0-6, found and fixed the same evening from a real incident - `resolveHookClientBinary`'s stale-binary rebuild threw out of `execFileSync` on the launch path (Windows `EPERM`: `bun build --compile` can't replace a mapped `.exe`, and a blocked `--ask` hook client keeps the old one mapped indefinitely), surfacing as an uncaught exception that killed the daemon seconds after a `/restart` and took the whole fleet down over a merely-stale binary. Extracted `ensureHookBinary` (fresh/stale/missing state + degrade-to-existing-binary-with-WARN on failure, rethrowing only when there is no binary at all), stopped caching a degraded resolution so the next launch retries, and threaded the launch `log` through. Second half of the same incident: bun orphans a ~94MB `.<hash>-NNNNNNNN.bun-build` temp file in the *package* dir (not `dist/`) when the rename fails, so it showed up as untracked in `git status` - `*.bun-build` added to `.gitignore`, with the sweep-on-failure alternative deliberately rejected (a concurrent launch's in-progress build writes an indistinguishable temp file). 7 new tests; `tsc --noEmit` clean across all 5 packages; 1704/1704 passing; live-verified by a real restart."
  - "1.3.0 (2026-08-12): closed out the last open item - P1-8's remaining test gaps - for real, not just documented. card-senders.ts/fleet-reporting-commands.ts got real wiring/guard coverage (their own doc comments' low-risk claim confirmed, not assumed). channel-server/src/index.ts and hook-client/src/index.ts were both genuinely untestable as entry-point scripts, so each got a small, behavior-preserving extraction (channel-handlers.ts, run-hook.ts) making the real dispatch logic injectable. send-once.ts got real socket-level tests despite its own doc comment arguing against them, surfacing a real bun-vs-Node socket-backpressure difference worth recording. protocol/src/types.ts (no runtime behavior beyond assertValidBehavior, already covered elsewhere) got a compile-time exhaustiveness check locking the Message union's own completeness. 61 new tests; tsc --noEmit clean across all 5 packages; 1697/1697 passing monorepo-wide. Nothing remains open in this document - Suggested sequencing is now empty by design."
v180_touched_sections:
  - section: "Open findings"
    type: modified
    summary: "Added P0-8 (wedged-recovery's kill defeated by the killed process's own SessionEnd hook), with the measured 33ms sequence and a fix direction that warns the test ordering is the whole bug."
  - section: "Resolved (verified against current code, 2026-08-12)"
    type: modified
    summary: "Added P1-10: /attach's rendered card overflowed Telegram's 4096-unit cap and produced total silence; now bounds the rendered message rather than the raw buffer."
  - section: "Suggested sequencing"
    type: modified
    summary: "One stage again (P0-8), with the note that a test firing SessionEnd and the exit callback in the convenient order would pass against the broken code."
v170_touched_sections:
  - section: "Resolved (verified against current code, 2026-08-12)"
    type: modified
    summary: "Added the P0-7 implementation record, including the deliberate Edit/Read limit and its reasoning, and the both-directions live verification."
  - section: "Open findings"
    type: modified
    summary: "Emptied - P0-7 collapsed into a <details> block for its reasoning, with the shipped behavior in ## Resolved."
  - section: "Suggested sequencing"
    type: modified
    summary: "Back to an empty table by design; adds a note that P0-7's Edit/Read limit is a recorded design decision, not a carried-forward finding."
  - section: "Overall read"
    type: modified
    summary: "Both 2026-08-12 findings now resolved; test total updated to 1742."
v160_touched_sections:
  - section: "Resolved (verified against current code, 2026-08-12)"
    type: modified
    summary: "Added the P1-9 implementation record: exec-failure.ts, both launch paths wired, 18 tests, and the explicit note that the original incident's cause is still unknown."
  - section: "Open findings"
    type: modified
    summary: "P1-9 removed (implemented); P0-7 is the only open finding."
  - section: "Suggested sequencing"
    type: modified
    summary: "P1-9 struck through as done; P0-7 promoted to stage 1, with the always-rule-check.js re-run named as its live check."
v150_touched_sections:
  - section: "Open findings"
    type: added
    summary: "New section for P0-7 (Always is inert for non-Bash tools) and P1-9 (a launch failure reports no reason and logs nothing), both found live 2026-08-12."
  - section: "Overall read"
    type: modified
    summary: "Corrected \"nothing in this document is currently open\" - scoped that claim to the 2026-08-09 audit and pointed at the two new findings."
  - section: "Suggested sequencing"
    type: modified
    summary: "Filled the deliberately-empty table with the two stages: P1-9 (observability) first, then P0-7 (widened auto-approve, needs precedence tests)."
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

**Every finding from the 2026-08-09 audit has been implemented, tested, and (where it was a live
behavioral bug rather than a documentation/cleanup item) live-verified, as of 2026-08-12** — P0-5's
persist-and-relabel mechanism, P2-2's setter cleanup, P1-8's remaining test gaps, and P0-6 (added
late the same evening from a real fleet-down incident) all closed the same day. `tsc --noEmit` is
clean across all 5 packages; the full suite is at 1704/1704 tests passing. Every item is recorded
compactly under **## Resolved** for traceability rather than deleted outright.

**Two new findings landed later the same evening**, both out of running §12 Phase 2's long-standing
"does an `♾️ Always` tap actually take effect mid-conversation?" question against the real fleet
rather than reasoning about it — which is also how P0-6 was found earlier the same day. **P0-7**
(`♾️ Always` inert for every non-`Bash` tool) and **P1-9** (a failed launch reported no reason and
logged nothing) were both implemented, tested and live-verified the same evening; both are in
**## Resolved**, and **## Open findings** is empty again. The suite is at 1742/1742.

---

## Open findings

- **P0-8 — a wedged session is killed for a resume that never comes, and the operator's messages are
  then silently dropped.** Found live 2026-08-13 while forcing a feed storm for §12 Phase 6a's quiet
  mode check; not yet fixed. `wedged-recovery.ts` deliberately does *not* remove the slug from the
  PTY map before killing, precisely so `handleUnexpectedExit` reads the exit as a crash and
  `resumeSession` relaunches it - its doc comment calls that "the one regression that would silently
  defeat the whole fix". The mechanism is defeated anyway, by a race nothing in that reasoning
  accounts for: **the killed `claude` process runs its own `SessionEnd` hook on the way out**, and
  that hook marks the row `dead` before the exit handler gets there. Measured, 33 milliseconds end to
  end:

  ```
  06:18:52.849  WARN  ...PTY write-socket is dead... killing it so the existing crash-resume path can relaunch it
  06:18:52.881  INFO  hook client connected for event "SessionEnd" (slug "stormcheck2-...")
  06:18:52.882  WARN  ...hook event "SessionEnd" (reason: other) is marking the row dead
  06:18:52.883  INFO  session "stormcheck2-..." state idle -> dead
  ```

  `resumeSession` then finds a `dead` row and bails - correctly, per P0-1's own guard. The session
  stayed dead, and the next three operator messages were dropped with nothing but
  `WARN no live session for slug "..." - inbound message dropped`. The asymmetry the original
  reasoning missed: a *real* crash dies without running hooks, so no `SessionEnd` arrives, while a
  deliberate `kill()` gives the process time to run them - which is exactly what makes a
  wedged-recovery kill distinguishable from a crash after all, just through a channel nobody checked.
  **Fix direction:** mark the intent explicitly rather than inferring it. A `recoveringWedged` set
  (or a per-slug flag) written before the `kill()` and consulted by the `SessionEnd` handler, so that
  hook skips the mark-dead for a Bridge-initiated recovery kill and lets the resume proceed; clear it
  on resume or on a timeout so a genuinely dead session can still settle. Needs a unit test that
  drives `SessionEnd` *between* the kill and the exit callback - the ordering is the whole bug, and a
  test that fires them in the convenient order would pass against the broken code.

_(P0-7 and P1-9, both filed on the evening of 2026-08-12, were implemented the same evening - see
**## Resolved**, along with P1-10 from 2026-08-13.)_

<details>
<summary>P0-7 as originally filed (kept for the reasoning; see ## Resolved for what shipped)</summary>

- **P0-7 — `♾️ Always allow this pattern` is inert for every non-`Bash` tool, while telling the
  operator it worked.** Measured live 2026-08-12 with
  `scripts/telegram-automation/always-rule-check.js` (two variants, real throwaway sessions; see
  §12 Phase 2 of the main plan for the result table). Tapping `♾️ Always` on a `Write` card writes
  the derived bare-`Write` rule into the session's settings file and confirms "allowed, and added
  `Write` for this session" - and the very next `Write` in that same conversation raises a fresh
  card. The `Bash` case looks fine, but for a reason that does not generalise: that call also still
  escalates (its `PermissionRequest` hook fires), and only avoids a card because
  `pipe-server.ts:582` re-reads the settings file per request and auto-approves through
  `isCompoundCommandFullyAllowed` - a branch gated on `msg.tool_name === "Bash"`. So the running
  Claude Code process never acts on a mid-conversation rule; `Bash` just happens to have a
  compensating path in front of it and nothing else does.
  **Fix direction:** extend the same fresh-read short-circuit to the non-Bash case - when a
  permission request arrives for tool `T` and the just-read `permissions.allow` already contains the
  bare `T`, send `allow` without posting a card, mirroring the Bash branch (including its
  `deny`/`ask` precedence checks, which a bare tool name must not be allowed to jump). Deliberately
  *not* "reword the confirmation to say it takes effect after a relaunch": the derived rule is
  already written and already correct, and the operator's model of what the button does is the one
  worth preserving. Needs a unit test per tool class (a `Write` allow-listed by a previous tap
  auto-approves; an `ask`/`deny` entry still wins; an unrelated tool still posts a card), plus a
  re-run of `always-rule-check.js --variant write` as the live check - it currently records the bug
  and would flip to recording the fix.

</details>

_(P1-9 was implemented the same evening it was filed too - see **## Resolved** below.)_

---

## Resolved (verified against current code, 2026-08-12)

All items below were open in the 2026-08-09 audit and confirmed fixed in commit `a511834` (same
day) unless noted otherwise. Kept as a compact record for traceability — see that commit for
implementation detail.

- **P1-10** (`/attach` produced no output at all against a real PTY tail) — found and fixed
  2026-08-13, the first time §12 Phase 5's never-live-exercised `/attach` was run against a real
  multi-line tail. The rendered card exceeded Telegram's 4096-unit cap, so the P1 send failed three
  times with `Bad Request: message is too long` and the operator got **silence** - no output, no
  error, since a failed command confirmation is only a log line. The arithmetic: `routing.ts` bounds
  the raw ring buffer at 4000 chars, `renderAttach` then HTML-escapes it, and PTY output is dense in
  `<`, `>` and `&`, each becoming a 4-5 character entity, so a full buffer plus the card's own
  wrapper lands past the limit routinely. Bounding the raw buffer harder would not fix it (a tail of
  all `&` expands 5x), so `renderAttach` now bounds the *rendered* message: it trims the escaped tail
  from the front - keeping the newest output, which is the point of a tail - and never through an
  HTML entity, since a half-cut `&amp;` swaps "message is too long" for "can't parse entities". An
  "... (earlier output trimmed to fit)" marker says so. 5 new tests including the worst-case
  all-ampersand tail and an every-offset sweep for entity splitting.
- **P0-7** (`♾️ Always` inert for every non-`Bash` tool) — filed and fixed the same evening,
  2026-08-12. New `isCoveredByBareToolRule(toolName, inputPreview, settings)` in
  `rule-derivation.ts`, deliberately placed next to `deriveAlwaysRule` as its exact counterpart:
  what one *writes* for a non-Bash tool (the bare tool name), the other *recognises*, and a test
  pins that round trip rather than restating the string. `pipe-server.ts`'s
  `handlePermissionRequest` now reads the session's settings file once per request and runs the
  Bash compound path or this one, so an `♾️ Always` tap takes effect for the rest of the
  conversation instead of sitting on disk unused.
  **Deliberately conservative, and this is the part worth remembering:** it refuses unless the tool
  is allow-listed *and* no `deny`/`ask` entry mentions that tool in any form, bare or scoped. So an
  `♾️ Always` on `Edit` (or `Read`) still re-prompts, because the generated baseline carries
  `Edit(.env)`/`Edit(~/**)`/`Read(~/**)` and friends. Honouring those correctly would mean deciding
  whether *this call's* path matches a scoped glob - reimplementing Claude Code's own path-glob
  semantics (`~` expansion, `**`, Windows case/separator quirks) - where a subtle mistake silently
  auto-approves access to the very secrets those rules exist to protect. Refusing leaves
  `Edit`/`Read` exactly as they behave today and fixes `Write`, `NotebookEdit`, `WebFetch`, MCP
  tools and everything else with no scoped entry. `containsSensitivePath` is applied to the raw
  input preview as a second guard, mirroring the Bash path, so an allow-listed `Write` to
  `~/.ssh/config` is still refused. One regression this introduced and closed in the same pass: the
  settings read moved onto *every* permission request (it used to run only for a Bash call with a
  parseable preview), so a truncated settings file could have thrown and taken the operator's card
  with it - it is now try/caught, falling through to the normal card, never toward an approval.
  17 new tests (`rule-derivation.test.ts` for the decision itself, precedence cases first;
  `pipe-server.test.ts` for the wiring, including the no-`stateDir` and sensitive-path fall-throughs).
  1742/1742 passing, `tsc --noEmit` clean across all 5 packages.
  **Live-verified both directions** with `scripts/telegram-automation/always-rule-check.js`: the
  `write` variant, which recorded the bug hours earlier, now reports `secondCardSeen: false` with
  `archeck-write-b.txt` on disk and `INFO auto-approved Write for slug "..." - already allow-listed
  for this session` in `bridge.log`; the `bash` variant still passes, confirming the shared
  restructure didn't disturb the compound path.

- **P1-9** (a failed launch reported no reason and logged nothing) — filed and fixed the same
  evening, 2026-08-12. New `exec-failure.ts`: `describeExecFailure(err: unknown)` pulls `message`,
  `status`, `signal` and `stderr` off a thrown value in the shape Node actually throws from
  `execFileSync`, populating a field only when it is genuinely there (so a plain `Error` never gains
  a meaningless `exit 0`); `formatExitClause` renders the operator-facing ` (exit 128)` /
  ` (killed by SIGKILL)` clause, and `formatExecFailureForLog` the `bridge.log` line. Wired into
  **both** launch-failure paths, not just the `/new` one the finding named:
  `session-lifecycle-commands.ts`'s `handleNewCommand` (now logs `ERROR launch failed for "<slug>"
  (repo ..., worktrees root ...)` before it deletes the topic it had created), and
  `session-supervisor.ts`'s `resumeSession` - the more important of the two, since that branch marks
  the row `dead` irreversibly, and `ensureWorktree` runs on a resume as well, so the same
  `git worktree add` failure can kill a live session rather than merely refuse a new one. An empty
  stderr is reported as `stderr: (empty)` rather than omitted: "the child printed nothing" is the
  observation that would have short-cut the incident, and a missing line is indistinguishable from a
  missing check. 18 new tests (`exec-failure.test.ts`, driving real non-zero-exit child processes
  rather than hand-built error objects; plus wiring tests in `session-lifecycle-commands.test.ts` -
  which reaches the real `launchSession` against a non-repo directory for a genuine exit 128, the
  only launch-failure branch reachable from a unit test - and `session-supervisor.test.ts`).
  1725/1725 passing, `tsc --noEmit` clean across all 5 packages. Note this makes a recurrence
  *diagnosable*; it does not explain the original incident, whose cause remains unknown.
  **Live-verified, and the live run found two defects the unit tests could not.** A real failing
  `/new` was forced by registering a non-repo path in `repos.toml` (§7.5's own documented way to add
  a repo), then unregistered afterwards. (1) The log entry spanned *two* lines, because `logger.ts`
  prefixes one line per entry and Node embeds the child's stderr in `err.message` with a newline -
  so `status:`/`stderr:` landed on an unprefixed continuation line and `grep ERROR bridge.log`
  showed the header with none of the diagnostics the finding exists to provide. `formatExecFailureForLog`
  now collapses newlines to ` / ` and is asserted never to emit one. (2) The line read
  `worktrees root undefined`, since `fleetWorktreesRoot` is genuinely optional and `launchSession`
  supplies its own default - now `launcher default`, so nobody hunts a config bug that isn't there.
  Also suppressed a duplicated stderr (Node had already put it in the message). Final live result,
  one grep-able line: `ERROR launch failed for "p19probe-second-verification-pass" (repo
  C:\Users\...\Temp, worktrees root launcher default): Command failed: git worktree add ... / fatal:
  not a git repository (or any of the parent directories): .git | status: 128`, with the operator's
  own message carrying `(exit 128)`.

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

The 2026-08-09 audit (P0-1 through P0-6, P1-1 through P1-8, P2-1 through P2-6) is fully closed, as
are P0-7 and P1-9 (2026-08-12) and P1-10 (2026-08-13). One finding remains.

| Stage | Contents | Risk |
|---|---|---|
| 1 | **P0-8** - stop the killed process's own `SessionEnd` hook from marking the row `dead` before `wedged-recovery.ts`'s intended crash-resume can run | Moderate, and the risk is in the *test*, not the change: the fix is a small explicit-intent flag, but a test that fires `SessionEnd` and the exit callback in the convenient order passes against the current broken code. Drive them in the order the incident actually produced (hook first, 33ms ahead of the exit) or the test proves nothing. Also make sure the flag clears - a stuck one would keep a genuinely dead session from ever settling. |

One thing this document deliberately does **not** carry forward as a finding: P0-7's fix leaves
`♾️ Always` re-prompting for `Edit` and `Read`, because the baseline's scoped deny rules for those
tools make a bare-name grant unsafe to honour without reimplementing Claude Code's path globs. That
is a recorded design limit with its reasoning in P0-7's entry, not an open item - if it ever needs
revisiting, the trigger is an operator actually being bothered by repeated `Edit` cards, not this
list.

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
