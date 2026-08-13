---
version: 1.0.0
status: implemented
last_modified_utc: 2026-08-12T20:05:00Z
changelog:
  - "1.0.0 (2026-08-12): status draft -> implemented, recording the outcome against the plan rather than restating it. Found by a \"what's left to implement\" sweep across this folder: all 15 extractions (items 1-15) are in the tree and the split finished in `3e547c2` (\"extract callback-query-router.ts from index.ts (module 15/15)\"), one commit per module as the migration approach specified, so this document had been describing work already done for four days. Verified item by item rather than assumed - all 15 module files exist, all 15 have their own test file (405 tests between them; `card-senders.ts` and `fleet-reporting-commands.ts` got theirs later, via `codebase-hardening-plan.md`'s P1-8 closeout, having been deliberately proposed without one here), and both DRY fixes landed as specified: `confirm-cards.ts` exports the unified `finalizeCard` *and* `takeOrNotifyGone` (item 5's two halves), and `session-lifecycle-commands.ts`'s `resolveSessionOrBail`/`getRowOrReportMissing` pair has 12 call sites with zero surviving `sessionStore.get(slug) as NonNullable<...>` casts - the partial-migration failure item 7 warned about did not happen. One real deviation recorded honestly instead of quietly: `index.ts` is 1,152 lines, not the 300-400 this plan estimated. It is a composition root by content (62 store/registry constructions, 23 `create*`/`start*` factory calls, the dev-control debug server item 1 always meant to keep there, and 3 wiring closures) - the estimate simply underestimated how much room 23 multi-line dependency-injection literals take, which is a KISS-shaped cost the pattern buys deliberately, not leftover business logic. See ## Outcome."
  - "0.3.0 (2026-08-08): Deep SOLID/DRY/KISS adversarial pass — fixed the state-variable count (~25 -> ~31) and confirm-registry count (five -> four); found and assigned a home for the previously-orphaned onUpdate plain-message routing/stale-gating logic (folded into inbound-media.ts); corrected the resolveTargetSlug DRY-fix count (was missing handleRmCommand, missed a second cast site in handleVerboseCommand); split fleet-admin-commands.ts into fleet-reporting-commands.ts and deploy-lifecycle-commands.ts to fix its own SRP violation; expanded callback-query-router.ts's description to name its actual inline handler bodies and dependencies instead of undersеlling it as pure dispatch; found and assigned a third DRY fix (the four confirm-registries' take/notify-gone/mark-expired preamble, one layer above the finalize-call duplication already caught); flattened the nested module list (old item 7's four sub-bullets) into a single flat 1-16 numbering to remove the ambiguity that caused the 'all 12 modules' stale-count bug in the previous pass; added two new Risks (resumeAttempts cross-module write access, and a real main()-construction-order dependency introduced by converting quota-alarms.ts's closure-based forward reference to constructor injection); added a dev-control debug-server accessor note to session-supervisor.ts; added 4 new test files (deploy-lifecycle-commands.test.ts, quota-alarms.test.ts, nl-dispatch.test.ts, inbound-media.test.ts) and expanded 2 existing ones (confirm-cards.test.ts, callback-query-router.test.ts) to close test-coverage gaps flagged against the plan's own stated risk severity"
  - "0.2.1 (2026-08-08): Pass 2 review — fixed a stale 'all 12 modules extracted' figure in Verification to match the module list's actual count (14 new modules, item 12 being index.ts itself); no other findings, plan is solid"
  - "0.2.0 (2026-08-08): Pass 1 review — corrected stale sibling-file line counts and import count, tightened the /commands dispatch-order bug description to match the actual code comment, added a Bun test-runner note (injectable scheduler + setSystemTime afterEach reset) to the two timing-sensitive test files, flagged CLAUDE.md's stale Phase-1 roadmap framing in the Overview, and fixed a stale 'see Test plan below' cross-reference in Migration approach to point at the actual Testing heading"
  - "0.1.0 (2026-08-08): Initial plan created"
v100_touched_sections:
  - section: "Outcome"
    type: added
    summary: "New section recording what actually shipped: 15/15 modules, both DRY fixes verified present, per-module test counts, and the one deviation (index.ts at 1,152 lines vs the 300-400 estimate) with its cause."
  - section: "Verification"
    type: modified
    summary: "Each check marked done/not-done against the real tree rather than left as an instruction; the post-split live confirm-card sweep is recorded as never run as one deliberate pass."
v020_touched_sections:
  - section: "§Overview"
    type: modified
    summary: "Added note flagging CLAUDE.md's/the referenced plan's stale Phase-1 roadmap framing"
  - section: "§Current-state inventory"
    type: modified
    summary: "Corrected import count (45 -> 62 distinct sibling modules) and tightened the /commands dispatch-order bug description with its exact code location"
  - section: "§Other large files: verdicts (not in scope for this plan)"
    type: modified
    summary: "Corrected 6 of 7 stale sibling-file line counts (telegram.ts, pipe-server.ts, nl-router.ts, session-launcher.ts, worktree-fs.ts, rate-governor.ts) and added a drift caveat"
  - section: "§Testing"
    type: modified
    summary: "Added Bun test-runner notes (injectable scheduler, setSystemTime afterEach reset) to session-supervisor.test.ts and pty-io.test.ts; tightened the command-dispatch.test.ts regression description"
  - section: "§Migration approach"
    type: modified
    summary: "Fixed a stale 'see Test plan below' cross-reference to point at the actual Testing heading"
v021_touched_sections:
  - section: "§Verification"
    type: modified
    summary: "Fixed a stale 'all 12 modules extracted' figure to match the module list's actual count"
v030_touched_sections:
  - section: "§Overview"
    type: modified
    summary: "Corrected state-variable count (~25 -> ~31), confirm-protocol count (five -> four), and module count (14 -> 15 new modules)"
  - section: "§Current-state inventory"
    type: modified
    summary: "Corrected state-variable list (~31, four confirm registries) and named the orphaned onUpdate plain-message-branch logic"
  - section: "§Proposed module split"
    type: modified
    summary: "Flattened nested numbering to 1-16; split fleet-admin-commands.ts into fleet-reporting-commands.ts + deploy-lifecycle-commands.ts; expanded inbound-media.ts and callback-query-router.ts scope/deps; added third DRY fix to confirm-cards.ts; added dev-control accessor note to session-supervisor.ts"
  - section: "§Risks"
    type: modified
    summary: "Added resumeAttempts cross-module write-access risk and a main()-construction-order risk introduced by closure-to-injection conversion"
  - section: "§Testing"
    type: modified
    summary: "Added deploy-lifecycle-commands.test.ts, quota-alarms.test.ts, nl-dispatch.test.ts, inbound-media.test.ts; expanded confirm-cards.test.ts and callback-query-router.test.ts; fixed session-lifecycle-commands.test.ts's call-site count"
  - section: "§Verification"
    type: modified
    summary: "Updated module count (15, item 16 being index.ts) and added the third DRY fix to the grep-for-duplication check"
---

# Split `packages/bridge/src/index.ts` into modules

> **Status: implemented.** All 15 extractions landed one commit per module, finishing at `3e547c2`
> ("extract callback-query-router.ts from index.ts (module 15/15)"). `index.ts` went 3,690 → 1,152
> lines and holds no business logic. The sections below are kept in their original
> *plan* voice (present/future tense, "will extract") rather than rewritten past-tense — see
> **## Outcome** at the bottom for what actually shipped, including the one deviation from this
> plan's own estimate.

## Overview

**Audience:** aibridge maintainers (currently: solo developer working with Claude Code)

`packages/bridge/src/index.ts` is 3,690 lines — a single `async function main()` containing ~95
function declarations that all close over ~31 shared mutable state variables (session maps, confirm
registries, feed state, PTY process tables, etc.). Every other file in `packages/bridge/src/` is a
cohesive, appropriately-sized module (the next largest, `fleet-commands.ts`, is 778 lines and earns its
size — pure parsing/rendering with no shared mutable state and its own 801-line test file).
`index.ts` is the sole outlier, has zero direct test coverage, and violates Single Responsibility by
mixing bootstrap, PTY supervision, feed rendering, four separate confirm-card protocols, ~25
fleet-command handlers, NL-routing glue, and a Telegram callback-query router in one function scope.

This plan defines an incremental, dependency-ordered extraction into ~15 new modules following the
`factory(deps) -> { functions }` injection pattern the codebase already uses in `pipe-server.ts`
(`startPipeServer(opts)`), leaving `index.ts` as a thin composition root. Extraction proceeds leaf
modules first so `index.ts` keeps compiling and passing tests at every intermediate commit — no
big-bang rewrite. Each extraction step also adds unit tests for previously-untested logic that becomes
newly reachable in isolation, per [`CLAUDE.md`](../CLAUDE.md) §9's "silent-wrong helpers and
protocol/exit-code contracts must be unit-tested" convention.

**Note on roadmap framing:** `CLAUDE.md`'s "Phase 1 ('walking skeleton'...) has not been started"
framing (and, separately, the referenced plan's own §7.6/changelog text asserting the same) is stale
relative to the actual codebase — `index.ts` at 3,690 lines with ~14 already-extracted sibling modules,
plus the same plan's own §12 body marking Phases 1–5 "complete," describes a project well past a walking
skeleton. This split does not depend on resolving that discrepancy; it's flagged here only so a future
reader doesn't assume Phase-1-or-earlier framing gates this work.

## Current-state inventory

Read in full: 3,690 lines. Structure:

- Lines 1–172: ~60 import statements from 62 distinct sibling modules — confirms `index.ts` is a
  *consumer* of already-extracted modules, not a duplicate of their logic.
- Lines 178–196: module-scope constants (`RESUME_BACKOFF_MS`, `MAX_CONSECUTIVE_RESUME_ATTEMPTS`) and
  the `process.on("uncaughtException"/"unhandledRejection")` crash handlers plus `initFileLogging()`,
  which correctly run before `main()` is even called.
- Lines 201–203: `isControlTopic()` — the one free top-level function, pure but untested.
- Lines 205–3688: the body of `main()`, declaring ~31 shared `let`/`Map`/`Set` state variables —
  `routing`, `sessionStore`, `settingsStore`, `detailsAnchorStore`, `assistEnabled`, `nlRouterBackend`,
  `voiceConfirmEnabled`, `defaultSessionMode`, `defaultSessionEffort`, `costTracker`, `reposRegistry`,
  `ptyProcessBySlug`, `resumeAttempts`, `lastPtyActivityBySlug`, the four confirm registries
  (`fleetConfirmRegistry`, `staleConfirmRegistry`, `voiceConfirmRegistry`, `nlConfirmRegistry`),
  `retryStore`, `browseRegistry`, `feedStates`, `feedMessageIds`, `feedInterjected`, `feedGovernor`,
  `feedCoalescer`, `usageWaiters`, `channelConnectCoordinator`, `bootReadyAt`, `seq`,
  `quietModeNotified`, `lastBurnAlarmMs` — followed by the ~95 functions that read/write that state.
- Lines 857–895: a dev-control debug HTTP server that reads `ptyProcessBySlug.get(slug)` directly and
  writes to the raw PTY. It stays in the composition root after the split (it's a debug/ops tool, not
  business logic), but once `ptyProcessBySlug` moves into `session-supervisor.ts`'s ownership (item 1
  below), this server needs an injected accessor instead of the raw map reference — see item 1.
- Lines 3562–3661: the `onUpdate` handler's plain-message branch — stale-inbound gating
  (`hasActionableContent`, `isStaleInbound`) and media-type sniffing (photo/document/video/audio/
  video_note routing to `handleAttachmentMessage` vs. voice routing vs. falling through to
  `dispatchInboundMessage`). This ~100 lines of real business logic isn't named by any module in an
  earlier draft of this plan — it's assigned to `inbound-media.ts` (item 6 below), since it's the
  natural entry point that decides *which* of that module's handlers to call.

No `index.test.ts` exists today, and no test file imports from `../src/index.ts`. The closest thing to
coverage is `test/walking-skeleton.test.ts` (137 lines), which exercises `pipe-server.ts`/`routing.ts`/
`telegram.ts` end-to-end but never touches `main()`'s own orchestration logic — dispatch order, confirm
card wiring, and the callback-query mega-switch are today verified only by live Telegram round-trips.
(There's already been at least one live bug from dispatch order alone, documented in-code at
`index.ts:2929-2936`: the `/commands` list-filter branch matched greedily *before* the `/commands <name>`
invocation-parse branch could run, making the documented `/cmd` synonym form unreachable even though a
dedicated unit test for the parser in isolation passed throughout — reachability is a dispatch-order
property, not a parser one.)

## Proposed module split

Listed leaf-first (fewest internal dependencies) to composition-root-last, as a single flat 1–16 list
(an earlier draft nested four sub-files under one numbered item, which produced an ambiguous "module 7"
vs. "12 modules" count that survived two review passes before being caught — flattening removes that
ambiguity). Each module is a `create<Name>(deps)` factory returning the functions `index.ts` needs,
mirroring `pipe-server.ts`'s `startPipeServer(opts)` shape — dependencies (state, callbacks) are
constructor arguments, never re-imported or re-implemented downstream.

1. **`session-supervisor.ts`** — `isPidAlive`, `reapRowsWithDeletedTopics`, `reportOrphanProcesses`,
   `runStartupReconciliation`, `wireSession`, `handleUnexpectedExit`, `resumeSession`; owns
   `ptyProcessBySlug`/`resumeAttempts`/`lastPtyActivityBySlug` and the `RESUME_BACKOFF_MS`/
   `MAX_CONSECUTIVE_RESUME_ATTEMPTS` constants. Takes `sessionStore`, `routing`, `log`, and a
   `confirmSessionCommand`-shaped callback as injected deps. The single most self-contained seam in the
   file and the highest-value first extraction: currently has zero test coverage despite being exactly
   the "silent-wrong" class CLAUDE.md §9 flags. **Also exposes a small read accessor (e.g.
   `getPtyProcess(slug)`) and a mutator (e.g. `clearResumeAttempts(slug)`)** for two consumers that need
   controlled access to this module's owned state without reaching into the raw maps directly: the
   dev-control debug HTTP server (stays in the composition root, item 16) and `feed-wiring.ts` (item 3,
   see Risks).
2. **`pty-io.ts`** — `sendRaw`, `sendEffortCommand`, `confirmSubmitted` (the lost-Enter retry timing
   state machine), `autoRecoverWedgedSession`, `sendChannelText`; owns `SUBMIT_CONFIRM_WINDOW_MS`/
   `ECHO_SETTLE_MS` and the `seq` counter. Depends on `routing` (for `getPtyWrite`) and the
   typing/thinking indicators. Needs an injectable clock/timeout source so `confirmSubmitted`'s retry
   timing becomes testable without real delays.
3. **`feed-wiring.ts`** — `handleHookEvent`, `postDetailsButton`, `maybeSetState`, the
   `feedCoalescer`'s `onFlush` closure builder, and the periodic sweep body (permission/browse/
   details-anchor/confirm-registry ×4/ask expiry + quiet-mode notice). Glue over already-tested
   `feed-state.ts`/`feed-coalescer.ts`/`rate-governor.ts` — extraction here is a readability/SRP win
   more than new test surface, since the pure logic underneath is already covered. `handleHookEvent`
   calls `resumeAttempts.delete(slug)` today — after the split this must go through
   `session-supervisor.ts`'s injected `clearResumeAttempts(slug)` mutator (item 1), not a raw `Map`
   reference, since item 1 is this state's sole owner (see Risks).
4. **`quota-alarms.ts`** — `slugForSessionId`, `markQuotaStopped`, `maybeFireBurnRateAlarm`;
   owns `BURN_RATE_THRESHOLD_USD`/`BURN_RATE_ALARM_COOLDOWN_MS`. Small and cleanly separable; depends
   on `sessionStore`/`costTracker`/an injected send callback. Kept as its own file rather than folded
   into `feed-wiring.ts` (both are plausible homes for it) because its dependency is `costTracker`/quota
   state, not feed-render state — the two modules would otherwise share no real state, only adjacency in
   `main()`'s current source order.
5. **`confirm-cards.ts`** — `finalizeCard`, `markConfirmCardExpired`, `markNlConfirmCardExpired`,
   `notifyConfirmGone`, `finalizeFleetConfirmMessage`, `finalizeStaleConfirmMessage`,
   `finalizeVoiceConfirmMessage`, `finalizeNlConfirmMessage`. This fixes a documented DRY violation:
   the code's own comments already call out that the four confirm-card finalize paths differ only in
   which field holds the message id. Extraction turns an acknowledged duplication into an enforced
   single implementation, and unlocks unit tests for the finalize/expire logic that today only run
   inside a live confirm flow. **Also fixes a second, undocumented DRY violation one layer above the
   first:** all four callback-query confirm-action branches (`fleetConfirmAction`, `nlConfirmAction`,
   `staleConfirmAction`, `voiceConfirmAction`) repeat an identical
   "take from registry → `notifyConfirmGone` if missing → `markXExpired` if expired → proceed with the
   pending entry" preamble, differing only in which registry and which mark-expired function is
   plugged in. Add a single `takeOrNotifyGone(registry, id, msgId, markExpiredFn)` helper here
   alongside the existing finalize unification, so the module fixes both duplication layers in one pass.
6. **`inbound-media.ts`** — `handleVoiceMessage`, `handleAttachmentMessage`, `postStaleConfirm`,
   `notifyStaleAttachment`, **plus the `onUpdate` plain-message routing entry point** (stale-inbound
   gating via `hasActionableContent`/`isStaleInbound`, and media-type sniffing that decides whether a
   given update routes to `handleAttachmentMessage`, `handleVoiceMessage`, or falls through to
   `dispatchInboundMessage`) — this is the orphaned logic named in Current-state inventory above; it
   belongs here because it's the entry point that decides which of this module's own handlers to call.
   Takes `dispatchInboundMessage` as an **injected callback**, not a direct import, to avoid a circular
   dependency (see Risks).
7. **`session-lifecycle-commands.ts`** — `handleNewCommand`, `handleLsCommand`, `handleKillCommand`,
   `handleRmCommand`, `handleAttachCommand`, `handlePauseCommand`, `handleDetailCommand`,
   `handleVerboseCommand`, `resolveTargetSlug`, `killSessionRow`, `removeSessionRow`,
   `postOrphanTopicRmConfirm`. Also introduces one shared "resolve slug or bail" helper that returns
   the session row directly — today `resolveTargetSlug` plus a `sessionStore.get(slug) as
   NonNullable<...>` cast is repeated verbatim across **six** call sites: `handleAttachCommand`,
   `handlePauseCommand`, `handleDetailCommand`, `handleVerboseCommand` (which has the cast **twice**, in
   two separate branches — seven cast occurrences total across the six sites), `handleKillCommand`, and
   `handleRmCommand` (missed in an earlier draft of this plan). All six must be migrated onto the one
   shared helper — a partial migration that skips `handleRmCommand` or only fixes one of
   `handleVerboseCommand`'s two occurrences leaves the DRY violation half-fixed. This is a second,
   smaller DRY fix alongside item 5.
8. **`fleet-reporting-commands.ts`** — `handleBudgetCommand`, `handleSettingsCommand`,
   `handleReposCommand`. Split out from a single `fleet-admin-commands.ts` (see item 9) because
   bundling these read-only reporting commands with process/deploy lifecycle and Windows Task Scheduler
   integration was itself the same "many unrelated responsibilities in one scope" SRP violation this
   plan exists to fix in `index.ts` — just at smaller scale. This file's only real dependency is reading
   already-constructed state (`costTracker`, `settingsStore`, `reposRegistry`) and rendering a reply; no
   test file is proposed for it, mirroring the treatment of `card-senders.ts` (item 12) — both are thin,
   low-risk, read-only wrappers.
9. **`deploy-lifecycle-commands.ts`** — `handleDeployCommand`, `handleRestartCommand`,
   `respawnSelfAndExit`, `handleAutostartCommand`, `runSchtasks`/`runPowershell`. The other half of the
   former `fleet-admin-commands.ts` split — process lifecycle and OS-level Task Scheduler integration,
   genuinely unrelated to item 8's read-only reporting. `confirmSessionCommand` and the
   `respawnSelfAndExit`/deploy-marker pair are load-bearing and ordering-sensitive (see Risks) — they
   are **injected as callbacks**, constructed once in the composition root, never reimplemented or
   naively relocated. `runSchtasks`/`runPowershell` currently call `execFile`/`spawn` directly; take an
   injected process-runner function here (the same dependency-inversion treatment already applied to
   `confirmSessionCommand`) so the Task Scheduler integration is fakeable in tests rather than requiring
   a real Windows host.
10. **`voice-mode-commands.ts`** — `handleVoiceModelCommand`, `applyVoiceModelSwitch`,
    `handleAssistCommand`, `handleVoiceConfirmCommand`, `applyModelSwitch`/`applyModeSwitch`/
    `applyEffortSwitch`/`writeModeKeystrokes`, the default-mode/effort card family
    (`renderDefaultModeConfirmation`, `sendDefaultStatusCard`, `sendDefaultCategoryPicker`,
    `applyDefaultMode`, `applyDefaultEffort`, `handleDefaultCommand`), `handleRouterBackendCommand`.
11. **`fleet-confirm-flow.ts`** — `postFleetConfirm`, `executeFleetConfirm`,
    `executeFleetActionDirect`, `stopIndicatorsForTopic`, `confirmSessionCommand`,
    `handleUsageCommand`.
12. **`card-senders.ts`** — `sendAboutCard`, `sendHelpCard`, `sendCommandsListCard`,
    `sendSkillsListCard`, `sendBrowseCard`, `sendFindCard`, `sendDiffCard`. Thin wrappers around
    already-tested renderers; low risk, mainly a readability win.
13. **`nl-dispatch.ts`** — `describeNlCommand`, `executeMatchedCommand`, `postNlConfirm`,
    `routeOrFallback`. Also takes `dispatchInboundMessage` as an injected callback (same circular-import
    avoidance as item 6).
14. **`command-dispatch.ts`** — `dispatchFleetCommand`, `dispatchInboundMessage`. The latter is
    currently a 240-line linear gauntlet of exact-syntax checks before falling back to NL routing;
    flatten it into an ordered `{ match, handle }` list where practical so each branch reads as a
    one-line delegate into an already-extracted handler, and so branch *order* — which caused a real
    shadowing bug — is visible and testable as data, not buried in an if-chain.
15. **`callback-query-router.ts`** — not just a thin dispatch layer: the ~450-line `onUpdate`
    callback-query branch (`index.ts:3112-3560`) contains substantial inline business logic per
    namespace, which this module must name and own, not merely "resolve and delegate":
    - `askAction` (`"ask:"`) — calls `pipeHandle.answerAsk`, `finalizePermissionMessage`,
      `completeAsk`, `maybeSetState`.
    - `permAction` (`"perm:"`) — permission-rule derivation: `deriveAlwaysRule`,
      `readSettingsFile`/`writeSettingsFile`, `addAlwaysRule`, `ruleAlreadyCovered`. This is exactly the
      "permission-rule derivation" class of logic CLAUDE.md §9 already flags as needing unit tests, and
      it's currently sitting unnamed inside an anonymous closure.
    - `browseAction` (`"br:"`/`"bf:"`/`"bv:"`/`"bs:"`) — full navigation logic: `listDirectory`,
      `buildDirKeyboard`, `prepareFileForSend`, `readForPreview`, `resolveGithubLink`.
    - the `default:`/`defmode:`/`defeffort:` branch — inline keyboard-building/category-picker logic.
    - plus the remaining namespaces (`"fc:"`, `"nc:"`, `"sc:"`, `"vc:"`, `"vm:"`, `"d:"`, `"about:"`),
      which delegate more thinly to handlers already named in other modules.
    Dependencies this module needs beyond what a pure dispatcher would: `pipeHandle`, `settingsStore`,
    `browseRegistry`, `detailsAnchorStore`, `ABOUT_TOPICS`, `defaultSessionMode`/`defaultSessionEffort`,
    `assistEnabled`, `voiceConfirmEnabled`. Reshape the outer routing into a namespace-prefix dispatch
    table (map prefix → handler) instead of a 15-branch sequential if-chain — the namespaces are already
    prefix-disjoint by design per the existing comments, and this if-chain is the single worst KISS
    offender in the file today. **Caveat on what the dispatch-table fix actually buys:** it improves
    readability and per-namespace testability, but it does not achieve Open/Closed extensibility —
    adding a sixteenth namespace still means editing this file's dispatch table, same as editing a
    switch statement would. Don't oversell it as an OCP fix; it's a KISS/readability fix.
16. **`index.ts`** (composition root) — what remains: config/token loading, DB/store/registry
    construction, the deploy-marker rollback-or-confirm check, the dev-control debug HTTP server (using
    item 1's injected accessor rather than a raw map reference), wiring every module above via its
    factory call, then the `startOtlpListener`/`startPipeServer`/`startPolling` registration calls.
    Target size: ~300–400 lines. No business logic, no rendering, no protocol parsing.

## Migration approach

Incremental, one module at a time, in the dependency order listed above (leaf modules first). For each
module:

1. Create the new file with a `create<Name>(deps)` factory, moving the relevant functions and their
   owned state in verbatim, adjusting only what's needed to take injected deps instead of closing over
   `main()`'s scope.
2. Update `index.ts` to construct the module via its factory and call the returned functions instead of
   the inline versions; delete the moved code from `index.ts`.
3. Add unit tests for any newly-isolated logic that was previously reachable only through a live PTY/
   Telegram round-trip (see Testing below).
4. Run `bun test` and `tsc --noEmit`; both must pass before moving to the next module.
5. Commit. Each extraction step is its own commit — `index.ts` must compile and pass tests at every
   intermediate commit; there is no big-bang rewrite.

Do not reorder the sequence above without re-checking the Risks section — later modules
(`nl-dispatch.ts`, `command-dispatch.ts`, `callback-query-router.ts`) depend on callbacks/handlers that
earlier modules establish, and item 4 (`quota-alarms.ts`) has a real construction-order dependency on
`feedGovernor`/`feedCoalescer` that doesn't exist in today's closure-based code (see Risks).

## Risks

- **Shared mutable closures, not services.** Almost every function reads/writes 3–6 of the ~31
  module-scope state variables. Each extraction must decide state ownership: does the moved module own
  its slice (e.g. `ptyProcessBySlug` naturally belongs inside `session-supervisor.ts`), or does it
  receive a shared reference (e.g. `sessionStore`, `routing`, used by nearly everything)? Default to
  "owns it" when only one module reads/writes a given variable; default to "injected reference" when
  multiple modules need it.
- **`resumeAttempts` has exactly this ownership conflict, concretely.** Item 1 (`session-supervisor.ts`)
  declares itself sole owner of `resumeAttempts`, but `handleHookEvent` — assigned to `feed-wiring.ts`
  (item 3) — calls `resumeAttempts.delete(msg.slug)` directly today (`index.ts:585`). Fix: item 1 exposes
  a `clearResumeAttempts(slug)` mutator as part of its factory's return value; `feed-wiring.ts` takes
  that function as an injected dependency and calls it, rather than either module reaching into a raw
  `Map` the other one owns.
- **Converting `quota-alarms.ts`'s forward closure reference into constructor injection changes
  `main()`'s construction order — this is a real migration step, not just a wiring detail.** Today,
  `markQuotaStopped` (defined at `index.ts:345`, before `feedGovernor` is declared at line 501) only
  works because JS function declarations hoist and it isn't *called* until `startOtlpListener`'s
  `onApiError` callback fires later, well after `feedGovernor` exists. Once `quota-alarms.ts` becomes a
  `create<Name>(deps)` factory, `feedGovernor`/`feedCoalescer` become explicit constructor arguments,
  which means the composition root must construct `feedGovernor`/`feedCoalescer` (item 3's state)
  *before* building `quota-alarms.ts`'s factory and *before* calling `startOtlpListener()` — a genuine
  reordering relative to today's source order, not merely a refactor of the same sequence. Call this out
  explicitly in the composition root's construction code (a comment naming the dependency, not just the
  correct order) so a future edit doesn't silently reintroduce a hoisting-dependent ordering.
- **Circular-dependency risk is real but manageable.** `dispatchInboundMessage` is called recursively
  from itself (stale-confirm/voice-confirm replay paths) and is also invoked from `inbound-media.ts`'s
  `handleVoiceMessage`/`handleAttachmentMessage` and from `nl-dispatch.ts`'s `routeOrFallback`
  fallback. Fix: `inbound-media.ts` and `nl-dispatch.ts` take a `dispatchInboundMessage`-shaped callback
  as a constructor option rather than importing `command-dispatch.ts` directly — the same pattern
  `pipe-server.ts` already uses elsewhere in this codebase.
- **`confirmSessionCommand` is a load-bearing shared primitive** (the rate-limit-lane-wrapped
  `sendMessage`) used by nearly every handler across every proposed module. Construct it once in the
  composition root and pass it down everywhere; do not let call sites keep independent closure
  references, which would silently reintroduce the "everything touches everything" shape this plan
  exists to fix.
- **`bootReadyAt`/`respawnSelfAndExit`/deploy-marker logic should stay adjacent to `main()`'s startup
  sequencing**, not move into `deploy-lifecycle-commands.ts` even though `handleDeployCommand`/
  `handleRestartCommand` call it. It's read only at two points (set on reconciliation completion; read
  inside `respawnSelfAndExit`'s delay calculation), and the ordering relative to
  `runStartupReconciliation`/the stale-deploy-rollback check is safety-critical — inject it as a
  callback into `deploy-lifecycle-commands.ts` rather than relocating the state itself.
- **No duplication against existing sibling modules was found.** The import list at the top of
  `index.ts` confirms it consumes `feed-renderer.ts`/`feed-state.ts`/`nl-router.ts`/
  `session-commands.ts`/etc. rather than reimplementing their logic — all three DRY violations found
  (items 5 and 7 above) are internal to `index.ts` itself, not against another file.
- **`worktree-fs.ts`'s path-containment duplication is intentional and out of scope.** It deliberately
  duplicates path-containment logic rather than reusing a shared util, per its own doc comment — this
  plan does not touch it.

## Other large files: verdicts (not in scope for this plan)

Checked for the same "many unrelated responsibilities in one scope" pattern; none show it — they're
large because their single responsibility has many *cases* (many command syntaxes, many API methods,
many NL router kinds), which is a healthy reason for size, not a split candidate:

- **`fleet-commands.ts`** (778 lines) — pure parsing/rendering, no shared mutable state, own 801-line
  test file. Healthy.
- **`telegram.ts`** (640 lines) — one cohesive `TelegramClient` class plus `startPolling`/
  `validateTokens`; a single Bot-API adapter. Healthy.
- **`pipe-server.ts`** (626 lines) — one `startPipeServer` factory with a well-defined
  `PipeServerOptions` injection boundary; the pattern this plan's `index.ts` split imitates. Healthy.
- **`nl-router.ts`** (534 lines) — contained NL-classification logic with its own 401-line test file.
  Healthy.
- **`session-launcher.ts`** (423 lines) — one job (spawn/resume a `claude` PTY process) plus
  logically-related platform-detection helpers. Healthy.
- **`worktree-fs.ts`** (407 lines) — cohesive sandboxed-filesystem-browsing module; documented
  intentional duplication noted above. Healthy.
- **`rate-governor.ts`** (351 lines) — small, focused rate-limiting/backoff module with a clean class
  boundary. Healthy.

(Line counts current as of this plan's last review pass; sibling files may drift further as the
codebase evolves — re-check before relying on exact figures.)

## Testing

New unit tests to add as each module is extracted (per CLAUDE.md §9's convention: unit-test any helper
whose failure mode is silent-wrong, plus every protocol/exit-code contract another component branches
on). None of these are testable in isolation today because they're buried inside `main()`'s closure.

1. **`session-supervisor.test.ts`** (unit, new test file, gate: `bun test`)
   - Happy path: `resumeSession` successfully resumes a session and resets the resume-attempt counter.
   - Edge: `resumeSession`'s `resumeFailed` branch when the underlying resume call throws — verify it
     does not silently swallow the failure.
   - Edge: the immediate-exit backoff counter (`MAX_CONSECUTIVE_RESUME_ATTEMPTS`) correctly stops
     retrying after the configured number of rapid consecutive exits, using an injected clock instead
     of real delays.
   - Acceptance criterion: a session that crash-loops faster than `RESUME_BACKOFF_MS` is not resumed
     indefinitely; a session that fails to resume once reports the failure rather than hanging silently.
   - **Bun test-runner note:** the module's clock must be injected as an explicit `now()`/scheduler
     dependency (not read via bare `Date.now()`/`setTimeout` inside the module) — Bun's native
     `setTimeout`/`setInterval` fake-timer support is thinner than Jest's, so time-reading mocks alone
     (`setSystemTime`) won't reliably drive scheduled callbacks. If any test in this file does use
     `setSystemTime()`, reset it in `afterEach` — Bun has a known cross-test-file leak when it's left
     set (oven-sh/bun#32793).
2. **`pty-io.test.ts`** (unit, new test file, gate: `bun test`)
   - Happy path: `confirmSubmitted` resolves normally when the PTY echoes the expected input within
     `SUBMIT_CONFIRM_WINDOW_MS`.
   - Edge: the "lost Enter" retry path fires exactly once when no echo arrives within the window (using
     an injected/fake clock, not real timers).
   - Edge: `autoRecoverWedgedSession` triggers only after `ECHO_SETTLE_MS` of true silence, not on a
     merely slow but progressing PTY.
   - Acceptance criterion: a dropped keystroke is retried at most once and does not double-submit.
   - **Bun test-runner note:** same as above — `SUBMIT_CONFIRM_WINDOW_MS`/`ECHO_SETTLE_MS` waits must be
     driven through an injectable scheduler passed into `pty-io.ts`'s factory, not bare `setTimeout`,
     and any `setSystemTime()` use must be reset in `afterEach` to avoid leaking into other test files.
3. **`confirm-cards.test.ts`** (unit, new test file, gate: `bun test`)
   - Happy path: `finalizeCard` edits the message and strips the keyboard for each of the four confirm
     flows (fleet/stale/voice/nl) using the now-unified implementation.
   - Edge: `markConfirmCardExpired`/`markNlConfirmCardExpired` correctly report "gone" via
     `notifyConfirmGone` when the underlying Telegram message was already deleted.
   - Edge: the new `takeOrNotifyGone(registry, id, msgId, markExpiredFn)` helper correctly branches
     three ways — entry missing (notify gone), entry expired (mark expired, don't proceed), entry valid
     (proceed) — for each of the four registries.
   - Acceptance criterion: all four confirm-card flows produce identical finalize/expire/take behavior
     (this is the regression test for both DRY fixes in module 5 — a change to either shared
     implementation must affect all four flows identically, not require four parallel edits).
4. **`deploy-lifecycle-commands.test.ts`** (unit, new test file, gate: `bun test`)
   - Happy path: `handleDeployCommand`/`handleRestartCommand` follow the documented deploy-marker
     rollback-or-confirm sequence.
   - Edge: `respawnSelfAndExit`'s delay calculation reads `bootReadyAt` correctly via its injected
     callback (see Risks) rather than a stale local reference.
   - Edge: `runSchtasks`/`runPowershell` invoke the injected process-runner with the expected arguments,
     using a fake runner rather than a real Windows Task Scheduler call.
   - Acceptance criterion: this module's `respawnSelfAndExit`/deploy-marker logic — explicitly called
     "safety-critical" and "ordering-sensitive" in the Risks section — has test coverage proportionate
     to that stated risk; an earlier draft of this plan named the risk without proposing a test for it.
5. **`quota-alarms.test.ts`** (unit, new test file, gate: `bun test`)
   - Happy path: `maybeFireBurnRateAlarm` fires once when spend crosses `BURN_RATE_THRESHOLD_USD`.
   - Edge: the `BURN_RATE_ALARM_COOLDOWN_MS` cooldown suppresses a second alarm within the window, using
     an injected clock rather than real delays.
   - Edge: `markQuotaStopped` correctly updates `sessionStore` state when a session is quota-stopped.
   - Acceptance criterion: a wrong cooldown value either spams alarms or silently never alarms again —
     this is exactly the "silent-wrong" class CLAUDE.md §9 targets, and it had no proposed test in an
     earlier draft of this plan.
6. **`command-dispatch.test.ts`** (unit, new test file, gate: `bun test`)
   - Happy path: each documented exact-syntax command (`/commands`, `/cmd`, `/new`, etc.) matches its
     intended handler.
   - Regression: the `/commands` list-filter branch does not greedily match before the `/commands
     <name>` invocation-parse branch (the actual shape of the live dispatch-order bug at
     `index.ts:2929-2936`) — assert dispatch order via the new `{ match, handle }` list directly rather
     than only end-to-end.
   - Acceptance criterion: reordering the `{ match, handle }` list is the only way dispatch behavior
     changes — no other code path can introduce shadowing.
7. **`nl-dispatch.test.ts`** (unit, new test file, gate: `bun test`)
   - Happy path: `routeOrFallback` routes recognized natural-language input to `executeMatchedCommand`
     with the expected fleet command.
   - Edge: unrecognized input falls back to `dispatchInboundMessage` (via the injected callback, not a
     direct call) exactly once, without a duplicate reply.
   - Acceptance criterion: this module has the same branchy-dispatch shape the plan already flags as
     bug-prone for `command-dispatch.ts` (item 6 above), so it gets the same "assert dispatch order
     directly" treatment rather than being left untested, as an earlier draft of this plan left it.
8. **`callback-query-router.test.ts`** (unit, new test file, gate: `bun test`)
   - Happy path: a callback-data string with each documented namespace prefix (`"perm:"`, `"fc:"`,
     `"nc:"`, `"sc:"`, `"vc:"`, `"vm:"`, `"d:"`, `"ask:"`, `"br:"`/`"bf:"`/`"bv:"`/`"bs:"`, `"about:"`,
     `"default:"`/`"defmode:"`/`"defeffort:"`) resolves to its correct handler via a fake
     `callbackQuery`, with no live Telegram round-trip.
   - Edge: an unrecognized prefix is handled gracefully (no throw, no silent no-op that leaves the
     user's tap unanswered).
   - Edge: `permAction`'s permission-rule derivation (`deriveAlwaysRule`, `ruleAlreadyCovered`) produces
     the correct always-allow rule for a representative tool call, and does not double-write an
     already-covered rule — this is the specific "permission-rule derivation" logic CLAUDE.md §9 already
     flags as needing unit tests, previously buried unnamed inside this file's anonymous closure.
   - Acceptance criterion: the namespace-prefix dispatch table has one entry per documented prefix, and
     every entry is exercised by at least one test — a missing table entry for a real prefix is a test
     failure, not a silent runtime gap.
9. **`session-lifecycle-commands.test.ts`** (unit, new test file, gate: `bun test`)
   - Happy path: the shared "resolve slug or bail" helper introduced in module 7 returns the session
     row for a valid slug.
   - Edge: it reports a clear failure (not a cast-induced `undefined` access) for an unknown slug —
     this is the regression test for the `resolveTargetSlug` + unchecked-cast duplication found across
     six call sites (seven cast occurrences, `handleVerboseCommand` having two).
   - Acceptance criterion: `handleAttachCommand`/`handlePauseCommand`/`handleDetailCommand`/
     `handleVerboseCommand`/`handleKillCommand`/`handleRmCommand` all use the one shared helper at every
     cast occurrence; no call site re-implements the resolve-or-bail check independently.
10. **`inbound-media.test.ts`** (unit, new test file, gate: `bun test`)
    - Happy path: a photo/document/video/audio/video_note update routes to `handleAttachmentMessage`; a
      voice update routes to `handleVoiceMessage`; a plain-text update falls through to the injected
      `dispatchInboundMessage` callback.
    - Edge: `isStaleInbound` correctly suppresses a stale update rather than processing it as live.
    - Acceptance criterion: the routing decision (which handler a given update reaches) is covered by a
      test per media type, since this logic had no assigned home — and therefore no test file — in an
      earlier draft of this plan.

`fleet-reporting-commands.ts` (item 8) has no proposed test file, matching the treatment of
`card-senders.ts` (item 12) — both are thin, low-risk, read-only wrappers around already-tested state
and renderers; this is a deliberate, stated decision, not a silent gap.

Each new test file lands in the same commit as the module extraction it covers, per the Migration
approach above — extraction and test-writing are not separated into a later pass.

## Outcome

Recorded 2026-08-12, verified item by item against the tree rather than from the commit messages.

**All 15 modules exist and all 15 have their own test file** — 405 tests between them:
`session-supervisor` (35), `pty-io` (8), `feed-wiring` (21), `quota-alarms` (9), `confirm-cards` (11),
`inbound-media` (35), `session-lifecycle-commands` (64), `fleet-reporting-commands` (11),
`deploy-lifecycle-commands` (47), `voice-mode-commands` (32), `fleet-confirm-flow` (25),
`card-senders` (18), `nl-dispatch` (26), `command-dispatch` (29), `callback-query-router` (34).
Two of those (`card-senders`, `fleet-reporting-commands`) were deliberately proposed here *without*
a test file as thin read-only wrappers; they got one anyway later, via
[`codebase-hardening-plan.md`](codebase-hardening-plan.md)'s P1-8 closeout, which confirmed rather
than assumed that low-risk claim.

**Both DRY fixes landed as specified, not half-migrated:**

- Item 5 — `confirm-cards.ts` exports the unified `finalizeCard` *and* `takeOrNotifyGone`, i.e. both
  the finalize-call layer and the take/notify-gone/mark-expired preamble one layer above it, with the
  four `finalize*ConfirmMessage` wrappers delegating down to `finalizeCard`.
- Item 7 — `session-lifecycle-commands.ts` has `resolveSessionOrBail` plus the `getRowOrReportMissing`
  half factored out for `handleRmCommand`'s orphan-topic special case, 12 call sites between them, and
  **zero** surviving `sessionStore.get(slug) as NonNullable<...>` casts (the only textual match left in
  the file is the doc comment explaining what the helper replaced). The specific partial-migration
  failure this item warned about — skipping `handleRmCommand` or fixing only one of
  `handleVerboseCommand`'s two occurrences — did not happen.

**Construction order holds:** `feedGovernor` is built at `index.ts:249`, before `createQuotaAlarms`
(261) and `startOtlpListener` (279). `feedCoalescer` no longer appears in the composition root at all
— module 3 took ownership of it, as item 3 intended, so that half of the ordering constraint is now
internal to `feed-wiring.ts` rather than something the root can get wrong.

**The one deviation: `index.ts` is 1,152 lines, not the 300–400 estimated here.** It is nonetheless a
composition root by content, not by label — 62 store/registry constructions, 23 `create*`/`start*`
factory calls, the dev-control debug HTTP server item 1 always meant to leave in place, and 3 wiring
closures (`waitForChannelConnected`, `waitForPtyQuiet`, `respawnSelfAndExit`). What the estimate
missed is that 23 factories with 10–40 injected dependencies each cost far more lines as
multi-line object literals than the code they replaced did as closures, before counting the
why-this-order comments that injection makes necessary and closures made implicit. That is a cost the
pattern buys deliberately; it is not leftover business logic, and no further extraction is proposed
on the strength of the line count alone.

## Verification

- ~~After each extraction commit: `bun test` and `tsc --noEmit` both pass in `packages/bridge`.~~
  **Done** — held per commit through the whole sequence, and both gates are now enforced in CI
  (`.github/workflows/ci.yml`) as well as locally.
- **Never run as one deliberate pass:** the post-split live sweep (one flow per confirm-card family —
  fleet/stale/voice/nl — plus one callback-query namespace, via `scripts/telegram-automation/` after a
  Bridge restart). Recorded honestly rather than marked done. Three of the four families have been hit
  live since, incidentally rather than as this sweep: fleet-confirm (the `/kill --all` tap, and again
  in `/stop`'s card-clearing work at 0.101.1), nl-confirm (a real destructive-NL confirm card the
  operator hit, which is what produced `retry-store.ts`), and voice-confirm. The fourth, **stale-confirm,
  has never fired live for a genuinely >30-minute-old message** — that is not a gap this refactor
  introduced, it is the main plan's own §13 check 3, still outstanding there for the same reason
  (producing a real 30-minute-old backlog message means actually suspending the host).
- ~~Confirm `index.ts` is reduced to roughly 300–400 lines and contains no business logic.~~ **Half
  done:** no business logic (confirmed by read-through — every remaining top-level statement is
  config/store construction or factory wiring), but 1,152 lines rather than 300–400. See ## Outcome
  for why the estimate was wrong and why that is not treated as remaining work.
- ~~Confirm all three DRY fixes each have exactly one implementation referenced from all former call
  sites.~~ **Done**, both items, including item 7's six former call sites and `handleVerboseCommand`'s
  two cast occurrences — see ## Outcome.
- ~~Confirm the composition root constructs `feedGovernor`/`feedCoalescer` before building
  `quota-alarms.ts`'s factory and before calling `startOtlpListener()`.~~ **Done** — see ## Outcome.
