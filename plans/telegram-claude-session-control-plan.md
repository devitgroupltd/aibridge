---
version: 0.110.0
status: solid
last_modified_utc: 2026-08-13T06:30:00Z
relates_to: >-
  This plan originated as plans/telegram-claude-session-control-plan.md in the SeoWrite repo
  (github.com/devitgroupltd/seowrite), where it was developed and probed against that repo's own
  CLAUDE.md conventions (worktree-per-session, the `main` write-block, "never commit without explicit
  instruction") through v0.7.3, before being extracted here as its own reusable tool (decision 5,
  below). Those conventions remain load-bearing for SeoWrite as a target repo (§4, §6.1.1, §7.3, §7.5)
  but are that repo's property, not aibridge's own - this repo carries no local `CLAUDE.md`,
  `plans/hosting-vps-plan.md` or `plans/test-coverage-and-deploy-gate-plan.md` of its own yet, and none
  is assumed to exist. aibridge's own testing convention is stated directly in §9 rather than deferred
  to a companion plan.
changelog:
  - "0.110.0 (2026-08-13): ran the four remaining never-live-exercised paths named in §12, on the
    operator's instruction to close them all out. Two passed as designed and are now recorded as
    live-verified: **quiet mode** (`⚠️ feed throttled, 5 sessions active` posted mid-storm, behind
    ~130 real P2 drops) and **`quota_stopped`** (driven end to end by a synthetic
    `claude_code.api_error` OTLP record against the real listener - only the upstream source was
    faked, and the one thing that substitution still cannot establish is called out). Two turned up
    defects. **`/attach` was broken**: against a real PTY tail the rendered card passed Telegram's
    4096-unit cap, the send failed three times and the operator saw nothing at all - fixed by
    bounding the rendered message instead of the raw buffer (`codebase-hardening-plan.md` P1-10).
    And forcing the feed storm surfaced **P0-8**, unrelated to the storm itself: a wedged session is
    killed for a crash-resume that never comes, because the killed process's own `SessionEnd` hook
    marks the row dead 33ms first - filed with its measured sequence, not yet fixed. §9's scenario
    list gained **29a** (inbound arrives by PTY injection, not notification) and scenario 29's
    wording now names that asymmetry instead of assuming the abandoned path; §10.1.2's item (a) is
    struck as moot since the 0.55.0 plugin cutover deleted the `.mcp.json` path it described.
    Recorded in §12 alongside the quiet-mode result: the structural reason a tool-heavy storm does
    *not* trip quiet mode while a turn-heavy one does, since that is the non-obvious half anyone
    reasoning about feed load will need."
  - "0.109.0 (2026-08-12): the §12 Phase 2 defect measured in 0.108.0 is fixed, same evening
    (`codebase-hardening-plan.md` P0-7). `rule-derivation.ts` gained `isCoveredByBareToolRule` -
    `deriveAlwaysRule`'s exact counterpart, recognising the bare tool name that function writes for a
    non-Bash tool - and `pipe-server.ts`'s `handlePermissionRequest` now reads the session settings
    once per request and runs either the Bash compound path or this one, so an `♾️ Always` tap is
    honoured for the rest of the conversation instead of sitting unused on disk. §6.6 rewritten around
    what is actually load-bearing: the promise holds because the *Bridge* re-reads that file per
    request, not because Claude Code re-reads anything, so a future change that stops re-reading
    silently makes the confirmation false again. `Edit`/`Read` deliberately still re-prompt, recorded
    as an accepted limit with its reasoning - honouring a bare grant there would mean matching the
    baseline's scoped `Edit(~/**)`-style deny globs per call, i.e. reimplementing Claude Code's path
    semantics, where a subtle mistake auto-approves reads of the secrets those rules protect (a
    repeated prompt is a worse day, a wrong glob is a breach). 17 new tests, 1742/1742, `tsc --noEmit`
    clean; live-verified in both directions - the `write` variant that recorded the bug now records
    the fix, and the `bash` variant still passes, confirming the shared restructure left the compound
    path alone."
  - "0.108.0 (2026-08-12): closed §12 Phase 2's last open question - whether a running session picks
    up an `♾️ Always` tap's derived rule mid-conversation - by measuring it live rather than
    reasoning about it (`scripts/telegram-automation/always-rule-check.js`, new, two variants against
    real throwaway sessions). Answer: no, and the reason it *appears* to work is itself the finding.
    A `Bash` retry after the tap still escalates (its `PermissionRequest` hook fires) and only avoids
    a second card because `pipe-server.ts` re-reads the session settings file per request and
    auto-approves via its compound-decomposition path - which is gated on `tool_name === \"Bash\"`.
    The `Write` variant, where nothing re-reads the file, raised a second card for the very next
    matching call, so for every non-Bash tool `♾️ Always` currently promises a session-wide grant it
    does not deliver until relaunch. Recorded in §6.6 (where the contract is specified) and §12
    Phase 2 (with the two-variant result table and the one thing the measurement cannot
    distinguish). No code changed - the fix direction (extend the same re-read to non-Bash tools) is
    named, not implemented. Three incidental findings from the same sitting are recorded alongside:
    a daemon instance that failed every `/new` at `git worktree add` with an operator-visible message
    carrying no reason at all (git's stderr was genuinely empty; a restart cleared it), the fleet
    defaults (`mode=auto`, `bypass_permission=1` inherited by every new session) that make any live
    permission check meaningless unless explicitly disabled per session, and `scripts/telegram-
    automation/client.js`'s `openTopic` matching a row's message *preview*, which silently drove the
    control topic instead of a session's own topic for two runs (fixed with a new `openTopicByTitle`;
    `/rm` cleanups in the rig also updated to `/remove`, which replaced it)."
  - "0.107.1 (2026-08-12): stale-text fix only, no design change, from a \"what's left to implement\"
    sweep across this folder. §12 Phase 6a's Task Scheduler bullet still ended \"a Task Scheduler
    launch captures no stdout/stderr, so there is no production log file today\" - true when 0.34.0
    wrote it, but 0.74.0 closed exactly that gap with `logger.ts`'s own file sink
    (`%LOCALAPPDATA%\\aibridge\\bridge.log`, 10MB cap, one rotated backup, independent of launch
    method) and the entry recording the fix sat 30-odd versions below the line still asserting the
    gap. Corrected in place with a pointer to 0.74.0, so a reader scanning Phase 6a for open work
    doesn't re-open a closed item. Three sibling plans got the same treatment in the same pass
    (attachment 0.5.0, bypass 0.25.1, index-split 1.0.0); no code changed, so `bun test`/`tsc` are
    untouched."
  - "0.107.0 (2026-08-12): operator asked to unify `/voice` and `/voiceconfirm` into one command,
    suggesting `/voice model ...`/`/voice confirm on|off` - the same \"category first\" shape
    `/auto`/`/default` already use. `FleetCommand`'s `voice` member gained a `category: \"model\" |
    \"confirm\"` discriminant (replacing the separate `voiceconfirm` kind); `fleet-commands.ts`'s new
    `parseVoice` routes on an explicit `model`/`confirm` token first, falling back to `/voice <name>`
    with no keyword (pre-merge back-compat, since \"model\" was implicit long before \"confirm\" needed
    a keyword to disambiguate from it) and defaulting bare `/voice` to the model category's list form.
    `/voiceconfirm [on|off]` still parses, via new `parseVoiceConfirmAction`, as a bare alias into the
    same unified shape - same \"rename, don't break muscle memory\" treatment `/rm`/`/remove` already
    got. `voice-mode-commands.ts` gained a `handleVoiceCommand` dispatcher (exhaustive switch on
    `category`) that `command-dispatch.ts` now calls instead of the two separate branches it used to
    have. `nl-router.ts` folded the `voiceconfirm` router kind into `voice` via a new `voiceCategory`
    schema field (mirroring `/auto`'s own `autoCategory`), and updated `isDestructive`'s
    \"turning voice-note confirmation off is as destructive as `assist off`\" check to match the new
    shape. `botCommandList()`/`renderHelp()` updated to describe the new syntax, with `/voiceconfirm`
    kept listed as a working alias. `nl-router.test.ts`'s `COMMAND_TO_ROUTER_KIND` completeness map
    gained the same `voiceconfirm -> voice` entry `remove -> rm` already has. 9 new tests
    (`fleet-commands.test.ts`'s parser coverage for both the canonical `/voice model|confirm` forms
    and the `/voiceconfirm` alias; `voice-mode-commands.test.ts`'s new `handleVoiceCommand` dispatch
    tests), full suite green (1596 total, up from 1587), `tsc --noEmit` clean across all 5 packages."
  - "0.106.0 (2026-08-09): made `/ship`'s `<slug>` optional (§5.9), matching `/kill`/`/rm`/`/pause`/
    `/usage`'s existing bare-inside-a-session's-own-topic convention instead of `/deploy`'s
    control-topic-only restriction - live use the same day found that a bare `/ship` typed inside a
    session's own topic didn't match `parseFleetCommand` at all (missing slug -> `null`), so it fell
    through and was forwarded to that session's own Claude process as ordinary chat text; if that
    session's worktree predated the in-session `ship.md` custom command too, Claude went searching
    the repo for what \"/ship\" might mean instead of anything happening - a confusing Bash-permission
    prompt with nothing behind it. Now a bare `/ship` resolves against the topic's own `currentSlug`
    and runs the exact same control-topic logic (still trusted Bridge code via `CommandRunner`, never
    through that session's own `permissions.ask` gate - there is no Telegram button for this path at
    all). An *explicit* slug naming a different session still requires the control topic either way;
    only a bare invocation resolving to the session already in view skips that check.
    `handleShipCommand` now takes `(topicId, explicitSlug, currentSlug)` instead of a required
    `slug`; `parseFleetCommand(\"/ship\")` now returns `{kind:\"ship\", slug: undefined}` rather than
    `null`. 4 new tests (bare-in-own-topic succeeds, bare-outside-any-topic-context reports usage,
    explicit-slug-from-a-different-topic still refuses, existing explicit-slug/control-topic paths
    unchanged), full suite green (1314 total), `tsc --noEmit` clean across all 5 packages."
  - "0.105.0 (2026-08-09): added `/ship <slug>` (§5.9) alongside `/deploy` - operator asked for a
    one-command way to land a session's work to main, from the control topic without opening the
    session first, and from inside the session itself. Control-topic `/ship` chains
    `commitIfDirty` (auto-commits a still-dirty worktree with a fixed, clearly-auto-generated
    message) -> `deployBranch` (the same merge+gate+rollback `/deploy` already runs) ->
    `pushCurrentBranch` (pushes whatever's checked out to `origin`, since `deployBranch` alone
    never leaves the local checkout) -> the same self-repo restart tail `/deploy` uses, extracted
    into a shared `restartIfSelfRepo` helper so the two commands can't drift apart on that
    behaviour. Marked destructive in the NL router alongside `/restart`/`/deploy`. The in-session
    half (`.claude/commands/commit.md`/`push.md`/`ship.md`) is a different mechanism, not the same
    code path: a session's worktree can't check out the default branch to fast-forward it locally
    (only one branch per worktree, and the default branch is checked out elsewhere), so its `/ship`
    runs this project's own gate, commits, pushes, and lands via `gh pr merge` server-side instead.
    Both still go through the same `permissions.ask` buttons `git commit`/`git push`/`gh pr *`
    already sit behind (§6.1.1) - fewer manual steps, not a new bypass. 8 new tests
    (`deploy.test.ts`: `commitIfDirty`/`pushCurrentBranch`; `deploy-lifecycle-commands.test.ts`:
    `handleShipCommand`'s dirty/clean/gate-failure/push-failure/self-repo-restart paths;
    `fleet-commands.test.ts`/`command-dispatch.test.ts`: parsing and dispatch), full suite green
    (1310 total), `tsc --noEmit` clean across all 5 packages."
  - "0.104.0 (2026-08-08): closed the last piece of the reply/feed-ordering saga that 0.103.0's
    live-testing surfaced but deliberately left as a documented trade-off rather than a blind fix -
    operator asked for a recommendation, then approved implementing it. Root cause:
    `pipe-server.ts`'s `handleReply` used to *edit* the turn's '🤔 Thinking...' placeholder into the
    final reply text instead of sending a new message. `thinking-placeholder.ts` posts that
    placeholder immediately and unthrottled at turn-start, by design, for an instant typing
    indicator - so editing it in place permanently pinned the reply's visible position to
    turn-start, regardless of anything sent later in the same turn (a 'Click Details' lifecycle
    notice, a feed card): Telegram never repositions an edited message, so neither 0.97.0's nor
    0.101.0's ordering fixes could ever touch this - both only affect *when* independent sends
    complete, not *where* an edit's target message already sits. Fixed by always sending the reply
    as a genuinely new P1 message (landing in true chronological order, after `onBeforeReply`'s
    flush and anything already queued ahead of it on that lane) and deleting the placeholder
    afterward instead of reusing it - the operator still gets the same instant feedback at
    turn-start, and the placeholder just cleanly disappears rather than turning into the answer. A
    failed delete (already gone, past Telegram's window, etc.) is logged and swallowed - it must
    never take the already-sent reply down with it. 3 tests rewritten/added in
    `pipe-server.test.ts` (send-then-delete instead of edit-in-place, the placeholder-absent
    fallback, a delete-failure-is-swallowed case), confirmed to fail red against the pre-fix code.
    Live-reverified end to end (scripts/telegram-automation): a fresh session's topic now reads
    prompt -> 'Click Details' -> activity card -> reply, last, exactly the order originally
    reported as wrong. 1201 total (was 1200), `tsc --noEmit` clean."
  - "0.103.0 (2026-08-08): live-verified the 0.97.0 reply/feed-ordering fix and the 0.100.0
    Bun-runtime-drift fix against a real Telegram client and a real Bridge restart
    (scripts/telegram-automation), per operator request. Both held: no orphan false-positive, the
    `/new` deep-link button navigated correctly, and neither fresh session wedged. But the live
    check surfaced two further, real gaps 0.97.0/0.100.0 didn't cover: (1) `SessionStore.setSessionId`
    existed and was unit-tested but nothing in production ever called it - `feed-wiring.ts`'s
    `handleHookEvent` (the only consumer of hook events) never persisted a live `session_id`
    anywhere, so *every* session's `row.sessionId` stayed permanently null and `claude --resume`
    (session-supervisor.ts) always found nothing to resume, killing the session on every Bridge
    restart with 'no session id was recorded yet' instead of actually resuming it - live-reproduced
    on two freshly created test sessions, fixed by persisting `msg.session_id` on `SessionStart`,
    live-reverified on a third session that resumed cleanly afterward. (2) `rate-governor.ts`'s
    `drainControl` dequeued P0/P1 tasks in strict FIFO order but fired every affordable task's own
    `run()` without awaiting the previous one first, so two same-lane sends queued close together
    (e.g. a turn-start 'Click Details' lifecycle notice and a `reply`, both P1) raced their own
    network calls - delivery order depended on whichever HTTP response reached Telegram first, not
    which was enqueued first; fixed by awaiting each task before starting the next, guarded by a
    `draining` flag against a fresh enqueue re-entering the loop mid-await. Live-testing also
    surfaced (documented, not fixed - a design trade-off, not a bug) that the residual 'reply looks
    like the 2nd message' symptom in a fast single-turn session is actually caused by a third,
    unrelated mechanism: `thinking-placeholder.ts`'s '🤔 Thinking...' message is sent immediately and
    unthrottled at turn-start (bypassing the governor entirely, by design, for an instant typing
    indicator), and `pipe-server.ts`'s `handleReply` *edits* that same message into the final reply
    text rather than sending a new one - Telegram never repositions an edited message, so the reply
    is pinned to wherever the placeholder first landed regardless of any queue-ordering fix. 8 new
    tests (4 `feed-wiring.test.ts`, 3 `rate-governor.test.ts` covering the intra-lane race directly,
    1 already-existing describe block gaining 3 sub-tests); both new tests confirmed to fail red
    against the pre-fix code before the fix, not just pass green after it. 1200 total (was 1193),
    `tsc --noEmit` clean."
  - "0.102.0 (2026-08-08): operator asked about running an aibridge session fully unattended overnight
    (no permission prompts at all). Research turned up Claude Code's `auto` permission mode, which did
    not exist when §6 was written and is not evaluated anywhere in this plan. Added a pointer in §7.6
    naming it as a Phase 6b evaluation candidate - not adopted now, since it needs a real headless
    probe against a running session (the §6.1.1 standard) and there is no walking skeleton to probe it
    against yet (Phase 1 not started). No other section changed; `bypassPermissions` and `dontAsk` were
    also considered and rejected for aibridge specifically - the former needs container/VM isolation
    this Windows-native host doesn't have (§6.7), the latter auto-denies `AskUserQuestion` before it can
    reach the §6.4 hook, breaking the Telegram question flow."
  - "0.101.0 (2026-08-08): operator asked for a way to skip `/kill --all`/`/rm --all`'s Yes/No
    confirm card entirely - typing `/rm --all --force` (or its `-force`/`-f` aliases, normalized
    the same way `-all` already is) instead of tapping a button. This is the reverse of 0.29.0's
    own explicit-direction call to scope confirmation to buttons only, 'rather than a typed
    `--confirm` flag' - superseded by a later explicit direction from the same operator, not a
    reconsideration on aibridge's part. Deliberately narrow: `--force` is only meaningful next to
    `--all`, the one form of each command that posts a card at all - a bare `/kill <slug>`/
    `/rm <slug>` already executes immediately (§4.2), so `--force` there would be a no-op flag
    with nothing to explain what it did, and `/rm --dead`/`--prefix` likewise never touch a live
    session and never confirm. `fleet-commands.ts`'s `parseKill`/`parseRm` gained a `force` field,
    tokenizing rest-of-line instead of matching it as one literal string (needed once `--force`
    could appear before or after `--all`); `index.ts` gained `executeFleetActionDirect`, the same
    per-row teardown loop `executeFleetConfirm` runs after a tap, just posting its summary as a
    plain reply since there's no card to finalize. 4 new tests
    (`fleet-commands.test.ts`) covering both flag orders, the `-force`/`-f` aliases, and `--force`
    being harmlessly stripped on forms that never confirm; 970 total, `tsc --noEmit` clean.
    Live-verified against the real bot after a restart: spawned a throwaway `say-hello-and-then-stop`
    haiku session via `/new`, `/kill --all --force` killed it with no confirm card posted (straight
    to \"Killed 1 session: say-hello-and-then-stop\"), then `/rm --all --force` removed both it and an
    unrelated pre-existing `dead` row the same way, leaving the excluded self-check `test-session`
    untouched throughout - `bridge-dev.log` shows no `postFleetConfirm`/warning lines either time."
  - "0.100.1 (2026-08-08): follow-up to 0.100.0 below, prompted by being asked directly whether it
    was covered by tests. `buildCreateArgs` (pure logic) already was; the two `index.ts` wiring
    changes stay untestable in isolation (the same accepted closures-inside-main() gap prior fixes
    have hit); but `resolveNodeExecutable` had silently introduced a third, verbatim-duplicated,
    zero-test copy of 'parse `where.exe`'s multi-line output, take the first non-blank line' -
    exactly the silent-wrong shape §9 exists to catch (e.g. a shim earlier on PATH than the real
    binary would misresolve which binary the Bridge respawns itself as, with no test anywhere
    that would notice). Extracted into `firstNonEmptyLine`, shared by all three resolvers. 7 new
    tests (`session-launcher.test.ts`): single match, CRLF trailing newline, multiple matches
    (first wins, matching real PATH-search order), a leading blank line skipped rather than
    mistaken for the answer, whitespace-only output producing no match rather than a blank-string
    one, empty output, and untrimmed surrounding whitespace. 966 total (up from 959), `tsc --noEmit`
    clean."
  - "0.100.0 (2026-08-08): operator reported *every* new session wedging immediately after spawn
    (PTY write-socket dead within ~1s, auto-resumed via §12 Phase 5's crash-resume, and the resume
    routinely failing outright with 'Claude reported no matching session' since the original
    process died before Claude Code ever persisted a single real exchange for it to resume). Traced
    to the actual root cause, not the resume-failure symptom (that detection - `RESUME_FAILURE_PATTERN`
    et al - was already working exactly as designed): `Get-CimInstance` confirmed the live Bridge
    process was `bun.exe run .../index.ts`, not `node --experimental-strip-types` - the documented
    runtime this codebase has stated explicitly, repeatedly, since 0.21.0 (which root-caused and
    reproduced, outside this codebase, that a node-pty ConPTY write against a perfectly healthy
    child throws an unhandled 'Socket is closed' asynchronously on the next tick specifically when
    the *Bridge itself* runs under Bun - `pty-write-guard.ts` only stops that from crashing the
    whole daemon, it doesn't stop the session from wedging). Two drift points had put the Bridge on
    Bun: `autostart.ts`'s Task Scheduler registration hardcoded `<bunExePath> run <entryScriptPath>`
    for its own `/TR`, and `respawnSelfAndExit`'s raw-spawn fallback (`/restart`, `/deploy`'s
    self-repo restart, the stale-deploy rollback) did `spawn(process.execPath,
    process.argv.slice(1), ...)` - blindly re-launching with whatever binary happened to start the
    *current* process, so once the Bridge was ever started under Bun even once (that Task Scheduler
    entry, or a manual `bun run`), every subsequent self-respawn perpetuated the same lineage
    forever, permanently, across restarts. Fixed both to always resolve and launch the documented
    runtime explicitly regardless of how the current process itself started: new
    `resolveNodeExecutable` (session-launcher.ts, mirroring the existing `resolveBunExecutable` -
    which is for a *different*, legitimate use, the channel server's own MCP registration, §2.4,
    correctly untouched), wired into both `autostart.ts`'s `/TR` string and
    `respawnSelfAndExit`'s fallback spawn. Updated `buildCreateArgs`'s existing test for the new
    `node --experimental-strip-types` invocation shape; `resolveNodeExecutable` itself stays
    untested like its `resolveBunExecutable`/`resolveClaudeExecutable` siblings (a thin `where`
    shell-out wrapper, same pre-existing gap). 959 total, `tsc --noEmit` clean. **Operational note,
    not covered by the code fix alone**: the already-running Bun-launched Bridge instance needs one
    `/restart` after this deploys to actually pick up the corrected self-respawn path - the fix
    prevents recurrence going forward, it doesn't retroactively fix a process already running."
  - "0.99.0 (2026-08-08): operator asked why `/restart` reported \"Found 1 orphaned claude
    process(es)... pid(s) 6304\" every time. Root-caused live: 6304 was the Bridge's own self-check
    (\"test-session\") session, relaunched fresh by that very restart - `Get-CimInstance` confirmed
    its command line was the self-check's own settings path. Not a leak: the self-check session's
    row only ever calls `sessionStore.insert` once, on the Bridge's first-ever boot, with `ptyPid: 0`
    - every later relaunch (including this one) spawns a fresh process but never updates that row's
    ptyPid, unlike a fleet session's `resumeSession`, which already calls `setPtyPid` on every
    relaunch. `reportOrphanProcesses` matches live processes against rows by *exact pid*, so a
    permanently-0 ptyPid meant the self-check session's own perfectly healthy relaunch could never
    match its own row, misreporting itself as an orphan on every single restart going forward, not
    just this one. Fixed with the one missing call: `sessionStore.setPtyPid(config.selfCheck.slug,
    session.ptyProcess.pid ?? 0)` right after the self-check `wireSession`, mirroring the fleet path.
    2 new tests in `orphan-scan.test.ts` (the exact self-check shape - stale ptyPid still self-flags;
    kept in sync, it doesn't) and 1 in `session-store.test.ts` (`setPtyPid` itself, previously
    untested despite being load-bearing here). 959 total (up from 956), `tsc --noEmit` clean."
  - "0.98.0 (2026-08-08): operator asked whether `/new`'s \"Created ... in a new topic.\" confirmation
    could jump straight to the new topic instead of making the operator find it by hand in the topic
    list. Confirmed against Telegram's own deep-link docs (core.telegram.org/api/links): a
    `t.me/c/<chat id, minus the Bot API's \"-100\" prefix>/<message_thread_id>` link opens a private
    supergroup's forum topic directly - resolving a message link that points at the
    `messageActionTopicCreate` service message opens the topic itself rather than that message, and
    `message_thread_id` (already returned by `createForumTopic`, already threaded through this call
    site) *is* that message's id, so nothing new needs computing. New `buildTopicDeepLink` in
    telegram.ts; `confirmSessionCommand` gained an optional trailing `keyboard` param (forwarded
    straight to `sendMessage`'s existing `replyMarkup`); `handleNewCommand`'s confirmation now carries
    a `url`-type inline button (\"↪️ Open \\\"<slug>\\\"\") - `url` buttons resolve client-side, so
    unlike every `callback_data` button elsewhere in this codebase this needs no round trip through
    the Bridge and no registry entry that could ever go stale or need expiring. 3 new tests
    (`telegram.test.ts`): the \"-100\"-stripping happy path, a numeric chat id accepted the same way,
    and a chat id that doesn't match the expected prefix left unmangled (an obviously-broken link is
    easier to notice than a silently wrong one). 956 total (up from 953), `tsc --noEmit` clean."
  - "0.97.0 (2026-08-07): operator asked to actually close the reply-vs-feed-card ordering gap
    0.91.0 only narrowed, rather than accept it as a permanent workaround. Web/GitHub research
    confirmed there is no server-side ordering guarantee across independent Telegram `sendMessage`
    calls at all (core.telegram.org/bots/faq; yagop/node-telegram-bot-api#192 and #240) - every
    client library's own recommended fix is the same: await each send's completion before issuing
    the next one. 0.91.0's `onBeforeReply` only *started* the feed's flush a few microtasks earlier
    (`feedCoalescer.reset(slug)`, fire-and-forget) - nothing stopped the reply's own, separately-
    throttled P1 send from completing first anyway, so it stayed a race, just a narrower one.
    Closed it by making the barrier a real await instead: `FeedCoalescer.reset`/`flush` and
    `RateGovernor.schedule`/new `scheduleP2Async` now return (never-rejecting) promises that
    resolve once the underlying send actually settles, not merely starts; `pipe-server.ts`'s
    `handleReply` awaits `onBeforeReply`'s result before building/sending its own chunks, bounded
    by a new `onBeforeReplyTimeoutMs` (default 1500ms) so a wedged or heavily rate-limited feed bot
    can never stall a reply indefinitely - that bound is the one remaining non-guarantee, and only
    bites on a genuine network stall (an empty feed bucket already resolves immediately, since P2
    is still droppable-not-queued). The common case - the near-totality of real turns - now has an
    actual ordering guarantee: the reply's HTTP request cannot even begin until Telegram has already
    accepted the feed card describing what produced it. Self-review before shipping surfaced one
    more real gap: `handleReply`'s new await sat inside its own try/catch with no `.catch()` on
    `onBeforeReply`'s promise - a future change to the feed-flush chain that let a rejection through
    (today's `scheduleP2Async` deliberately never does) would propagate to that catch and skip
    sending the reply entirely, silently dropping the operator's actual answer over a wholly
    unrelated ordering-barrier failure. Added the missing catch (logs a named WARN, lets the reply
    through regardless) plus a regression test; also cleared the timeout race's timer handle on the
    non-timeout path rather than leaving it armed for up to 1500ms doing nothing. 9 new tests
    (`rate-governor.test.ts`'s schedule()-promise contract, `feed-coalescer.test.ts`'s
    reset()-promise propagation, `pipe-server.test.ts`'s awaited-barrier, bounded-timeout, and
    rejecting-barrier cases). 953 total (up from 944), `tsc --noEmit` clean."
  - "0.96.1 (2026-08-07): follow-up to 0.96.0 below, prompted by being asked directly whether the
    resume-in-place rewrite was covered by tests - it wasn't; `autoRecoverWedgedSession` had gone from
    zero tests to zero tests across that rewrite, covered only by \"restart and confirm clean
    startup\", which never exercises the wedged path at all. Extracted the one piece of it that's
    actually decidable - and the one regression that would silently defeat the whole fix - into new
    `wedged-recovery.ts`'s `recoverWedgedPty(ptyProcessBySlug, slug)`: kills the named entry's PTY
    without ever deleting it from the map first. That \"don't delete first\" is the entire mechanism
    that makes this recovery kill indistinguishable from a real crash to `handleUnexpectedExit` - the
    one contract worth a permanent regression guard, distinct from index.ts's own remaining
    orchestration (`sessionStore`/`log`/wiring), which stays a closure-inside-main() like the rest of
    that file's command handlers. 4 new tests in `wedged-recovery.test.ts`: no-op on a missing slug,
    kills and returns true on a live one, the map entry survives the call (the regression guard),
    and killing one slug never touches another's entry. 944 total (up from 940), `tsc --noEmit`
    clean."
  - "0.96.0 (2026-08-07): investigated a live report - session \"check-what-is-left-to\" wedged
    (Telegram: \"isn't responding to its last message ... Try /kill then /new again\"). Root-caused via
    bridge.log (not bridge-dev.log - this instance was started via `bun run`, not the dev script, so
    its stdout landed in the plain log file instead): the channel server connected in well under a
    second, but `waitForChannelConnected`'s 15s wait still timed out and \"proceeded anyway\" - the
    connect event fired before the waiter was even registered, an unhandled two-sided race with the
    old plain `Map<string, () => void>` (no way to represent \"this already happened\", only \"someone
    is waiting\"). Right after, the very first write into the PTY hit `Socket is closed` - confirmed
    live that both the `claude` process and its channel server (bun) were still running and burning
    CPU, so this is the same independently-dying node-pty/ConPTY write-socket bug `pty-write-guard.ts`
    already documented finding live on 2026-08-06/07 - back then it crashed the daemon, the guard added
    since stops that crash, but left the session a permanent zombie with no recovery path beyond the
    operator noticing and typing `/kill` + `/new` by hand - which also throws the conversation away
    (a fresh slug/topic/worktree, not a continuation). Two fixes: (1) new
    `channel-connect-coordinator.ts` (`ChannelConnectCoordinator`) replaces the old waiter map -
    `onConnected` firing before `waitFor` is called now records the signal (lazily expired via an
    injected clock rather than its own timer, same TTL convention as confirm-registry.ts) instead of
    losing it, closing the avoidable 15s stall. (2) `index.ts`'s `confirmSubmitted` - which already
    detects \"produced no output after 2 attempts - likely wedged\" - now calls a new
    `autoRecoverWedgedSession`. First cut reused `/kill`'s own `killSessionRow` teardown and told the
    operator to `/new` again - asked directly \"is there a way to restore/fix and continue\" instead,
    which surfaced that this project already has exactly that primitive: `handleUnexpectedExit`
    (§12 Phase 5's crash supervisor, wired to every PTY's `onExit`) already does `claude --resume
    <session_id>` on a fresh PTY - same slug/topic/worktree - whenever a session's process exits
    without `ptyProcessBySlug`'s entry having been cleared first (the one thing `/kill`/`/rm`
    deliberately do *before* their own `.kill()`, specifically to mark that exit as deliberate and
    skip resuming it). So `autoRecoverWedgedSession` now just calls `.kill()` on the wedged PTY
    *without* clearing that map entry first - indistinguishable from a real crash to the existing
    handler, which resumes it in place (with its own already-tested backoff/give-up safety net,
    `MAX_CONSECUTIVE_RESUME_ATTEMPTS`, for the rarer case where even a resume immediately re-exits)
    instead of a hand-rolled kill-and-ask-for-`/new`. Does not fix the underlying ConPTY write-socket
    death itself (a real, still-open Windows/node-pty bug outside this codebase's control) - only
    makes the Bridge self-heal once it happens, continuing the same conversation instead of
    zombie-ing or discarding it. 7 new tests in `channel-connect-coordinator.test.ts` (940 total, up
    from 933), `tsc --noEmit` clean. `autoRecoverWedgedSession`/the `confirmSubmitted` wiring itself
    stays untestable in isolation (same pre-existing closures-inside-main() gap §9 already accepts
    for `handleNewCommand` et al.) - covered indirectly via the now-tested coordinator, the
    already-live-exercised `resumeSession`/`handleUnexpectedExit` path it now deliberately falls
    into, and a live restart to confirm clean startup."
  - "0.95.1 (2026-08-07): follow-up to 0.95.0 below, prompted by being asked directly whether it was
    fully tested - it wasn't. Added the pure-logic edge cases the first pass missed in
    `message-context.test.ts`: the exact 200-char preview boundary (not just 'over it'), an
    empty-string `text`/`caption` (falsy but not `undefined` - confirmed it's treated as absent, same
    as truly missing), `text` preferred over `caption` when a message somehow carries both, and an
    unrecognised future `forward_origin.type` degrading to `''` rather than throwing. Also
    live-verified the actual `index.ts` wiring itself (unit tests structurally can't reach it) against
    the real running Bridge via `scripts/telegram-automation/`: a genuine Telegram
    `reply_to_message` on a live message correctly produced
    '[Replying to an earlier message with no text/caption]' inside the `<channel>` tag the session's
    PTY actually received (confirmed in `bridge-dev.log`). New `reply-context-test.js` one-off,
    kept for reuse - its own trial-and-error surfaced two real Telegram-Web-K/Playwright gotchas now
    documented inline: a topic's sidebar row must be selected via `.last()`, not `.first()` (a hidden
    'all chats' duplicate of the same row sits earlier in the DOM with a null bounding box), and the
    right-click context menu's 'Reply' item needs polling for a real bounding box rather than one
    `locator().click()` attempt. A full forward-message live trial was attempted but not completed -
    a live chat's own real-time re-sorting (every stray test message that lands in the wrong topic
    triggers an immediate reply there, which reorders the sidebar) raced with the test script's own
    element lookups, compounding with each retry; given the reply case's mechanism is already
    confirmed live and forward/reply share the exact same `buildContextPrefix`/`dispatchInboundMessage`
    code path, this was judged not worth further tooling time. 5 new tests (932 total, up from 927),
    `tsc --noEmit` clean."
  - "0.95.0 (2026-08-07): operator asked whether forwarded messages and Telegram's own swipe-to-reply
    were handled - content-wise (text/voice/photo/document/video/audio) they always were, since every
    handler only ever branched on the content fields, never on `forward_origin`/`reply_to_message`
    (not even present in `TelegramMessage`'s type). But the *provenance* was silently dropped: a
    forwarded message read to Claude exactly like the operator's own words, and a reply quoting a
    specific earlier message carried no indication of which one. Operator confirmed wanting both
    surfaced, concretely for the 'I reply to an earlier useful message for additional context' case.
    New `message-context.ts`: `buildContextPrefix(origin)` builds a `[Forwarded from X]`/`[Replying to
    an earlier message: \"...\"]` prefix (200-char quote preview, same length `postStaleConfirm`
    already uses) from a `MessageOrigin` (`forward_origin`/`reply_to_message`, added to
    `TelegramMessage` in telegram.ts). Applied only at the genuine 'this reaches the session' send
    (`dispatchInboundMessage`'s new `contextPrefix` parameter, used solely at its final
    `sendChannelText` call) - never mixed into the text every `/command` parse in that same function
    runs against, so a reply-quoting a real command doesn't stop parsing as one. Threaded through
    every path that eventually reaches a session: the main text handler, `handleAttachmentMessage`
    (photo/document/video/audio/video-note), `handleVoiceMessage` (both the immediate auto-send path
    and the confirm-card 'Send' tap, which needed `PendingVoiceConfirm` to carry `origin` since the
    tap can land minutes later), and the stale-inbound replay path (`PendingStaleConfirm` gained the
    same `origin` field). New tests: 11 in `message-context.test.ts`. 927 total passing (up from 916),
    `tsc --noEmit` clean."
  - "0.94.1 (2026-08-07): follow-up to 0.94.0 below, prompted by the operator asking whether the fix
    had tests - it didn't, and 'not independently unit-testable' was the wrong call: this codebase's
    own established pattern (`session-launcher.ts`'s `buildClaudeSpawnArgs`) is to pull the exec
    call's *argument-building* out as a pure, exported, testable function, leaving only the impure
    `execFile`/`spawn` call itself untested - `routeViaCli` should have gotten the same treatment the
    first time. Extracted `buildRouteViaCliArgs` (nl-router.ts) out of `routeViaCli`; 2 new tests in
    `nl-router.test.ts` assert `--strict-mcp-config` is always present (so a future 'simplification'
    that drops it fails a test instead of only ever showing up live again) and that the model/schema/
    message text are all carried through. 916 total passing (up from 914), `tsc --noEmit` clean."
  - "0.94.0 (2026-08-07): a garbled voice transcript ('IEI-Бридж' for 'AI-Bridge', a whisper-server
    mishearing) answered 'Unrecognised control-topic command' instead of matching kind='new' the way
    the 0.92.0/repo-name-hint logic should have. `bridge-dev.log` showed the real cause: a
    `channel server for \"Temp\" connected` line ~26s before `nl-router (cli backend) call failed`
    (its execFile timeout). Root cause: the aibridge-telegram MCP server is registered user-level in
    `~/.claude.json` (§2.4) specifically so a real session never gets a 'new MCP server' consent
    dialog - but that registration applies to *any* `claude` invocation on this machine, including
    the NL router's own ad hoc `claude -p` classifier calls (run from the OS temp dir, per
    2026-08-06's note). Every single classification call was therefore auto-connecting to the
    Bridge's own named pipe as a stray, pointless channel, adding real token/latency overhead on top
    of an already-documented ~20-30k-token fixed cost - live-reproduced by hand: re-running the exact
    failing command with `--strict-mcp-config` dropped cache-creation tokens from ~23.7k to ~4.6k and
    the stray channel connection vanished outright (the classifier never calls a tool anyway - it
    only ever produces `--json-schema`'s structured output). Fixed by adding `--strict-mcp-config` to
    `routeViaCli`'s `claude -p` invocation (nl-router.ts) and, as a safety margin against slower
    classifications generally, raising its execFile timeout 30s -> 45s (named `EXEC_TIMEOUT_MS`). Not
    independently unit-testable (same as `session-launcher.ts`'s `pty.spawn` - the impure exec call
    itself, as opposed to pure argument-building, has no existing extraction pattern here); verified
    via `tsc --noEmit` + the full suite (914 passing, unchanged) plus the live hand-reproduction above,
    and will be live-verified again after this restart with the same voice transcript replayed."
  - "0.93.0 (2026-08-07): operator hit a destructive-NL-command confirm card (nl-confirm.ts, e.g. the
    kind='rm' one 0.92.0 just made reachable by voice) expire before they tapped it, and asked whether
    a `/retry` existed to re-arm it instead of retyping/re-recording the exact same request and hoping
    the router classified it identically a second time. New `retry-store.ts`: `RetryStore` (a
    `ConfirmRegistry` keyed by topic, via a new `retryTopicKey`, rather than a random id - `/retry`
    never names one) remembers the single most recently *expired* nl-confirm per topic; the sweep
    loop and the tap-loses-the-race-against-the-sweep path (index.ts) both now stash into it via a new
    `markNlConfirmCardExpired` (the expired card's own text now says '/retry to re-arm it, or send it
    again'). `isRetryPhrase` recognises `/retry` and its natural-language voice/text equivalents
    ('retry', 'try again', 'do it/that again', with or without the leading slash/trailing
    punctuation) - checked in `dispatchInboundMessage` only when `retryStore` actually holds something
    for that topic, so ordinary chatter that happens to contain 'retry' still falls through to the
    session untouched. Deliberately scoped to nl-confirm only, not all four confirm-card kinds (fleet
    `--all`, stale-inbound, voice-transcript review) - `--all`'s target list can go stale within
    minutes and stale/voice confirms are inherently time-/content-sensitive, so blindly replaying
    either past its own cautious TTL is a different, riskier call than re-arming one already-
    classified command; extend the same way later if wanted. Added `retry` to `botCommandList()`
    (so it's discoverable via `/help` and Telegram's own autocomplete) with a documented exemption in
    `nl-router.test.ts`'s completeness check, since `/retry` is intercepted before the NL router is
    ever consulted and re-arms in-memory state the router has no way to produce as structured output.
    New tests: 9 in `retry-store.test.ts`; `nl-router.test.ts`'s completeness check updated with a
    documented `NEVER_ROUTED` exemption for `retry`. 914 total passing, 0 failures, `tsc --noEmit`
    clean."
  - "0.92.0 (2026-08-07): operator asked why they couldn't kill/remove a session from inside its own
    topic - had to go to the control topic and name it by slug instead. Investigation found the
    mechanism already exists: a slug-less `/kill`/`/rm` typed as an exact command already resolves to
    the current topic's own session (`resolveTargetSlug`, index.ts), and `removeSessionRow` already
    tears down the live PTY and deletes the topic itself either way. The actual gap was one level up,
    in `nl-router.ts`: its instructions only ever described kill/rm as naming 'a specific named
    session' or explicitly 'all', so a natural-language 'delete this session'/'kill yourself' (no
    slug, no 'all') matched neither, fell through to kind='forward', and was handed to Claude itself
    as ordinary chat - which has no way to remove its own session and could only tell the operator to
    go type a command in the control topic (confirmed live: exactly the reply screenshotted). Fixed
    by making `buildSystemInstructions` context-aware: when `ctx.hasSession` (i.e. sent from inside a
    session's own topic), it now appends a sentence telling the classifier that a self-referential
    kill/rm ('this session', 'kill yourself', 'remove this one') with no other session named is still
    kind='kill'/'rm' with 'slug' left unset, not kind='forward' - the topic itself already identifies
    the target, matching what `resolveTargetSlug` already does for the typed-command form. Exported
    `buildSystemInstructions` (previously module-private) so this is unit-testable. New tests: 2 in
    `nl-router.test.ts` (hint present only when `hasSession`, still composes correctly with the
    repo-names hint). 905 total passing, 0 failures, `tsc --noEmit` clean."
  - "0.91.0 (2026-08-07): two operator-observed feed-card oddities in the same live topic. (1) A
    session's final `reply` routinely landed in Telegram *before* the 'working...' activity card
    describing the tool calls it was actually summarising - causally backwards, since the reply's
    content depended on that investigation. Root cause: the P1 (reply) lane is deliberately
    unthrottled (§5.4 - a reply/permission-prompt must never wait on feed traffic) while the feed
    card sits behind `feed-coalescer.ts`'s own several-second coalescing interval on the fully
    independent P2 lane - nothing forced that turn's final card frame to flush before the reply that
    summarised it. Fixed with a new `onBeforeReply` pipe-server hook, fired right before a reply's
    text is sent, wired to `feedCoalescer.reset(slug)` (the same force-flush `reset` already used at
    turn boundaries) - gives the feed card a head start instead of none; not a hard ordering
    guarantee (still two independent rate-governor lanes), just a much better common case. (2) A long
    turn's compact card showed only its newest 8 lines behind an opaque '…and N earlier steps'
    counter, with no hint of how the turn actually started. Changed `feed-renderer.ts`'s `renderCard`
    to a head + tail split once a turn exceeds the visible-line cap: the first 3 lines (`HEAD_LINES`)
    lead the card, the most recent 5 close it, and the gap in between is reported as '…N additional
    steps…' - applied to both `detail: compact` (fixed line counts) and `detail: full` (the same idea
    budgeted by character length, with the head capped at 30% of the budget so it can't crowd out the
    tail). New/updated tests: 1 for `pipe-server.ts`'s `onBeforeReply` firing-before-send ordering, 4
    updated + 1 new in `feed-renderer.test.ts` for the head+tail split (compact and full detail). 903
    total passing, 0 failures, `tsc --noEmit` clean."
  - "0.90.0 (2026-08-07): operator feedback on the 0.89.0 entry just below - 'config.phase1.slug' is
    a strange name. Confirmed the identifier was confined to exactly two files (config.ts, index.ts -
    every other 'phase1'/'Phase 1' hit elsewhere in the repo was prose about the design stage, not
    this field) and that no PHASE1_* var was ever actually set in the live `.env`, so this was a pure,
    migration-free rename: `config.phase1` -> `config.selfCheck`, `PHASE1_SLUG`/`PHASE1_TOPIC_ID`/
    `PHASE1_REPO_PATH`/`PHASE1_WORKTREES_ROOT` -> `SELF_CHECK_SLUG`/`SELF_CHECK_TOPIC_ID`/
    `SELF_CHECK_REPO_PATH`/`SELF_CHECK_WORKTREES_ROOT`. `selfCheck` was picked (offered alongside
    `devSession`/`bootSession`) because it names what the thing actually verifies - a permanent
    internal smoke-test session the Bridge always relaunches at startup to prove it can spawn a
    session at all - rather than just when it runs or that it's dev-only. No behaviour change,
    tsc --noEmit clean, bun test 902/902 passing."
changelog_archive_note: >-
  Entries older than the 15 kept above have been moved in full, newest-first, to
  plans/telegram-claude-session-control-changelog.md - nothing was deleted.
v0190_touched_sections:
  - section: "§5 The activity feed"
    type: modified
    summary: "§5.1's event table live-verified via Stage 0's spike; §5.3/§5.4/§5.5 implemented as feed-state.ts/feed-renderer.ts/rate-governor.ts/feed-coalescer.ts, details button not yet wired to a callback"
  - section: "§9 Test scenarios"
    type: modified
    summary: "Scenarios 14-21 implemented as real unit tests (rate-governor, feed-coalescer, feed-renderer, feed-escape, hook-events, feed-state)"
  - section: "§12 Phase 3 - activity feed"
    type: modified
    summary: "Marked functionally complete; recorded the two deliberately deferred gaps (P0/P1 governor wiring, the details button) and the one exit-criterion half that needs Phase 5's /new to test (two concurrent sessions)"
v0180_touched_sections:
  - section: "§4.2 Commands (control topic)"
    type: modified
    summary: "Added the /effort <low|medium|high|xhigh|max> command row"
  - section: "§4.2.3 /effort: same primitive as /model, plus a confirmation dialog neither of the other two has"
    type: added
    summary: "New subsection: the live-verified confirmation dialog, the same-tick-\\r timing hazard and its 200ms-delay fix, and the bare-/model|/mode|/effort button keyboard added for all three commands"
  - section: "§12 Phase 5 - the fleet"
    type: modified
    summary: "Marked /model, /mode and /effort done; /effort added and live-verified in this pass"
v0170_touched_sections:
  - section: "§3.1 Capability declaration"
    type: modified
    summary: "Noted the claude/channel/permission notification shape is now live-verified, not quoted from docs - matches §6.3's fields exactly"
  - section: "§9 Test scenarios"
    type: modified
    summary: "Scenarios 4-13 and 30 implemented as real unit/integration tests (131 total passing) rather than a checklist"
  - section: "§12 Phase 2 - permission relay"
    type: modified
    summary: "Marked complete; recorded what shipped vs. what's deliberately deferred to Phase 3 (the PermissionRequest hook's resolution-heuristic role) vs. genuinely unverified (settings hot-reload mid-session)"
v0160_touched_sections:
  - section: "§4.2 Commands (control topic)"
    type: modified
    summary: "Added the /restart command row, marked fleet-scoped rather than session-scoped"
  - section: "§4.5.1 /restart: an operator-triggered version of the same event"
    type: added
    summary: "New subsection: self-respawn mechanism, why it's not a new code path, and the honest Phase 1 caveat that it currently loses conversation history rather than resuming it"
  - section: "§9 Test scenarios"
    type: added
    summary: "Scenario 44: /restart is fleet-scoped (rejected from a session topic) and spawns a detached successor before exiting, not a real process kill in the unit test"
  - section: "§12 Phase 5 - the fleet"
    type: modified
    summary: "Added a /restart bullet, scoped to Phase 5 because it depends on this phase's session-id persistence to stop being destructive"
v0151_touched_sections:
  - section: "§4.2.2 /mode: the same primitive, plus a state-tracking problem /model doesn't have"
    type: modified
    summary: "Cycle order promoted from inferred to live-verified: four \\x1b[Z writes against the real Phase 1 session, reading the resulting mode label after each press"
  - section: "§12 Phase 5 - the fleet"
    type: modified
    summary: "Updated the /mode bullet - cycle order is now live-verified, no longer a shipping blocker"
v0150_touched_sections:
  - section: "§4.2 Commands (control topic)"
    type: modified
    summary: "Added the /mode <name> command row"
  - section: "§4.2.2 /mode: the same primitive, plus a state-tracking problem /model doesn't have"
    type: added
    summary: "New subsection: Shift+Tab-based mode cycling, the relative-vs-absolute problem, routing-table state tracking, and the honestly-inferred (not yet verified) cycle order"
  - section: "§9 Test scenarios"
    type: added
    summary: "Scenario 43: /mode computes the correct number of Shift+Tab writes from tracked state and updates it, table-driven over the cycle"
  - section: "§12 Phase 5 - the fleet"
    type: modified
    summary: "Added a /mode bullet next to /model's, flagging the cycle order as needing live confirmation before shipping"
v0140_touched_sections:
  - section: "§4.2 Commands (control topic)"
    type: modified
    summary: "Added the /model <name> command row"
  - section: "§4.2.1 /model: why this needs a keystroke, not a shim"
    type: added
    summary: "New subsection: why /model cannot use the /cmd shim mechanism, and the raw-PTY-write design that generalises §10.1's dev-control port into a real feature"
  - section: "§9 Test scenarios"
    type: added
    summary: "Scenario 42: /model writes the raw keystroke directly to the PTY, bypassing renderChannelTag; an invalid model name is rejected before anything is written"
  - section: "§12 Phase 5 - the fleet"
    type: modified
    summary: "Added a bullet for /model alongside the per-session model routing it extends, and added scenario 42 to the phase exit criteria"
v0130_touched_sections:
  - section: "§12 Phase 1 - walking skeleton"
    type: modified
    summary: "Added a post-exit-criteria bullet documenting the operator-visible working indicator (typing action + message-based thinking placeholder), including the live-discovered Telegram Desktop typing-indicator bug and the fix"
v0120_touched_sections:
  - section: "§4.5 Restart recovery and orphan reconciliation"
    type: modified
    summary: "Scenario 37 measured live: sessions do not survive Bridge death on this stack (Stop-Process on the Bridge alone killed claude.exe and its channel-server child too). Struck the two bullets that assumed partial re-adoption / an open question, replaced with the measured consequence: claude --resume is the only recovery path, always, and the Job Object opt-out is now a concrete next step rather than a contingency"
  - section: "§12 Phase 1 - walking skeleton"
    type: modified
    summary: "Marked complete: scenario 29 (proven live via PTY injection, v0.11.0) and scenario 37 (measured: sessions don't survive Bridge death) are both done"
v0110_touched_sections:
  - section: "§10.1.2 notifications/claude/channel is broken upstream, independent of channelsEnabled - decision: stop using it for inbound"
    type: added
    summary: "New section superseding §10.0's RESOLVED framing. Documents the live 2026-08-03 repro (server.getClientCapabilities() returns undefined), cross-references the consolidated upstream tracker anthropics/claude-code#36431, surveys community bridge projects (all use tmux/PTY keystroke injection, none use the channel-notification path), and records the decision to switch Phase 1 inbound delivery to direct PTY text injection while keeping the reply MCP tool for outbound"
  - section: "§2.4 Session launch: registration, identity and the three dialogs"
    type: modified
    summary: "Two corrections to claims that turned out false when tested live: (1) --dangerously-load-development-channels resolves server:<name> against the worktree's .mcp.json, not ~/.claude.json's per-project registration, so the per-/new consent dialog this plan thought it had avoided is unavoidable for a channel; (2) a registered MCP server's env does not inherit from the outer claude.exe process's env, so AIBRIDGE_SLUG/AIBRIDGE_TOPIC must be set directly on the server's own env key. Also added: a bare command: \"bun\" doesn't resolve, for the same reason a bare claude didn't (correction 4) - resolve bun.exe's absolute path the same way"
v0100_touched_sections:
  - section: "§6.1.1 Why a target repo's own guard hook does not defeat this"
    type: modified
    summary: "Layer-number cross-references to SeoWrite's guard-git-write.ps1 renamed to name layers by function (protected-branch hard block, --no-verify hard block, auto-allow) with current numbers kept only as a dated snapshot, after the hook was renumbered by an unrelated concurrent edit"
  - section: "§7.3 A target repo's own guard hook needs no work from aibridge"
    type: modified
    summary: "Same layer-number drift fix as §6.1.1, applied to this section's worked-example paragraph"
  - section: "§9 Testing"
    type: modified
    summary: "Added scenarios 40-41: sessions.state transitions match §4.3's table; non-429 send failures retry then fail loud rather than vanish"
  - section: "§8.2 Controls"
    type: modified
    summary: "Pairing bootstrap code now has an explicit charset (matching the request_id alphabet) and a 10-minute single-use expiry"
  - section: "§12 Phases"
    type: modified
    summary: "P-2 now validates both bot tokens with a getMe call at startup before the poller registers or any session launches"
  - section: "§5.7 Telemetry: the third event path"
    type: modified
    summary: "Clarified that query_source distinguishes request origin, not billing pool, so it cannot verify §10.5's subscription-vs-credit-pool split"
v090_touched_sections:
  - section: "§5.6 Attachments and compaction"
    type: modified
    summary: "Corrected Telegram's bot file-download cap from 50MB to the actual documented 20MB"
  - section: "§5.4 Rate limits: the real budget"
    type: modified
    summary: "Added a retry/backoff policy for non-429 Telegram API failures (5xx/timeout/network), so a P0 permission-prompt send failure is never silently assumed delivered"
  - section: "§4.1 Prerequisites"
    type: modified
    summary: "Softened the channelsEnabled 'no error anywhere' claim - current docs show a startup-time admin banner now exists; only per-event mid-session delivery stays silent"
  - section: "§4.3 The routing table"
    type: added
    summary: "New exhaustive state-transition table for sessions.state, including the dead-topic-message edge case"
  - section: "§9 Testing"
    type: modified
    summary: "Added aibridge's own logging-level convention (ERROR/WARN/INFO) for the Bridge's operational log, alongside the existing testing convention"
  - section: "§11 Deliberately not building"
    type: modified
    summary: "Removed the speculative Transport interface claim (YAGNI, one concrete implementation) - Telegram code stays in its own module until a second transport justifies the seam"
  - section: "§12 Phases"
    type: modified
    summary: "P-1 now distinguishes the node-pty build-toolchain risk from a separate Bun NAN-vs-NAPI ABI loading risk; Phase 6a's exit criterion now cites scenarios 24 and 37"
v080_touched_sections:
  - section: "§Overview Four decisions already made"
    type: modified
    summary: "Added decision 5: ship as its own reusable repo (aibridge), project identity is a repos.toml lookup, not code"
  - section: "§4.1.1 One operator, one instance - a second person means a second, fully independent instance"
    type: modified
    summary: "Reframed from 'this repo's second developer' to the general one-operator-one-instance rule, with SeoWrite/Devitgroup kept as a labelled worked example"
  - section: "§6.1.1 Why a target repo's own guard hook does not defeat this"
    type: modified
    summary: "Reframed: SeoWrite's guard-git-write.ps1 is now explicitly a worked example from the pilot project, not aibridge's own file - aibridge touches no file in any target repo"
  - section: "§7.3 A target repo's own guard hook needs no work from aibridge"
    type: modified
    summary: "Reframed from 'this repo's second developer' framing to the general target-repo framing"
  - section: "§9 Testing"
    type: modified
    summary: "Scenario 13 reframed as a target-repo's own testing responsibility, not aibridge's"
  - section: "§7.6 The WSL2 migration, held for Phase 6"
    type: modified
    summary: "Bash-port item reframed as a target repo's own porting responsibility"
v073_touched_sections:
  - section: "§4.1.1 One operator, one instance - a second person means a second, fully independent instance"
    type: modified
    summary: "Refined with three Owner-confirmed facts: channelsEnabled is not per-developer, §10.5's concurrency/burn-rate figures are per-instance arithmetic not a portable policy, and the P-4 probe need not be repeated per operator"
  - section: "§10.5 Usage limits and cost"
    type: modified
    summary: "Flagged the weighted-concurrency cap and burn-rate threshold as Max-5x-specific arithmetic, not a universal policy - a second operator needs their own pass through the method"
v072_touched_sections:
  - section: "§4.1.1 One operator, one instance - a second person means a second, fully independent instance"
    type: added
    summary: "New section: each developer runs a fully independent instance (own machine, clone, supergroup, tokens); records why §4.1 setup cannot be scripted via the Bot API"
v071_touched_sections:
  - section: "§10.1 Research-preview churn"
    type: modified
    summary: "Corrected: escape from --dangerously-load-development-channels is self-service via allowedChannelPlugins in managed settings, not a wait on Anthropic; noted an empty allowedChannelPlugins blocks the allowlist but not the dev flag"
v070_touched_sections:
  - section: "§10.0 Inbound channel delivery: RESOLVED, proven end to end on 2026-08-02"
    type: modified
    summary: "Rewritten from a failure record to a proof record - the go/no-go passed, all 20 pushed events reached Claude's context"
  - section: "§10.1.1 channelsEnabled is an org switch we do not control"
    type: added
    summary: "New: the two failed probes were channelsEnabled being unset on the org, not a protocol fault; documents the mitigation (startup nonce probe, periodic re-probe)"
  - section: "§6.5 Reconciliation, and what the protocol does not give us"
    type: modified
    summary: "PermissionRequest hook carries no tool_use_id/permission_rule_id/permission_rule_text; stops joining and renders the approval card from the channel payload alone; resolution falls back to (session_id, tool_name, deep-equal tool_input)"
  - section: "§2.4 Session launch: registration, identity and the three dialogs"
    type: modified
    summary: "Dialog table grows from three to five with the first-run onboarding blockers (theme picker, fullscreen-renderer offer)"
  - section: "§3.2 Inbound: Telegram to Claude"
    type: modified
    summary: "source is reserved and must never appear in meta; the liveness warning must key on hook activity since a reply is not a per-event acknowledgement"
  - section: "§6.2 The per-session settings baseline"
    type: modified
    summary: "mcp__aibridge__reply joins the baseline allowlist since MCP tool calls raise their own permission dialog"
  - section: "§4.3 The routing table"
    type: modified
    summary: "Every path key must be canonicalised - ~/.claude.json holds duplicate drive-letter-case project entries"
v060_touched_sections:
  - section: "§10.0 Inbound channel delivery is unproven, and one probe of it failed"
    type: added
    summary: "Channel loads and connects on 2.1.220, but 8 pushed events across 2 turns never reached Claude's context; most likely a headless limitation, unfalsifiable headlessly, so Phase 1.0 is a go/no-go interactive probe"
  - section: "§7 Running on Windows"
    type: modified
    summary: "Rewritten from Running on WSL2. Filesystem boundary gone, Task Scheduler replaces systemd, logon-not-boot gap recorded, and §7.3 becomes the guard needs no work"
  - section: "§7.6 The WSL2 migration, held for Phase 6"
    type: added
    summary: "Six-step migration checklist with its triggers, and the explicit list of what does not change"
  - section: "§6.7 The OS-level sandbox, and why Windows does not get one"
    type: modified
    summary: "Split: 6.7.1 what compensates on Windows and what does not, with an honest per-problem table; 6.7.2 holds the WSL2 config plus five newly-found settings to assess at migration"
  - section: "§2.3 / §2.4 / §2.5 session model and IPC"
    type: modified
    summary: "tmux replaced by node-pty/ConPTY (cross-platform, so the migration keeps it); unix socket becomes a named pipe; dev-channels flag existence verified and recorded"
  - section: "§4.5 Restart recovery"
    type: modified
    summary: "Re-adoption is partial without tmux - the Bridge can see a live session but cannot reattach its PTY; child survival across Bridge death added as scenario 37"
  - section: "§10.4.1 Losing the sandbox for Phases 1-5"
    type: added
    summary: "The counterweight to the host decision, with what makes it acceptable now and what would not be"
  - section: "§12 Phases"
    type: modified
    summary: "P-1 rewritten for Windows, P-3 deleted, P-4 becomes a status table with two verified and four interactive items; Phase 1 gains a go/no-go 1.0; Phase 6 splits into 6a hardening and 6b migration"
v050_touched_sections:
  - section: "§10.6 Plan mode is unavailable in channel sessions"
    type: added
    summary: "EnterPlanMode/ExitPlanMode disabled whenever a channel is configured; forces planning at the desk and execution from the phone"
  - section: "§2.5 The socket protocol"
    type: added
    summary: "Message catalogue, framing, correlation and channel-server reconnect after a Bridge restart"
  - section: "§4.2 Commands"
    type: modified
    summary: "Added /cmd shim, because repo slash commands cannot cross the channel boundary"
  - section: "§5.6 Attachments and compaction"
    type: added
    summary: "Inbound photos and documents land in a per-session inbox and are announced by path; PreCompact/PostCompact feed lines"
  - section: "§6.7 The OS-level sandbox"
    type: modified
    summary: "Strict mode softened: the unsandboxed retry is allowed but gated behind an ask rule, so a blocked command raises a button instead of wedging the task"
  - section: "§7.5 Repos, credentials and auth"
    type: added
    summary: "Repo registry, git push credentials and Claude Code auth inside WSL2, none of which were specified"
  - section: "§12 Phases"
    type: modified
    summary: "P-4.5 needs an interactive probe; P-1 and P-2 gain the credential and registry items"
v041_touched_sections:
  - section: "§2.4 / §4.2 model routing"
    type: modified
    summary: "Sonnet is the /new default; --opus and --haiku are the overrides"
  - section: "§10.5 Usage limits and cost"
    type: modified
    summary: "Rewritten for a Sonnet default: weighted concurrency budget of 4 units replaces the flat cap of 3, and the burn alarm drops from load-bearing to a guardrail"
v040_touched_sections:
  - section: "§6.1.1 Why the guard hook does not defeat this"
    type: modified
    summary: "Added the control/treatment probe and its result; the ask-rule precedence is now verified on this machine rather than quoted"
  - section: "§5.7 Telemetry: the third event path"
    type: added
    summary: "Bridge ingests claude_code.token.usage and claude_code.cost.usage over local OTLP, joined to the routing table on session.id; api_error events detect quota stops"
  - section: "§10.5 Usage limits and cost"
    type: modified
    summary: "Rewritten for Max 5x with Opus default: concurrency capped at 3, burn-rate alarm promoted to a mechanism, quota-stop detection specified"
  - section: "§2.4 / §4.2 model routing"
    type: modified
    summary: "Per-session --model flag, Opus default, /new --sonnet and --haiku overrides"
  - section: "§12 Phases"
    type: modified
    summary: "P-4 drops the verified item and renumbers to five; Phase 5 gains telemetry ingest"
v030_touched_sections:
  - section: "§2.4 Session launch: registration, identity and the three dialogs"
    type: modified
    summary: "Channel registered user-level in ~/.claude.json not per-worktree .mcp.json; identity via tmux -e AIBRIDGE_SLUG; MCP-consent and trust dialogs avoided by config, leaving one dialog to keystroke"
  - section: "§5.4 Rate limits: the real budget"
    type: modified
    summary: "Limits are per bot token, so a second send-only feed bot doubles the budget and isolates P2 from prompts; answerCallbackQuery also counts"
  - section: "§6.1.1 Why the guard hook does not defeat this (v0.2.0 correction)"
    type: modified
    summary: "Hook allow does not bypass ask rules; escalation moves to an ask rule in generated settings; AIBRIDGE_SESSION gate withdrawn and guard-git-write.ps1 left untouched"
  - section: "§6.2 The per-session settings baseline"
    type: modified
    summary: "Rewritten around the documented deny/ask/allow order; added the ask list, canonical tool names, the Write(path) never-consulted trap and the path-anchor rule"
  - section: "§6.4 AskUserQuestion becomes buttons"
    type: modified
    summary: "Per-hook timeout replaces the 540s hack; exact updatedInput/answers shape documented; AskUserQuestion always reaches the prompt even under an allow rule"
  - section: "§6.5 Reconciliation, and what the protocol does not give us"
    type: modified
    summary: "PermissionRequest observer hook supplies tool_use_id and full tool_input, so relay correlation is exact rather than heuristic"
  - section: "§6.7 The OS-level sandbox"
    type: added
    summary: "bubblewrap-backed sandbox runs on WSL2, auto-allows contained Bash, OS-enforces credential denial, and is the answer to approval fatigue and subprocess secret reads"
  - section: "§8 Security"
    type: modified
    summary: "Read/Edit deny rules do not constrain arbitrary subprocesses; sandbox.credentials and CLAUDE_CODE_SUBPROCESS_ENV_SCRUB are the enforcement that does"
  - section: "§9 Testing"
    type: modified
    summary: "Renumbered to 30 scenarios; added ask-rule precedence, path-anchor, canonical-name, two-bot governor and exact-correlation cases"
  - section: "§10.5 Usage limits and cost"
    type: added
    summary: "Four parallel sessions burn the 5-hour window ~4x; interactive tmux sessions draw on the subscription rather than the separate non-interactive credit pool"
  - section: "§12 Phases"
    type: modified
    summary: "P-1 gains the sandbox dependencies, P-3 loses the AIBRIDGE_SESSION gate, P-4 becomes an explicit six-item protocol probe"
v020_touched_sections:
  - section: "§6.1.1 Why a target repo's own guard hook does not defeat this"
    type: modified
    summary: "CRITICAL: found guard-git-write.ps1 Layer 3 auto-allows commit/push, pre-empting the channel relay; added the AIBRIDGE_SESSION escalation gate (later withdrawn in v0.3.0) and moved P-3 to a Phase 2 blocker"
  - section: "§5.4 Rate limits: the real budget"
    type: modified
    summary: "CRITICAL: fixed 3s coalescing overruns the 20/min group limit at 2+ sessions; replaced with session-count-scaled intervals and a 12/min P2 reservation"
  - section: "§7.3 A target repo's own guard hook needs no work from aibridge"
    type: modified
    summary: "Expanded bash-port parity requirements, pinned both implementations to test_claude_hook_guards"
  - section: "§9 Testing"
    type: modified
    summary: "Renumbered to 24 contiguous scenarios and corrected every cross-reference"
---

# Telegram Claude Session Control

## Overview

**Audience:** a single developer, working solo, driving development from a phone across any number of
their own git repos.

**Goal.** Conduct full development work from Telegram: run several Claude Code sessions in parallel,
one per Telegram forum topic, against any repo registered in `repos.toml` (§7.5) - switching projects
from the phone means passing a different `<repo>` name to `/new`, not standing up anything new; watch
a readable live feed of what each session is doing; answer Claude's questions by tapping buttons; and
approve or deny consequential tool calls (commits, pushes, deletions, network writes) by tapping
buttons. Switching sessions means switching topics.

**Why this is buildable now.** Anthropic shipped a first-party channel protocol in March 2026
([Channels](https://code.claude.com/docs/en/channels),
[reference](https://code.claude.com/docs/en/channels-reference)). A channel is an MCP server that
Claude Code spawns over stdio, which can push events *into* a live session and receive relayed
permission prompts back out. That is the hard half, and it is supported rather than scraped.

**Why a custom channel rather than the official Telegram plugin.** The official plugin
([source](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram))
has no forum-topic support, no inline keyboards, and no session fleet concept. It is a 1:1 DM bridge.
We keep it as the reference implementation for the pairing flow and attachment handling, and build our
own server against the same protocol.

### Four decisions already made

| # | Decision | Consequence |
|---|---|---|
| 1 | **Host = native Windows** for Phases 1-5, WSL2 held for Phase 6 (revised 2026-08-02) | No sandbox until the migration (§6.7), and no tmux; in exchange no reboot, no `/mnt/c` boundary, no second clone, and each registered repo's own `PreToolUse` guard hooks (where present) run unmodified (§7) |
| 2 | **Fidelity = curated feed**, not a raw TUI mirror | One in-place-edited turn card per topic, tool calls collapsed to summaries, detail on demand (§5) |
| 3 | **Permissions = allowlist + button escalation** | Safe reads/builds/tests pre-approved in settings; everything else raises an inline keyboard (§6) |
| 4 | **Build a custom channel server**, do not fork | Own the protocol surface; accept research-preview churn risk (§10) |
| 5 | **Ship as its own reusable repo** (`aibridge`), not embedded in any one project (added 2026-08-02) | The Bridge, channel server and hook client carry no project-specific code; "which project" is a `repos.toml` lookup (§7.5), not something baked into this codebase. This plan's worked examples (SeoWrite's `guard-git-write.ps1`, its CLAUDE.md conventions) are the pilot project's, not aibridge's own - the same design applies to any registered repo, with or without such a hook |

### The gap that shapes the whole design

Channels carry **only** two things: messages you push in, and text Claude deliberately sends out by
calling the channel's `reply` tool. Thinking blocks, tool calls, file edits and diffs never reach the
channel. The docs say so plainly: "you see the inbound message in your terminal but not the reply
text."

So requirement 2 (see what Claude is doing) cannot be met by the channel protocol at all. It has to
come from [hooks](https://code.claude.com/docs/en/hooks). That splits the system into two independent
event paths that happen to land in the same Telegram topic, and most of the complexity in §5 and §6
is a consequence of that split.

### The constraint that forces a daemon

**The Telegram Bot API permits exactly one `getUpdates` consumer per bot token.** A second poller gets
`409 Conflict`. Since every Claude session spawns its own channel server process, those processes
cannot each talk to Telegram. One long-lived process must own the token and fan out.

That is the single most important structural fact in this plan, and it is why §2 has three components
instead of one. It also bounds the fix in §5.4: the fleet uses two bot tokens to double the rate
budget, but only one of them ever polls.

---

## 1. Terminology

| Term | Meaning |
|---|---|
| **Bridge** | The long-lived daemon. Owns both bot tokens, the routing table and all Telegram I/O |
| **Control bot** | The token that polls `getUpdates` and sends every prompt, keyboard and reply |
| **Feed bot** | A second, send-only token carrying turn cards, for its own rate budget (§5.4) |
| **Channel server** | Per-session MCP server spawned by `claude` over stdio. Implements `claude/channel` |
| **Hook client** | Tiny binary invoked by Claude Code hook events. Reports activity, blocks on questions |
| **Session** | One `claude` process, on one Bridge-owned PTY, in one git worktree, bound to one topic |
| **Topic** | A Telegram forum topic (`message_thread_id`) inside the single control supergroup |
| **Turn card** | The one message per turn that the feed renderer edits in place |

---

## 2. Architecture

```
                    Telegram Bot API
                           │  control token: getUpdates long-poll + all P0/P1 sends
                           │  feed token:    send-only, P2 turn cards
                           │
                    ┌──────┴───────┐
                    │    BRIDGE    │   Task Scheduler task, at logon (§7.2)
                    │              │   • routing table (SQLite)
                    │              │   • topic lifecycle
                    │              │   • rate governor, one bucket per token
                    │              │   • pending-prompt registry
                    │              │   • session supervisor (node-pty / ConPTY)
                    └──────┬───────┘
                           │  named pipe \\.\pipe\aibridge   (unix socket under WSL2, §7.6)
         ┌─────────────────┼─────────────────┐
         │                 │                 │
   ┌─────┴─────┐     ┌─────┴─────┐     ┌─────┴─────┐
   │ channel   │     │ hook      │     │ channel   │   … one pair per session
   │ server    │     │ client    │     │ server    │
   │ (stdio)   │     │ (exec)    │     │ (stdio)   │
   └─────┬─────┘     └─────┬─────┘     └─────┬─────┘
         │                 │                 │
    ┌────┴─────────────────┴────┐       ┌────┴────┐
    │  claude   (PTY, session A)│       │ claude  │
    │  worktree A               │       │ wt B    │
    └───────────────────────────┘       └─────────┘
```

### 2.1 Why three components and not one

The channel server has to be spawned by `claude` (the protocol requires stdio subprocess ownership),
so its lifetime is the session's lifetime. The Bridge has to outlive every session, because it owns
the token and the topic map. The hook client has to be a short-lived exec, because that is the only
shape Claude Code's `command` hooks take. Three lifetimes, three components.

All three speak one line-delimited JSON protocol over a unix socket. The socket, not the network, is
the trust boundary inside the machine: it is created mode `0600` in `$XDG_RUNTIME_DIR`.

### 2.2 Runtime and language

**TypeScript on Bun.** Justification:

- `@modelcontextprotocol/sdk` is the only hard dependency of a channel server, and it is a TypeScript
  package. Every official channel plugin is a Bun script, so the reference implementations are
  directly readable.
- Bun gives a single-file executable (`bun build --compile`) for the hook client, which matters:
  the hook client is exec'd on *every* tool call, so Node's ~40ms startup is a real tax at feed
  cadence. A compiled Bun binary starts in single-digit milliseconds.
- Bun ships an HTTP server, SQLite driver and test runner in-box, so the dependency surface stays
  small on a machine that is also the developer's daily driver.

The hook client is the one place where startup cost is load-bearing, so it is the compiled binary; the
Bridge and channel server run from source under `bun`.

### 2.3 Session model: one `claude` process per topic

Rejected alternative: **background agents** (`claude --bg`, `claude agents`, `claude attach`). They are
the obvious fit and `ccc` uses them, but three things disqualify them here:

1. The background-agent short id **changes on every resume**, so the routing table's primary key is
   unstable and needs continuous reconciliation. `ccc` documents this as a known wart it works around.
2. Background agents are driven through Agent View, which assumes a human at a terminal. There is no
   supported external supervision API, so we would be parsing `claude agents --json` on a timer,
   which is polling by another name.
3. We need per-session flags (`--dangerously-load-development-channels`, per-session settings, per-session
   worktree), and background agents inherit the parent's configuration.

Chosen: **one `claude` process per topic, each on its own pseudo-terminal owned by the Bridge**. This
buys three things:

- The `SessionStart` hook hands us a **stable `session_id`** at birth, which becomes the routing key.
- A real PTY means the session runs the interactive TUI, which is what keeps it on the subscription
  rather than the non-interactive credit pool (§10.5) and keeps `AskUserQuestion` available at all
  (§12 P-4.5).
- Restart recovery is `claude --resume <session_id>` on a fresh PTY, which is a supported path.

**Why a PTY library rather than tmux.** Earlier passes said "detached tmux window". tmux has no
Windows port, and the host is Windows (§7). The replacement is **`node-pty` over ConPTY**, and it is a
better fit than tmux was on three counts rather than a grudging substitute:

- It gives the Bridge **programmatic write access to the session's stdin**, which is what the
  development-channels dialog needs (§10.1). Under tmux that was `send-keys` shelling out to a second
  tool; here it is a method call on a handle the Bridge already holds.
- The PTY's lifetime is the Bridge's child-process lifetime, so supervision, health and restart are
  ordinary process management rather than screen-scraping `tmux list-windows`.
- **`node-pty` is cross-platform.** Choosing it now means the Phase 6 WSL2 migration (§7.6) does not
  have to revisit the session model at all. tmux would have had to be introduced *and* then kept.

What is lost is `tmux attach`, the real-TUI handoff that made `ccc` pleasant locally. Two things
replace it, and neither is as good: `/attach <slug>` posts the last N lines of the PTY ring buffer into
the topic, and at the desk `claude --resume <session_id>` in your own terminal reattaches to the
conversation (though not to the running process). **This is a genuine regression against the WSL2
design and is the main thing Windows-native costs on the operational side**, distinct from the sandbox
cost in §6.7. Recorded rather than glossed.

Each session gets its own git worktree regardless of which target repo it is registered against - a
worktree-per-session policy this design adopts on its own, not merely because SeoWrite's `CLAUDE.md`
already required it there: `git worktree add <worktree-root>\<slug> -b claude/<slug>-<id>`. Parallel
sessions sharing a tree have already caused problems in SeoWrite specifically, and running several of
them from a phone across any registered repo makes that failure mode much more likely, not less.

### 2.4 Session launch: registration, identity and the three dialogs

```ts
pty.spawn("claude.cmd", [
  "--dangerously-load-development-channels", "server:aibridge",
  "--model",    "<sonnet|opus|haiku>",
  "--settings", `${STATE}\\sessions\\<slug>\\settings.json`,
], {
  cwd:  WORKTREE,
  env:  { ...process.env, AIBRIDGE_SLUG: "<slug>", AIBRIDGE_TOPIC: "<topic_id>" },
  name: "xterm-256color", cols: 120, rows: 40,
})
```

**The flag is verified to exist.** On 2026-08-02, against the pinned client **2.1.220**,
`--dangerously-load-development-channels` and `--channels` are both **absent from `claude --help`** but
**recognised by the argument parser**, which reports `option '--dangerously-load-development-channels
<servers...>' argument missing`. So the flag is hidden rather than retired, and it is variadic, matching
the documented `server:<name>` form. This was worth checking before anything else: the whole
custom-channel approach (decision 4) rests on it, and a rename would have been discovered in Phase 1
otherwise. Re-run this two-second check on every version bump (§10.1).

**Model routing.** `--model` is passed per session, defaulting to **sonnet** and overridable at `/new`
(§4.2). The CLI flag is used rather than the `model` key in the generated settings file, because that
key is documented as one of the few read once at session start with restart semantics, and a flag has
no such ambiguity. On a Max 5x plan this default is the single largest lever on burn rate, so §10.5
treats it as a budget decision rather than a quality one.

**Registration - CORRECTED 2026-08-03, this was wrong.** v0.10.0 and earlier claimed the channel could
be registered **user-level in `~/.claude.json`** to dodge the `.mcp.json` consent dialog. Measured live
against **2.1.220** during Stage 7: a server registered only in `~/.claude.json`'s
`projects[canonicalPath].mcpServers` produces Claude Code's own startup banner claiming
`server:aibridge - no MCP server configured with that name` and the channel server is **never spawned at
all** (confirmed by an empty debug log and no `hello` reaching the Bridge's pipe server). Registering the
identical entry in the worktree's own **`.mcp.json`** instead, and accepting the resulting "New MCP
server found in this project" consent dialog, is what actually makes `--dangerously-load-development-channels`
resolve `server:aibridge` and spawn it. **`--dangerously-load-development-channels` resolves its
`server:<name>` argument against `.mcp.json`, not against `~/.claude.json`'s per-project registration** -
those are two different registries as far as this flag is concerned, even though both work fine for
*ordinary* MCP tool use (confirmed: SeoWrite's `playwright`/`chrome-devtools` entries in `~/.claude.json`
work with no `.mcp.json` at all). This means the per-`/new` consent dialog v0.10.0 tried to avoid is
**unavoidable for a channel specifically**, not just an unproven risk - see §10.1.2 for why this stopped
mattering once channels turned out to be broken regardless.

**Session identity - CORRECTED 2026-08-03, this was wrong.** v0.10.0 and earlier claimed the MCP
subprocess "inherits [`AIBRIDGE_SLUG`] in turn" from the env passed to `pty.spawn`. Measured live: it
does not. Claude Code spawns a registered MCP server as its **own** child process, not as a child of the
`claude.exe` PTY process, so it does not inherit whatever `ptyEnv()` set on the outer process just
because `claude.exe` itself has those variables. Without an explicit `env` on the MCP server's own
registration entry, the channel server throws on its own `AIBRIDGE_SLUG` guard before it ever opens the
pipe - and before its own `log()` helper is even defined, so the crash produces **no debug-log line at
all**, which is what made this so slow to isolate live. The fix is to put `AIBRIDGE_SLUG`/`AIBRIDGE_TOPIC`
directly on the server entry's own `env` key:

```json5
// .mcp.json (per worktree - see the Registration correction above for why this, not ~/.claude.json)
{
  "mcpServers": {
    "aibridge": {
      "command": "C:\\...\\bun.exe",  // resolved via `where bun.exe` - see next paragraph
      "args": ["run", "<abs path to channel-server/src/index.ts>"],
      "env": { "AIBRIDGE_SLUG": "<slug>", "AIBRIDGE_TOPIC": "<topic_id>" }
    }
  }
}
```

**A third, independent bug in the same code path: `command: "bun"` doesn't resolve.** Exactly the same
failure mode §2.4 correction 4 already documents for a bare `claude`/`claude.cmd` - `where bun` matches
nothing, only `where bun.exe` does - and Claude Code's own spawn of a registered MCP server hits the
same resolution gap `node-pty`'s ConPTY agent does. The registration must use `bun.exe`'s absolute path,
resolved once via `where bun.exe` exactly as `resolveClaudeExecutable()` already does for `claude.exe`.
Symptom when this goes unnoticed: identical to the missing-env-var bug above (no debug-log line, no
`hello` at the Bridge) - the two are easy to conflate and both had to be fixed before the channel server
spawned successfully at all.

**The dialogs.** There are up to **five** full-screen prompts between launch and a usable session. The
first-run pair was discovered on 2026-08-02 and is not in any of the documentation:

| Dialog | Trigger | Handling |
|---|---|---|
| Theme picker | First ever run under a given config, before anything else | Pre-seed `theme` in `~/.claude.json`. Blocks *before* the banner, so a session that hits it produces no output at all |
| Fullscreen renderer offer | Same, immediately after | Pre-seed the corresponding key. Decline it: it changes how output renders and the feed parses none of it anyway |
| Development channels warning | `--dangerously-load-development-channels`, **every session** | Unavoidable. The Bridge writes the confirmation to the session's PTY after detecting it (§10.1) |
| New MCP server consent | A server from a project `.mcp.json`, once per project | **No longer avoidable for the channel** (correction above, 2026-08-03): `--dangerously-load-development-channels` needs `.mcp.json`, so this fires on every `/new`. The Bridge answers it the same way it answers the dev-channels warning |
| Workspace trust | A directory Claude Code has not seen before, so every new worktree | Pre-accept via `hasTrustDialogAccepted` (below) |

**Measured 2026-08-02, in a directory with its `~/.claude.json` `projects[]` entry deleted outright:**
no workspace-trust prompt appeared, and no MCP consent prompt appeared. So neither is as reliable a
blocker as v0.5.0 assumed - but note the probe registered its server with `--mcp-config`, which is an
explicit per-launch grant, so it does **not** clear the `.mcp.json` consent path. Keep the user-level
registration and keep the trust pre-accept: both are cheap, and "did not fire once" is not "cannot
fire". The pre-seeded onboarding keys, by contrast, are now a **hard** prerequisite - a fresh config
on a second machine deadlocks at the theme picker with an empty screen.

The related `~/.claude.json` hazard, found while probing: the file held **two entries for the same
project differing only in drive-letter case** (`c:/…` and `C:/…`). The routing table (§4.3) and every
trust write must canonicalise the path, or the Bridge will register a session twice and pre-trust the
wrong entry.

The trust pre-accept is the same mechanism Claude Code writes itself when a human clicks through, and
we are pre-trusting directories we created ourselves seconds earlier. It is still worth pinning the
client version deliberately: the trust dialog has been the subject of two recent bypass advisories
([CVE-2026-40068](https://github.com/advisories/GHSA-q5hj-mxqh-vv77) worktree `commondir` spoofing,
[CVE-2026-33068](https://github.com/anthropics/claude-code/security/advisories/GHSA-mmgp-wc2j-qcv7)
repo-controlled `permissions.defaultMode`), so the surrounding logic is actively changing.

Only the first dialog needs keystroke injection, and there is no pre-accept flag for it. That is a
known gap for autonomous use generally, not something specific to this design
([#52501](https://github.com/anthropics/claude-code/issues/52501)). See §10.1 for why it is the plan's
largest external risk.

### 2.5 The socket protocol

Three components, two of them short-lived and one of them restartable, all talking over a local IPC
endpoint. Earlier passes referred to this socket repeatedly without ever saying what goes over it,
which left the most restart-sensitive part of the system unspecified.

**The endpoint is a named pipe on Windows**, `\\.\pipe\aibridge`, and a unix socket at
`$XDG_RUNTIME_DIR/aibridge.sock` if the fleet later moves to WSL2 (§7.6). Node's `net` module abstracts
both behind the same `listen(path)` / `connect(path)` API, so this is a one-line platform switch and
**no protocol difference**, which is why the rest of this section is written once. Two Windows-specific
notes that are easy to get wrong: a named pipe has no filesystem permissions, so access is governed by
the pipe's security descriptor and the default (creator plus administrators) is what we want, and pipe
names are not case-sensitive. Do not fall back to a TCP loopback port, which would be reachable by any
local process and by anything that can reach `localhost` through a misconfigured proxy.

**Framing:** newline-delimited JSON, one object per line, UTF-8. Every message carries `v` (protocol
version), `type`, and `slug`. Messages that expect an answer carry `id`; the reply echoes it in
`re`. There is no other correlation mechanism, so a component never has to guess which response is
its own.

| Direction | `type` | Payload | Reply |
|---|---|---|---|
| channel to Bridge | `hello` | `{ pid, role: "channel" }` | `{ topic_id, session_state }` |
| channel to Bridge | `reply` | `{ topic_id, text }` | ack |
| channel to Bridge | `permission_request` | the four relay fields (§6.3) | none; the verdict arrives as a separate push |
| Bridge to channel | `inbound` | `{ content, meta }` | none |
| Bridge to channel | `verdict` | `{ request_id, behavior }` | none |
| hook to Bridge | `hello` | `{ pid, role: "hook", event }` | none |
| hook to Bridge | `event` | the hook payload, trimmed | none for async hooks |
| hook to Bridge | `ask` | `{ questions }` for `AskUserQuestion` | `{ answers }`, and this one blocks |
| Bridge to hook | `answer` | `{ answers }` or `{ cancel: true }` | none |

**Reconnect is the part that actually matters.** The Bridge is restartable by design (§7.2), and its
clients are not: a channel server lives as long as its `claude` process,
so it will outlive several Bridge restarts over a long session. Therefore:

- Clients reconnect with exponential backoff capped at 5s, and re-send `hello` on every reconnect. The
  Bridge treats `hello` as idempotent re-registration, not as a new session.
- A channel server **queues outbound messages while disconnected**, bounded at 100 and dropping oldest
  first. Losing a feed frame is fine; losing a `reply` is a visibly lost answer, so `reply` and
  `permission_request` are queued ahead of everything else.
- A **blocked** hook (`ask`) that loses the socket keeps waiting rather than failing, because its
  timeout (§6.4) is the correct backstop and a Bridge restart mid-question is exactly the case where
  the operator should still get to answer.
- The Bridge rebuilds pending-prompt state from `hello` responses plus the SQLite table, never from
  memory alone. A permission prompt outstanding across a restart is re-posted or expired (§6.5), not
  silently forgotten.

**Version skew** is real here, because a long-lived session keeps running an old channel server after
the Bridge is upgraded. On a `v` mismatch the Bridge accepts the connection, logs once, and refuses
only the message types it does not recognise. Refusing the whole connection would kill working
sessions to enforce tidiness.

---

## 3. The channel server

### 3.1 Capability declaration

```ts
const mcp = new Server(
  { name: 'aibridge', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},             // registers the inbound notification listener
        'claude/channel/permission': {},  // opts in to permission relay
      },
      tools: {},                          // enables the reply tool
    },
    instructions: [
      'Messages from the operator arrive as <channel source="aibridge" topic_id="..." msg_id="...">.',
      'To answer the operator, call the reply tool and pass back the topic_id from the tag.',
      'Reply as you would in a terminal: the operator is reading on a phone, so be brief.',
      'Do not narrate tool use in replies; the operator already sees a live activity feed.',
    ].join(' '),
  },
)
```

The last instruction line matters more than it looks. Without it Claude tends to write "I'll now read
the config file and then update the handler", which duplicates the feed and doubles the message volume
against a rate-limit budget that §5.4 shows is already tight.

### 3.2 Inbound: Telegram to Claude

The Bridge pushes a routed message down the socket; the channel server emits it:

```ts
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: text,
    meta: { topic_id: String(topicId), msg_id: String(messageId), from: senderDisplayName },
  },
})
```

**Meta key constraint:** keys must be `[A-Za-z0-9_]` only. Keys containing hyphens are *silently
dropped*, with no error. So `topic-id` would vanish and Claude would have nothing to reply to. Every
meta key in this system is snake_case, and §9 scenarios 1 and 2 test exactly this. Verified
2026-08-02: snake_case keys arrive intact as tag attributes.

**`source` is reserved - never put it in `meta`.** Claude Code sets `source` automatically from the
server's configured name. A probe that also passed `source` in `meta` produced
`<channel source="aibridgesit" source="aibridgesit" routing_id="zz1" …>`, with the attribute emitted twice.
Nothing broke, but it is malformed and it is trivially avoidable.

**Delivery is fire-and-forget.** `await mcp.notification()` resolves when the bytes hit the transport,
not when Claude has seen them. If the session was not started with the development-channels flag, or
org policy blocks channels, events are dropped **silently with no error returned to the server**. The
Bridge therefore treats "message pushed" as unconfirmed until it observes a resulting hook event or a
`reply` call, and surfaces a "session may not be receiving messages" warning in the topic after 60s of
silence following an inbound push.

**Coalescing:** if several notifications arrive while Claude is mid-turn, Claude Code delivers them
together. This is desirable here (rapid-fire phone messages become one turn) and no work is needed,
but the operator should know that sending three messages in a row produces one response, not three.

Measured 2026-08-02, and better than the docs promise: events do **not** have to wait for the next
turn. Of 20 pushed events, one was in the initial context, sixteen were injected *mid-turn while
Claude was working* (batched, as system notifications), and three landed in the user-turn slot. Claude
also acted on the first event with no user turn at all. A message from the phone reaches a session
that is already busy, which is the premise §5.2 rests on.

**A reply is not an acknowledgement.** In the same run Claude called the `reply` tool for **one** of
the 20 events, then recited all 20 verbatim when asked. Silence means "read and not worth answering"
far more often than it means "lost". So the 60s warning above must be driven by *any* hook activity in
the session, never by absence of a `reply`, or it will cry wolf constantly. Inbound events carry a
monotonic `seq` in `meta` so the operator can ask Claude what it received and get a checkable answer.

### 3.3 Outbound: the `reply` tool

Standard MCP tool, `{ topic_id: string, text: string }`. The handler forwards to the Bridge and returns
`{ content: [{ type: 'text', text: 'sent' }] }`.

Note the ordering trap: **the first `reply` call in a session triggers its own permission prompt**, for
the tool `mcp__aibridge__reply`. If that prompt is not pre-approved, the very first thing the operator sees
in Telegram is a permission request for the mechanism that delivers permission requests. It works (the
relay path is independent of the reply path) but it is confusing. Pre-approve `mcp__aibridge__reply` in the
per-session settings baseline (§6.2).

### 3.4 Voice input (added 0.42.0)

The operator can record a voice note in Telegram instead of typing. The Bot API exposes no
transcription of its own, so this is a Bridge-owned pipeline: `getFile`/`downloadFile` fetch the raw
Ogg/Opus bytes, `ffmpeg` converts to 16kHz mono WAV, and a Bridge-supervised, self-hosted
**whisper.cpp** `whisper-server` transcribes it - chosen over a cloud API specifically so no audio
leaves the machine. It's one long-lived process reusing its loaded model (supervised like the PTY,
restart-on-crash, no restart on deliberate shutdown) rather than one spawned per note, and its model
is switchable live via `/voice` with no restart needed; the default (`small`, every logical core) was
picked after a live latency benchmark (medium model: ~13-16s vs. small: ~3.7s for an 8s clip).

Because transcription accuracy varies sharply by language - and this needs to handle English,
Russian, Ukrainian and Azerbaijani reliably - a transcript is never dispatched to the session
directly. It's posted back as its own card (`🎤 <transcript text>` under a ✅ Send / 🔁 Re-record /
✏️ I'll type instead keyboard, `voice-confirm.ts`), and only a Send tap feeds it into
`dispatchInboundMessage`, the same path a typed message takes; that confirmation step is itself
independently skippable per session (`/voice confirm off`, §3.5). `VOICE_ENABLED` (`.env`) defaults to
on, but `startWhisperServer` checks for the binary/model first and no-ops with a warning rather than
retry-looping forever on a machine where `scripts/setup-windows.ps1`'s voice step hasn't run yet.

### 3.5 Natural-language command routing (added 0.60.0, extended 0.61.0, 0.62.0)

Free text (typed, or a voice transcript re-entering `dispatchInboundMessage` via §3.4's own Send
button) that isn't already an exact `/command` gets one forced-structured-output classification call
before falling through to "unrecognised control-topic command" / forward-to-Claude. Covers the fleet
commands (`/new`, `/kill`, `/rm`, `/model`, `/mode`, `/effort`, `/help`, `/about`, `/commands`,
`/skills`, `/compact`, `/clear`, etc.), checked against a completeness test (`nl-router.test.ts`) that
fails immediately if a future fleet command is added without a matching router kind - deliberately
**not** a repo's own individually-named `.claude/commands`/`.claude/skills` items, which already have
their own discovery path and would balloon per-message token cost if offered as router tools on every
message. A "🤔 Thinking..." placeholder covers the router call's own latency.

**Two backends, selectable per operator instance (§4.1.1) via `/router api|cli`, neither a universal
default.** `"cli"` (the default) shells out to `claude -p --json-schema` against the operator's own
Claude Code subscription - no new billing, but measured at 3.5-5.4s and ~20-30k tokens of fixed
CLI overhead per call, charged against the subscription's own usage budget (§10.5) rather than a
dollar cost. `"api"` calls `@anthropic-ai/sdk` directly with a forced tool choice - ~200-500ms, but
needs a funded `ANTHROPIC_API_KEY` and adds a real per-message dollar cost. The backend always starts
as `"cli"` at boot regardless of whether a key is configured (only `NL_ROUTER_BACKEND=api` in `.env`
changes that default) - provisioning a key must never be the thing that silently starts spending real
money - and `/router api`/`/router cli` switch live, either direction, no restart.

**Destructive matches get a confirm card first, by default.** Broader than §4.2's own confirm-gated
set (`/kill --all`/`/rm --all` only) - single-slug and every `/rm` form of `kill`/`rm`, plus `restart`,
`deploy`, and `repos rm`, since an NL match is inherently less certain than a typed command. The card
(`nl-confirm.ts`) offers Yes/"don't ask again"/Cancel; `/assist [on|off]` is the typeable equivalent,
persisted across restarts in `settings-store.ts`'s `bridge_settings` table (part of the existing
`aibridge.db`, not a second database).

**Voice-note confirmation is an independent toggle (0.62.0), unified under `/voice` (0.106.0).** §3.4's
own Send/Re-record/Type-instead card can be turned off via `/voice confirm [on|off]` (plus a "don't ask
again" row on the card itself) - the model-switch command's original bare/`<model>` shape (§3.4) and
this toggle share one `/voice` route under an explicit `model`/`confirm` sub-category, the same
"category first" shape §4.2's `/auto`/`/default` already use, rather than two separately-named
commands for two voice-input settings. `/voiceconfirm [on|off]` still works as a bare alias (same
"rename, don't break muscle memory" treatment `/rm`/`/remove` got). This toggle is deliberately not
folded into `/assist` despite the similar shape, since one gates whether a *destructive fleet command
matched from NL text* asks first and the other gates whether a *transcribed voice note* is sent at
all. With it off, a transcribed note dispatches immediately but still shows its transcript rather than
a bare "Sent."; an empty/unrecognised transcript always shows the card regardless of the setting.

### 3.6 File browser + search (added 0.65.0; NL routing added 0.66.0)

`/browse [<path>]` and `/find <query>` - a Total-Commander-style way to look inside a session's own
worktree from Telegram without spending a Claude turn on pure navigation. Session-scoped only, hard-
scoped to that session's own worktree root, and Bridge-native (`worktree-fs.ts`) rather than a Claude
tool call: it carries its own independent path-containment (`realpathSync`-checked, so a symlink/
junction escaping the worktree is rejected the same as a `../`) and secret-filename denylist
(`.env`/`.env.*`/`*.pem`/`*.key`/`id_rsa*`/`*.pfx`, hidden from listings and rejected from view/send),
since this feature never goes through Claude's permission engine (§6.2) and needs its own copy of that
judgment call.

Three actions per file, per the operator's explicit choice that GitHub links stay secondary/
best-effort rather than primary - a worktree routinely has uncommitted or unpushed changes GitHub
never sees. **👁 View** (a scrubbed inline excerpt, windowed around a content-search match rather than
truncated from the top) and **📄 Send file** (the exact current bytes, passed through
`secret-scrub.ts` first when the file is text-shaped, since the filename denylist alone doesn't catch
a secret embedded in a plausibly-named file) both read live off disk. **🔗 GitHub** is a real `url`-type
link button, only offered when the file has no uncommitted changes and its current commit is already
pushed. A local file-server-behind-a-tunnel alternative was deliberately scoped out (§11) as
unnecessary surface for what view/send already cover.

Reachable from natural language too (0.66.0): `browse`/`find` are `RouterAction` kinds in
`nl-router.ts` (§3.5), gated behind the same `hasSession` check as `commands`/`skills`, so a
control-topic match reports plainly that file search is session-scoped rather than falling through to
a generic "unrecognised" reply. Search (`searchWorktree`) matches filenames by substring and content
via a spawned `rg`, degrading to filename-only results (flagged, not silent) if `rg` isn't on `PATH` -
capped at 20 hits with an explicit `truncated` flag rather than a silent drop.

---

### 3.7 Diff review via GitHub compare link (added 0.73.0)

`/diff` - a mobile-friendly way to review a session's pending (uncommitted) changes, since asking
Claude to paste `git diff` output back as a chat bubble is unreadable on a phone (§5.5 already sends
oversized text as a document; a diff needs review, not just delivery). Session-scoped, Bridge-native
(`diff-review.ts`), same "own scoping, never through Claude's permission engine" posture as §3.6.

Pushes the pending diff - captured via `git stash create`, so the working tree/index are never
touched, and untracked files are excluded and instead named separately with a pointer to `/browse` -
to a throwaway `aibridge-review/<slug>-head` branch (real `refs/heads/*`, not a custom namespace,
since GitHub's compare page 404s on anything else) and replies with a native `/compare/base...head`
link: a repo page, not a PR object, so private-repo permissions apply to it like any other page.
Rejected alternatives: a secret Gist (link-visible to anyone regardless of the repo's own privacy); a
self-hosted diff viewer behind a tunnel (reopens the tunnel decision §3.6/§11 already deferred); a
Google Drive upload (an unnecessary render-then-upload step). The base ref is whatever already-pushed
branch `findRemoteBranchContaining` (shared with §3.6) finds `HEAD` reachable from, falling back to a
throwaway `-base` branch only when nothing has been pushed yet.

Falls back to a scrubbed `.diff` document (§5.5's precedent) if there's no `github.com` remote or the
push fails - a degrade, never an error surfaced as a failure. The throwaway branch(es) are overwritten
on every call rather than accumulating, and best-effort deleted alongside the worktree on `/kill`/
`/rm`. One accepted, undefended risk: a repo that already has a real branch literally named
`aibridge-review/<slug>-head`/`-base` gets that branch force-overwritten.

---

## 4. Session and topic lifecycle

### 4.1 Prerequisites

One Telegram **supergroup with Topics enabled**, with the bot added as an administrator holding
`can_manage_topics`. Everything lives in this one group; there is no second chat.

Topic 1 (the implicit "General" topic) is the **control topic**: it holds the fleet commands and the
session index, and never hosts a session.

**`channelsEnabled: true` on the claude.ai organisation.** Not optional and not local: on Team and
Enterprise, channels are blocked until an Owner enables them at **claude.ai -> Admin settings ->
Claude Code -> Channels**. Without it the whole system connects cleanly and delivers nothing, with no
per-message error - current docs describe a startup-time banner nudging an admin to enable it, but
per-event delivery during an already-running session still fails silently, which is why §10.1.1's own
liveness probe remains necessary rather than a one-time setup step. Enabled for Devitgroup Ltd on
2026-08-02. See §10.1.1 for why this stays a live risk regardless.

**Pre-seeded onboarding keys in `~/.claude.json`** (theme, fullscreen renderer). A fresh config
deadlocks at the theme picker before printing anything (§2.4).

### 4.1.1 One operator, one instance - a second person means a second, fully independent instance

**aibridge is single-operator software.** It is scoped to one person controlling their own machine
from their own phone; it is explicitly **not** multi-tenant (§11). If a second person - a colleague,
a second developer on a shared project - also wants Telegram control, the answer is never "add them to
the sender allowlist." Each operator runs their **own** Bridge, on their **own** machine, against
their **own** clones and worktrees, with their **own** supergroup and their **own** pair of bot
tokens. There is no shared Bridge and no shared fleet, and `repos.toml` may or may not list the same
projects across two such instances - that is incidental, not something this plan coordinates.

This is a direct consequence of §8.1's threat model, not a separate policy: "anyone who can send a
message the Bridge accepts can execute arbitrary code on the operator's machine" is scoped to one
machine on purpose. Routing a second person's messages into the same Bridge - even cleanly, via the
sender allowlist that already exists for exactly this kind of gating - would mean their tool calls
execute on the *first* operator's machine, with the first operator's repo access and credentials.
That is a materially bigger blast radius than the plan's security model (§8.2, §8.3) was built to
carry, and expanding it is a deliberate decision for later, not a default.

**Worked example, from the first two instances actually run (2026-08-02).** Devitgroup Ltd has two
developers who both wanted control over the SeoWrite repo from their phones. Each runs their own
instance per the rule above; the only thing that made this cheap to reason about is that `repos.toml`
just lists the same project twice, once per machine. Concretely: the second developer's instance
inherited `channelsEnabled` for free (both are in the same claude.ai org, see below), was on a
different Claude subscription tier, and needed the same one-time Telegram platform steps repeated by
hand. The details below are that case study, kept because they show exactly which per-operator costs
are real and which items travel for free - not because the numbers are universal.

The practical cost of this choice: **two of the three §4.1 prerequisites are per-operator, not
per-project**, and cannot be shortcut. The Telegram setup (supergroup, Topics, bot admin, both
tokens) is Telegram platform actions a bot is deliberately forbidden from doing to itself or for
you:

- **Bot tokens only come from `@BotFather`**, and `@BotFather` is a conversation, not an API call -
  there is no REST endpoint that mints a token.
- **A bot cannot create a supergroup, and cannot enable Topics on one.** Both are Bot API
  limitations, not gaps in this plan: creating groups and toggling forum mode are client/user
  actions.
- **A bot cannot promote itself to admin.** `can_manage_topics` has to be granted by an existing
  human admin of the group; the Bot API has no call for a bot to grant itself rights, by design.

All three are technically scriptable against a real user account over MTProto (Telethon in Python,
GramJS in Node) rather than the Bot API, since a user account can create groups, toggle forum mode,
promote members, and even drive `@BotFather`'s conversation. Not worth it here: that trades a
five-minute one-time manual setup for a standing user-account credential (`api_id`/`api_hash` from
my.telegram.org) with no ongoing use once the group exists. So does pre-seeding the onboarding keys
(§4.1's third item): a per-machine `~/.claude.json` edit, done once per operator.

**The third §4.1 item, `channelsEnabled`, is the exception - it is not per-operator.** It is an
org-wide switch on the claude.ai organisation (§10.1.1), not a per-user setting. In the worked example,
Devitgroup Ltd's second developer is a member of the same claude.ai organisation the first enabled it
on, so their instance inherits it already satisfied - nothing to ask an Owner for a second time. Had
they been on a separate, non-Team/Enterprise account instead, the same conclusion would follow for the
opposite reason: the docs scope the gate to Team and Enterprise, so an unaffiliated personal account
is never blocked by it at all. Either way, a second operator never needs to touch this item; only the
Telegram setup and the onboarding keys do.

**§10.5's concurrency and spend numbers do not carry over between operators.** That section's
weighted-concurrency budget (cap of 4 units) and burn-rate threshold are arithmetic built specifically
around one subscription tier and one `/new` default model - they describe a single instance, not a
policy. In the worked example, the second developer was on a **Standard, non-Premium** tier while the
first was on **Max 5x**, so each needed their own pass through §10.5's method before running a fleet;
reusing one instance's "4 units, Opus=2/Sonnet=1/Haiku=0.5" figures as-is on the other would misprice
its plan. This does not block Phases 1-4, which run one session at a time, but it is an open item to
close before any instance scales to a fleet.

**The P-4 protocol probe does not need to be repeated per operator.** Its findings (§12, P-4
items 0-7) are properties of the Claude Code client at a given version, not of the machine that ran
it - a second instance on the same pinned client version inherits them and only needs to carry out
the per-machine *actions* the probe surfaced (pre-seed the onboarding keys, keep `channelsEnabled` in
mind), not re-run the sitting harness in `scratchpad/sitting/`. Re-run it only on a version bump
(as §10.1 already requires), not per operator.

Nothing else in the plan changes for this. Two independent instances are two independent
deployments of the same design; no component here needs multi-tenancy, and the routing table,
permission relay and feed renderer are all already scoped to a single Bridge process.

### 4.2 Commands (control topic)

| Command | Effect |
|---|---|
| `/about` | Friendly capability overview (control topic or a session's own topic) with a "more info" button per fiddly feature (bulk `/rm`, mode/effort, permission buttons, autostart, repo commands/skills) - the on-ramp `/help` deliberately isn't (§4.2, added 2026-08-05) |
| `/new [--opus\|--haiku] <repo> <prompt>` | Create worktree, create topic, launch session, send prompt as first message. Sonnet unless overridden |
| `/ls` | List live sessions: slug, state, worktree, branch, age, last activity, model, session cost and tokens (§5.7). A `working` or `awaiting_input` row gets an extra detail line - the current tool/activity and elapsed turn time for `working` (from `feed-state.ts`'s activity log), or what it's specifically waiting on for `awaiting_input` (the pending permission's tool+preview, the pending question's text, or a generic "reply" if neither registry has an entry) - built as a read-only join over the same sources the session's own turn card already reads, not a new tracked state. Added 2026-08-05 |
| `/budget` | Rolling 5-hour spend across the fleet, per-session breakdown, and the cap (§10.5) |
| `/kill <slug>` | SIGTERM the session, close the topic, leave the worktree in place. `/kill --all` is confirm-gated (§4.2's fleet-confirm card) unless `--force`/`-force`/`-f` is also given (added 2026-08-08), which skips the card and acts immediately |
| `/rm <slug>` | As `/kill`, plus remove the worktree and delete the topic. `/rm --all` is confirm-gated the same way and takes the same `--force` escape hatch; `/rm --dead`/`/rm --prefix <text>` never confirm in the first place (dead rows only), so `--force` there is a harmless no-op |
| `/attach <slug>` | Post the tail of the session's PTY ring buffer, plus the `claude --resume <session_id>` command for local pickup (§2.3) |
| `/cmd <name> [args]` | Run a repo slash command by proxy. See below: this is a shim, not a passthrough |
| `/model <sonnet\|opus\|haiku\|fable>` | Switch the current session's model live, mid-conversation. Session-scoped only, same convention as a bare `/kill` (§4.2.1) |
| `/mode <manual\|acceptEdits\|plan\|auto>` | Switch the current session's permission mode live. Session-scoped only, same convention as a bare `/kill` (§4.2.2) |
| `/effort <low\|medium\|high\|xhigh\|max>` | Switch the current session's reasoning effort live, mid-conversation. Session-scoped only (§4.2.3) |
| `/pause <slug>` | Stop pushing feed updates for that topic (replies and prompts still flow) |
| `/stop [<slug>]` | Interrupt the current turn without killing the session - writes a bare Escape (`\x1b`, no trailing `\r`) straight to the session's PTY, the same keystroke the Claude Code TUI's own "stop" button/Esc-while-working binding sends. Session-scoped only, same bare-from-its-own-topic convention as `/kill`/`/pause`. No ack comes back (same as `/model`/`/mode`); the `working -> idle` transition, if any, still comes from the real `Stop`/`StopFailure` hook, not from this write. Also clears any still-pending `permissionRegistry`/`askRegistry` entry for that session, editing its Telegram card in place (stripping the keyboard, same §6.5 "never leave a stale button that looks tappable" mechanism the TTL sweep and an ask's own cancel-ceiling already use) - live-verified 2026-08-09, both a real pending Bash permission (card edited to `🛑 interrupted: Bash (session was stopped before this was answered)`) and a real pending `AskUserQuestion` (card edited to `🛑 interrupted - session was stopped before this was answered`, Allow/Deny and Red/Blue-style option buttons both gone), in each case followed by a normal reply proving the session stayed fully alive. Without this, `/ls` kept misreporting `awaiting_input` and the old buttons stayed up as a guaranteed-stale no-op; no verdict is sent back over the pipe the way the TTL paths do, since Claude's own interrupt handling already unblocks the hook client that was waiting on the answer - this is a display-only fix. The confirmation only mentions clearing when something was actually pending. Implements §5.3's `[ stop ]` card button, drawn in the original mockup but left unbuilt until now (added 2026-08-08) |
| `/restart` | Fleet-scoped, control topic only. Self-respawns the Bridge process to pick up a code change. Kills every live session with it (§4.5); Phase 5 scope, see §4.5.1 |
| `/settings` | Fleet-scoped, control topic only. Read-only card: registered repos from `repos.toml` and the current/cap weighted concurrency budget (§10.5). Phase 6a scope |
| `/repos [list\|add <name> [<path>\|<git-url>] [--base <b>] [--model <m>]\|rm <name>]` | Fleet-scoped, control topic only. Mutates §7.5's registry from Telegram instead of only by hand-editing `repos.toml` - `add` validates the name, rejects a duplicate, and checks the path exists and looks like a git repo/worktree (a `.git` entry present) before writing; `rm` only edits the file, any existing worktree/session for that repo is left alone. `reposRegistry` is reloaded in place after either, so the very next `/new` sees the change with no Bridge restart. `add`'s path argument is optional and/or a clone source: if every already-registered repo shares one parent folder, an omitted path is inferred as `<that parent>\<name>`; if the argument is a git URL instead of a local path, it's `git clone`d into that same inferred (or `--base`-branched) destination before registering - `git clone`'s own stderr surfaces verbatim on failure, and nothing is written to `repos.toml` unless the clone succeeds. Added 2026-08-05; path inference/clone-by-URL added 2026-08-05 |
| `/autostart [status\|install\|uninstall]` | Fleet-scoped, control topic only. Manages the §7.2 Task Scheduler entry via `schtasks.exe` - `install` registers a logon-trigger task under the operator's own account (no admin rights needed); no argument defaults to `status`. Phase 6a scope |

Session-scoped commands live in the session's own topic, so `/kill` with no argument inside a session
topic kills that session. Any non-command text in a session topic is an inbound message to that session.

**Slash commands do not cross the channel boundary.** This is worth stating because the original brief
asked to "run commands" from Telegram. A channel message arrives as a `<channel>` tag in Claude's
*context*; it is not typed into the CLI, so `/review:pre-push` sent from a phone is just text that
Claude reads. Nothing in the protocol turns it into a command invocation, and the TUI is the only
place slash commands exist.

The shim closes most of the gap without pretending otherwise. `/cmd review:pre-push` makes the Bridge
push an ordinary message that names the command's own definition file:

> Read `.claude/commands/review/pre-push.md` and carry out the workflow it defines, with arguments: …

This works because in a Claude Code project a command *is* a markdown prompt file, so following it by hand is
what the CLI does anyway. Two honest caveats: argument substitution (`$ARGUMENTS`) is textual rather
than performed by the framework, and anything the command relies on the CLI doing for it, such as
frontmatter-declared `allowed-tools`, is not applied. Skills need no shim at all: Claude invokes those
through the `Skill` tool, so "run the ux-audit skill" already works from a phone.

The Bridge validates `<name>` against the files actually present under `.claude/commands/`, so a typo
returns a list rather than a confusing instruction to read a file that does not exist.

### 4.2.1 `/model`: why this needs a keystroke, not a shim

`/new --opus|--haiku` (§4.2) fixes a session's model at launch, but there was no way to change it once
running - the operator watched a `Ruminating…` turn burn Opus-rate tokens on something Haiku would have
handled, with no lever except `/kill` and a fresh `/new`. `/model <name>` closes that.

**It cannot be built as a `/cmd`-style shim.** `/cmd`'s trick works because a repo command *is* a
markdown file Claude reads and follows by hand - there is no equivalent file for `/model`, `/effort`, or
any other CLI-native slash command. Wrapping `/model opus` in a `<channel>` tag the way ordinary inbound
text is wrapped (§4.2's "slash commands do not cross the channel boundary") would just hand Claude the
literal string `<channel ...>/model opus</channel>` as conversational content - the TUI never sees a
line starting with `/`, so nothing switches. `/model` only exists as something *typed at the prompt*,
which means the Bridge has to type it.

**Mechanism: the same raw-keystroke write Phase 1 already uses as a manual escape hatch, made a real
feature.** §10.1's dev-control port exists today only so an operator can hand-answer the one-time
dev-channels dialog; `/model <name>` is that same `ptyProcess.write(...)` call, generalised and put
behind a validated command instead of a loopback HTTP debug endpoint. On receipt the Bridge writes the
literal text directly to the session's PTY, bypassing `renderChannelTag` entirely, followed by `\r`:
`/model opus\r`. This is exactly what an operator's own fingers would type at the terminal.

**No ack comes back over the pipe.** A model switch does not fire a hook and produces no `reply` tool
call - the channel genuinely cannot observe that it happened (the same split §2's "why the split matters
for the feed" already names). So the Bridge posts its own confirmation immediately after the write
("Switched test-session to opus") rather than waiting for evidence the switch landed; a bad `<name>` is
rejected before it ever reaches the PTY; a good one it takes on faith, same as `/attach`'s PTY-tail is a
best-effort read rather than a verified state.

### 4.2.2 `/mode`: the same primitive, plus a state-tracking problem `/model` doesn't have

The permission-mode picker (Manual / Edit automatically / Plan / Auto) has no typed slash command at
all - it is reached only by **Shift+Tab cycling** at the prompt, already the plan's own words for it in
§10.0: "the shift+tab manual-mode toggle" was one of the three keystroke primitives proven live during
the 2026-08-02/03 sitting. So `/mode <name>` reuses exactly §4.2.1's write-to-the-PTY mechanism, sending
the raw back-tab escape (`\x1b[Z`, standard xterm Shift+Tab) instead of a typed line.

**The problem `/model` didn't have: cycling is relative, not absolute.** `/model opus\r` names its
target directly. Shift+Tab only says "next" - reaching `plan` from `manual` means knowing where in the
cycle the session currently sits and pressing the right number of times, and the protocol gives the
Bridge no way to read that back (the same "no ack" gap §4.2.1 already names, compounded: a wrong guess
here doesn't just fail silently, it silently lands on the *wrong mode*, which is worse for something
gating tool execution than for a cosmetic label change).

**Mitigation: the Bridge tracks mode per session in the routing table, seeded from a known baseline.**
Phase 1 spawns every session with no `--permission-mode` flag, which this sitting confirmed live
defaults to `manual` - so `manual` is the tracked starting value for every session, updated optimistically
after each `/mode` write (current index + presses, mod the cycle length). Two things follow from
"optimistically": first, if the operator also cycles modes by hand at the keyboard between remote
commands, the Bridge's tracked value drifts from reality with nothing to detect it - worth a `/ls`
column once §5.7's telemetry exists, not blocking for Phase 5. Second, the cycle order below was
inferred from the picker's own listed order and is now **verified**, the same way the dev-channels and
MCP-consent keystrokes were: four `\x1b[Z` writes against the live Phase 1 session, reading the mode
label off the status line after each one (2026-08-03) -

```
manual -> acceptEdits -> plan -> auto -> (back to manual)
```

- confirmed exactly, including the fourth press wrapping cleanly back to `manual`.

`/mode auto`, sent from `manual`, is therefore three Shift+Tab writes, not one.

### 4.2.3 `/effort`: same primitive as `/model`, plus a confirmation dialog neither of the other two has

`/effort <low|medium|high|xhigh|max>` reuses §4.2.1's write-to-the-PTY mechanism (a direct-argument
command, not a relative cycle like `/mode`) - but live-verifying it (2026-08-03, same test-session used
for Phase 2's own spikes) surfaced a real difference from `/model`: `/effort <level>` opens a "Change
effort level? 1. Yes, switch  2. No, go back" confirmation dialog with "Yes" pre-selected, rather than
applying immediately. `/model` and `/mode` never do this.

**A second `\r` is required, and it cannot be sent in the same tick as the first.** Writing
`/effort high\r\r` as three back-to-back synchronous writes left the dialog open and the level
unchanged - confirmed live, the same class of PTY-timing hazard §10.1.2 already names for a single
write carrying text plus a trailing `\r` (the terminal hadn't rendered the dialog yet when the second
`\r` arrived, so it was dropped), just one step further down the same interaction. The fix is a short
delay (200ms) before the confirming `\r`. One asymmetry worth naming: if the session is already at the
requested level, no dialog appears at all and the delayed `\r` lands on an empty prompt instead - this
was also verified live to be a harmless no-op, not a spurious blank turn.

**Bare `/model`, `/mode` or `/effort` (no argument) now shows a button per option** rather than falling
through to the ordinary inbound-message path - discovered live that a bare `/effort` with no target to
act on doesn't match the command parser at all, so it silently became a plain chat message and Claude
answered it conversationally ("`/effort` isn't a recognized built-in slash command...") instead of
anything switching. The button list closes that gap for all three commands, not just `/effort`, reusing
the same tap -> resolve -> apply path scenario 30's `perm:` keyboard already established, under a
`model:`/`mode:`/`effort:` callback_data namespace.

### 4.3 The routing table

SQLite at `$STATE/aibridge.db`, because the mapping has to survive Bridge restarts and because concurrent
reads from the socket handlers want real transactions rather than a JSON file and a mutex.

```sql
CREATE TABLE sessions (
  slug           TEXT PRIMARY KEY,      -- stable, human-readable, derived from the first prompt
  topic_id       INTEGER NOT NULL UNIQUE,
  session_id     TEXT UNIQUE,           -- Claude Code session_id, NULL until SessionStart fires
  worktree_path  TEXT NOT NULL,
  branch         TEXT NOT NULL,
  pty_pid        INTEGER NOT NULL,       -- OS pid of the claude process on its PTY
  state          TEXT NOT NULL,         -- starting|idle|working|awaiting_input|dead
  turn_card_msg  INTEGER,               -- message_id currently being edited
  created_utc    TEXT NOT NULL,
  last_event_utc TEXT NOT NULL
);
```

`slug` is the primary key rather than `session_id` precisely because `session_id` is unknown at topic
creation time and changes on `--resume`. Everything external addresses a session by slug.

**`state` transitions.** No transition is implicit; the table below is exhaustive, including the two
back-to-baseline cases that are easiest to leave out:

| From | To | Trigger |
|---|---|---|
| - | `starting` | `/new`, or an orphaned process adopted on Bridge restart (§4.5) |
| `starting` | `idle` | `SessionStart` hook fires |
| `idle` | `working` | `UserPromptSubmit`, or an inbound channel push with no prior turn (§3.2) |
| `working` | `awaiting_input` | A blocking `AskUserQuestion` hook, or a relayed permission prompt outstanding (§6) |
| `awaiting_input` | `working` | The question or permission prompt resolves, from any surface (§6.5) |
| `working` | `idle` | `Stop` / `StopFailure` hook |
| any | `dead` | `SessionEnd`, a `claude_code.api_error` quota stop (§10.5), or reconciliation finding the process gone (§4.5) |
| `dead` | `starting` | Never automatically - slugs are unique (§9 scenario 27), so a dead row is a terminal state until `/rm` |

A message sent to a topic whose row is `dead` is acknowledged with "this session has ended" rather than
queued or silently dropped, which is the one case the table above does not cover on its own.

### 4.4 Naming

Topics are created immediately at `/new` with a provisional title derived from the prompt (first 5
words, truncated to Telegram's 128-char topic-name cap). That title is never changed automatically
afterwards - the rename-once-on-first-reply upgrade this section originally specified was removed
2026-08-09 at operator request: a topic name, once set, should only change when the operator renames
it themselves (Telegram's own topic-settings UI), never from reply content. `sessionStore`'s `renamed`
column and `setRenamed` are unused leftovers from that mechanism, kept rather than migrated out for a
now-dead flag.

**Retired (0.74.0): the second trigger this section originally also named** - "or when a `SessionStart`
hook reports a `sessionTitle`" - rested on a premise checked directly against Claude Code's own hooks
reference and found false. `sessionTitle` is real, but it is a field a `SessionStart` hook's own JSON
*output* may set (to tell Claude Code what to display as the session's title in its own UI) - it is not
a field present anywhere in a `SessionStart` hook's *input* payload for the Bridge to read. There is
nothing to trigger a rename off here: the documented `SessionStart` input fields are `session_id`,
`prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `effort`, `hook_event_name`, and (not
guaranteed) `model` - no title-shaped field among them. The reply-triggered path above is the entire
implementation of this section; no second path is missing, and none should be built.

### 4.5 Restart recovery and orphan reconciliation

On Bridge start, reconcile three sources of truth that can disagree: the SQLite table, the live
processes (by `pty_pid`, verified by image name so a recycled pid is not mistaken for a session), and
the Telegram topic list.

| Situation | Action |
|---|---|
| Row exists, process alive | Re-adopt. Post "bridge restarted, session still running" to the topic. **The PTY handle is gone even though the process is not** - see below |
| Row exists, process gone | Attempt `claude --resume <session_id>` on a fresh PTY. On failure, mark `dead` and post a notice with the worktree path so work is not lost |
| Row exists, topic deleted in Telegram | Mark `dead`, leave the worktree. Notify the control topic (the session's own topic no longer exists to post into). Log |
| Process alive, no row | Orphan from a crashed Bridge mid-`/new`. Report to the control topic for manual review. Log |
| Row `state = awaiting_input` | The pending prompt is gone (§6.5). Post an explicit "the pending question was lost, please re-ask" rather than leaving a dead button |

**MEASURED 2026-08-03 (scenario 37, Stage 7).** Killed the Bridge process alone via PowerShell
`Stop-Process -Id <bridge_pid> -Force` - explicitly *not* a tree-kill (`TaskStop`-equivalent), to
isolate whether Windows kills children with their parent by default. It does not, in general - but
this specific chain does: with a live session running (`claude.exe`, spawned via `node-pty`, itself
having spawned the `bun.exe` channel server as its own registered-MCP-server child), killing only the
Bridge's `node.exe` process left **zero** survivors. `Get-Process claude`/`Get-Process bun` immediately
after showed neither PID anywhere on the system - not orphaned, not reparented, gone. This resolves the
open question below in the direction the fallback was written for.

This changes the reconciliation table above in a real way, not just a footnote:

- **Row 1 ("process alive") does not occur in practice on this stack.** The distinction the two bullets
  below used to draw - "the process survives but the Bridge loses the PTY view" vs. "the process might
  not survive at all" - collapses, because the process does not survive. Every Bridge restart with a
  live session forces **row 2** ("process gone"): `claude --resume <session_id>` on a fresh PTY is not
  one recovery path among several, it is the *only* one, always, for every session that was running
  when the Bridge died. The `/attach`-degrades-to-`--resume` framing below is moot for the same reason
  - there is nothing PTY-level left to degrade from.
- **Practical consequence for Phase 5's supervisor**: a Bridge crash or restart is not a "graceful
  reconnect" event on this host, it is a "relaunch every live session from its last transcript" event.
  `claude --resume` preserves conversation history (a durable transcript, independent of the PTY that
  hosted it), so no work is lost, but every session pays the cold-start cost above (dev-channels
  dialog, MCP consent, model/worktree re-resolution) on every Bridge restart, not just the first launch.
  Worth factoring into how aggressively Phase 5 restarts the Bridge (e.g. on every deploy) versus how
  disruptive that is to whoever is mid-conversation on Telegram at the time.
- **Rows 3 and 4, as implemented (0.33.0), lean on the same measurement rather than re-verifying it
  per row.** "Topic deleted" no longer says "terminate the process" - the process is already gone by
  the time reconciliation runs, per the measurement above, so there is nothing left to terminate; the
  row is simply marked `dead`. "Process alive, no row" no longer auto-adopts into a fresh topic -
  deciding what session a stray process actually was, and whether restarting it is even wanted, is the
  operator's call, so it's reported to the control topic instead. Both choices mean a process that
  *did* somehow survive (the recycled-pid case row 1's own `readopt` action is kept defensive for) is
  never blindly `kill()`-ed by pid alone - `orphan-scan.ts` deliberately treats a `dead` row's pid as
  no longer "known", so a genuinely-surviving process re-surfaces on the next scan instead of being
  silently trusted forever just because its row says `dead`.
- **The Job Object opt-out fallback below is now the concrete next step, not a contingency.** If
  session survival across Bridge restarts is worth the engineering cost, spawning each `claude` detached
  in its own Job Object configured not to kill on close (Windows' documented mechanism for exactly this)
  is what would need building - not because the measurement was inconclusive, but because the measured
  answer was "no, they don't survive" and that fallback is the only listed way to change that answer.

What did *not* change: the underlying cause is still unconfirmed (Job Object inheritance from ConPTY's
pseudoconsole host, `claude.exe` treating a closed stdin/stdout handle as a disconnect signal and
exiting itself, or something else) - the measurement answers "does it survive" definitively, not "why
not". Not chased further since the practical answer (build the Job Object opt-out, or accept the
cold-start cost) doesn't depend on which mechanism it turns out to be.

Two things get harder than they were under tmux, and both are consequences of §2.3 rather than
oversights - the first is now superseded by the measurement above, kept for the historical reasoning:

- ~~**Re-adoption is partial.**~~ **Superseded above: re-adoption doesn't happen at all, the process is
  gone.** tmux was an independent process holding the terminal, so a restarted supervisor could
  reattach to a live window and resume reading it. A PTY handle belongs to the process that created
  it, so a restarted Bridge would only have been able to see the `claude` process alive but not read
  its output or write to its stdin again - this reasoning was correct as far as it went, but assumed
  the process itself would still be there to have this problem with.
- ~~**Child survival across Bridge death is not assumed.**~~ **Measured above: it does not survive.**
  On Windows a child process is not killed with its parent by default, but the ConPTY pseudoconsole
  host is a separate process in the chain and its teardown behaviour on parent death turned out to
  matter here. The fallback named at the time - spawn each `claude` detached and in its own Job Object
  configured *not* to kill on close - is the documented way to opt out, and is now the concrete
  next step if this behaviour needs to change (see above).

### 4.5.1 `/restart`: an operator-triggered version of the same event

A gap noticed live (2026-08-03): a code change to the Bridge itself needs a process restart to take
effect - it cannot hot-reload the process it is running under (this exact sentence is what the fleet's
own live session said, unprompted, after implementing a feature to itself) - and there was no way to
trigger that from Telegram, only from the desk. `/restart`, sent in the **control topic** (fleet-scoped,
not session-scoped, unlike `/model`/`/mode`), closes that gap.

**Mechanism: self-respawn, not an external supervisor.** The Bridge spawns a detached successor with
its own `process.argv` (`spawn(process.execPath, process.argv.slice(1), { detached: true, stdio:
"ignore" }).unref()`), posts a confirmation, then exits. This deliberately triggers nothing new:
`/restart` is not a special code path, it is an operator-initiated instance of exactly the event §4.5
above already measured (scenario 37) and reconciles for. No extra design is owed to it beyond making it
reachable from a command instead of only from a crash or a manual `Stop-Process`.

**"Back up" confirmation (0.63.0).** The pre-restart message ("Restarting the Bridge now... once it's
back up") had no matching post-restart one - `runStartupReconciliation`'s own two messages
(`reportOrphanProcesses`/`reapRowsWithDeletedTopics`) only post when there's actually something to
report, so a clean restart with nothing to reconcile posted nothing at all, leaving no way to tell "back
up" apart from "still coming up" or "crashed on relaunch" from Telegram alone. Fixed with one
unconditional "✅ Bridge is back up." sent right after `runStartupReconciliation()` completes, every
successful startup (restart or cold), not gated on anything being found.

**The honest Phase 1 caveat, stated plainly rather than glossed:** §4.5's measurement means `/restart`
kills every live session along with the Bridge, and Phase 1 has no persisted `session_id` (that is
Phase 5's SQLite routing table, §12) for the successor to pass to `claude --resume`. So today, `/restart`
does not hot-reload a session's *conversation* - it relaunches fresh, and whatever was mid-turn is gone,
not resumed. This is the same "cold-start cost on every restart" tradeoff §4.5 already flags for the
supervisor's own automatic restarts; `/restart` just makes the operator able to pay that cost
deliberately, on their own schedule, instead of only when something crashes. It becomes non-destructive
once Phase 5's session-id persistence lands, and not before - **`/restart` is therefore Phase 5 scope**,
not a Phase 1 retrofit, same as the supervisor duty it's a manual trigger for.

**Confirm-gated whenever it's actually destructive (operator request, 2026-08-12).** `/restart` used
to respawn on the same message unconditionally, regardless of how many sessions were live - the one
fleet-scoped command with no confirm step of any kind, even though §4.5's own measurement is that it
kills every one of them along with the process. Now `handleRestartCommand` (deploy-lifecycle-
commands.ts) checks `sessionStore.all()` for any row `!== "dead"` first: with none, it restarts
immediately exactly as before (there's nothing to lose); with at least one, it posts the same Yes/
Cancel confirm card `/os shutdown|reboot` already uses - naming each live session and its state -
via its own `RestartConfirmRegistry` (same "own `Map`, own TTL, own `callback_data` namespace" shape
as `OsConfirmRegistry`, kept separate from `fleet-confirm.ts`'s multi-kind registry since this gates
exactly one action). A tap on Cancel finalizes the card and changes nothing; a tap on Yes runs
`executeRestartConfirm`, which finalizes the card in place and then does exactly what the immediate
path always did. This only changes *when* the respawn is confirmed, not the respawn/cold-resume
mechanism itself - the honest Phase 1 caveat above still applies unchanged.

### 4.5.2 Orphaned-topic reconciliation (implemented 0.68.0; live verification found a sharper edge)

A removed session's Telegram topic can outlive its DB row: `removeSessionRow` only `WARN`-logs if
`deleteForumTopic` fails and deletes the row regardless, and the Bot API has no `getForumTopics`-style
listing call at all - a bot only ever learns a `message_thread_id` from a message already received in
that thread, so there's no way to enumerate Telegram's topics and diff them against the DB the way
`/rm`/`/kill`/reconciliation do for rows and processes.

The fix works from inside the orphaned topic instead, where Telegram hands the Bridge the one thing
it's otherwise missing for free on every incoming message: a bare `/rm` sent in a topic that resolves
to no session row now falls back to a confirm-gated orphan-topic delete (`rm-topic`,
`fleet-confirm.ts`) rather than a plain usage error, scoped to "the topic the operator is standing in
right now" since there's still no way to discover *other* orphans without visiting each one. Every
removal path now also reports when `deleteForumTopic` failed, so a fresh orphan is surfaced
immediately rather than found later by eye.

Live verification found this doesn't cover every case: a topic whose thread the Bot API itself
already considers `TOPIC_ID_INVALID` can't be posted into or read from at all, so the Bridge can never
see a `/rm` sent there and this fix can't fire for it - confirmed live, not even `/help` gets a reply.
There are therefore two distinct orphan shapes: one the bot can still reach (a transient
`deleteForumTopic` failure, thread still alive) and this fix cleans up, and one it structurally cannot
reach (the thread itself is already dead to the Bot API) at all. The second is an accepted limitation,
not a gap left to close - the only remaining path is deleting it by hand from the Telegram client
(Delete Topic), via the operator's own MTProto session rather than the bot; building bot-side detection
for it would need the same missing topic-listing call already ruled out above.

---

## 5. The activity feed

### 5.1 Event sources

Hooks, registered in the per-session settings file, each invoking the compiled hook client:

| Hook | Used for |
|---|---|
| `SessionStart` | Bind `session_id` to slug. Post the session header |
| `UserPromptSubmit` | Open a new turn card |
| `PreToolUse` | Feed line "reading X" / "running Y". **Blocking** only for `AskUserQuestion` (§6.4) |
| `PostToolUse` | Resolve the line: success, and for edits the changed-line count |
| `PostToolUseFailure` | Resolve the line as a failure, and surface the error text |
| `PostToolBatch` | Collapse a parallel batch into one line |
| `SubagentStart` / `SubagentStop` | Nest a sub-line, so delegated work is visible but indented |
| `PermissionRequest` | Observer only. Supplies `tool_use_id`, full `tool_input` and `permission_rule_text` for the prompt the relay is raising in parallel (§6.5) |
| `PermissionDenied` | Resolve a relayed prompt that was denied elsewhere |
| `Notification` | Permission and idle notices, as a fallback to the channel relay |
| `Stop` | Close the turn card, set state `idle` |
| `StopFailure` | Close the turn card as errored, surface the API error |
| `SessionEnd` | Mark `dead`, post a closing summary |

Every payload carries `session_id`, so routing is a single indexed lookup, and `AIBRIDGE_SLUG` is in the
environment from birth (§2.4) so even the first event before `SessionStart` lands in the right topic.
All of these except the `AskUserQuestion` matcher are declared `"async": true` so they never add
latency to the agent loop; `PermissionRequest` in particular is async precisely so it stays an
observer and cannot accidentally become the decision-maker (§6.5).

Two hook fields are worth knowing about and are deliberately **not** used. `asyncRewake` wakes Claude
on a background hook's exit code 2, which would let the feed inject text into the session; that is a
prompt-injection surface pointed at our own operator's screen for no gain. And the `Elicitation` /
`ElicitationResult` pair intercepts MCP servers asking the user for input - relevant only once a
session uses an MCP server that elicits, at which point those prompts would otherwise appear on the
terminal and be invisible from the phone. Recorded as a known blind spot rather than solved.

### 5.2 Why hooks and not `stream-json`

`claude -p --output-format stream-json --include-partial-messages` gives strictly more fidelity: token
deltas, thinking blocks, tool inputs and results, and with `--forward-subagent-text` the whole subagent
tree. It is the better data source in isolation.

It is rejected because `-p` is non-interactive, and in `-p` mode **Claude Code disables the tools that
need terminal input, including multiple-choice questions and plan-mode approval**. Requirement 4 is
"answer Claude's questions with buttons", so disabling questions to get a better feed inverts the
priorities. Hooks fire in interactive sessions and cost nothing.

Kept as a documented fallback in §11 if hook fidelity proves insufficient for a specific need.

### 5.3 The turn card

One message per turn, edited in place. Layout:

```
🔨 refactor-billing · working (0:42)

  ✓ Read  src/Billing/InvoiceService.cs
  ✓ Grep  "CreateInvoice"  · 7 files
  ✓ Edit  InvoiceService.cs  +18 −4
  ⠸ Bash  dotnet test

  [ details ]  [ stop ]
```

Rules:

- **Maximum 8 activity lines.** Older lines roll off into a "…and 14 earlier steps" counter. The full
  log is retained by the Bridge and served by the `details` button as a separate message, so nothing is
  lost, only hidden.
- **Tool arguments are truncated to 80 chars** and rendered as pre-formatted text, never as markup.
  These strings can contain arbitrary file content (§8.2).
- **Claude's own prose is not in the card.** It arrives via the `reply` tool as its own message, so it
  is quotable and searchable. The card is machinery; the reply is conversation.
- When the turn ends the card is edited once more to its final state and the spinner is replaced by a
  duration. It is never deleted.

### 5.4 Rate limits: the real budget

This is the constraint most likely to be underestimated, so it gets explicit numbers.

Telegram's documented limits: roughly **1 message/second per chat**, and **20 messages/minute to the
same group**. Three details decide the design:

1. **A forum supergroup is one chat.** Topics are not separate rate-limit buckets.
2. **`editMessageText` is not cheaper than `sendMessage`.** Every API method counts, including
   `answerCallbackQuery`, which we call on every button tap.
3. **The limits are per bot token, not per host or per chat.** Two bots in the same group each get
   their own 20/minute.

Point 3 is the one that rescues the arithmetic. With a single token the numbers are unworkable: a
session coalescing at 3s emits 20 edits/minute, which is the *entire* group budget, so two sessions
overrun it and four overrun it 4x.

**So the fleet uses two bot tokens:**

| Bot | Polls `getUpdates` | Sends | Budget |
|---|---|---|---|
| **Control bot** | Yes, the single poller | Permission prompts, questions, all inline keyboards, `answerCallbackQuery`, Claude's replies, lifecycle notices | 20/min, effectively all headroom |
| **Feed bot** | **No.** Send-only | Turn cards and their edits, `details` payloads | 20/min, entirely for P2 |

The feed bot never receives updates, so it never contends for the one-poller-per-token rule from the
overview. Buttons must be sent by the control bot, because a `callback_query` routes to the bot that
posted the keyboard. The visible side effect is two sender identities in a topic, which turns out to
read as a feature: machinery and conversation are distinguishable at a glance.

Mitigations, in order of importance:

1. **One card per turn.** The turn card is one `sendMessage` plus N `editMessageText`. The value is not
   that edits are cheap (they are not) but that the operator reads one evolving message instead of N
   messages, so the renderer is free to drop intermediate frames without losing information.
2. **Session-count-scaled coalescing.** Per-session flush interval `max(3s, 3s × activeSessions)`
   against the feed bot's 20/min: one session refreshes every 3s, four sessions every 12s, which is
   4 x 5 = 20 calls/minute at the ceiling. The renderer flushes only when the rendered text actually
   changed, so idle sessions cost nothing and return their share to the pool.
3. **A token-bucket governor per token**, with **three priority lanes** across both:
   - **P0** permission prompts, questions, their resolutions and callback acks. Control bot. Never
     dropped, never delayed by lower lanes.
   - **P1** Claude's `reply` messages and session lifecycle notices. Control bot.
   - **P2** feed card edits. Feed bot. **Droppable**: if the bucket is empty, a P2 edit is discarded
     rather than queued, because a stale intermediate frame has no value once a newer one exists.
4. **Automatic quiet mode.** If P2 drops exceed 50% over a 60s window, the Bridge posts "feed
   throttled, N sessions active" once and doubles the coalescing interval until pressure clears.

The two budgets are independent, so a feed storm can no longer delay a permission prompt at all. That
is the real win here, more than the doubling.

Handling `429`: honour `retry_after` from the response body exactly, pause the whole governor for that
duration (not just the failing lane), and never retry a P2 edit after a 429 - re-render from current
state instead.

**Handling everything that is not a 429.** A network error, timeout, or 5xx is not rate-limiting and
gets its own policy rather than falling through unhandled. P0 and P1 sends retry up to 3 times with a
short fixed backoff (1s, 2s, 4s), because these carry permission prompts and Claude's own replies,
which must not silently vanish; a P2 edit is never retried, consistent with the drop-oldest-first policy
above, since a newer frame supersedes it anyway. If a P0 send for a permission prompt still fails after
retries - the one case that matters most, because it is the operator's only path to answer a blocked
tool call - the Bridge logs it at `ERROR` (§9) and leaves the underlying request unresolved rather than
assuming it was delivered: it stays live for §6.5's terminal-side reconciliation and expires at the
normal 30-minute ceiling like any other unanswered prompt, never silently re-sent without bound.

### 5.5 The `details` button

`callback_data` is capped at **64 bytes**, so it carries a reference, never content: `d:<slug>:<turn>`.
On tap, the Bridge posts the full step log for that turn as a new message in the topic, or as a
document attachment if it exceeds Telegram's 4096-character message limit. Diffs always go as
documents; a diff rendered into a chat bubble on a phone is unreadable and burns budget.

### 5.6 Attachments and compaction

Two smaller paths, both previously unmentioned.

**Inbound attachments.** A phone is a camera, and the most natural way to report a bug from one is a
screenshot. Photos, documents, videos, forwarded/uploaded audio files, and Telegram's round "video
note" bubbles sent to a session topic are downloaded by the Bridge into
`$STATE/sessions/<slug>/inbox/` and announced as an ordinary channel message naming the path:

> operator sent an image: `/home/…/inbox/2026-08-02-141233-screenshot.png`

A caption sent alongside the attachment (Telegram allows exactly one, on the message itself) rides
along on the next line of that same announcement, so "here's the error, what's wrong?" and the
screenshot arrive as one turn, not two.

Claude then reads it with the normal file tools, which is the whole trick: no protocol extension is
needed, because a path in context is enough. The official Telegram plugin uses the same inbox pattern
and caps at Telegram's 20MB bot-download limit; we inherit both. The inbox sits inside the session
state directory rather than the worktree, so nothing accidentally gets committed.

Implemented and live-verified 2026-08-05 (`attachment-inbox.ts`): filenames are sanitised against
path traversal and mime-guessed when Telegram supplies none, a message over the 20MB cap is rejected
before any download is attempted, and attachments to the control topic (no worktree to hand a file to)
get a guidance reply instead. Live-verified against the real Telegram client: a screenshot and a
`.txt` document, each sent with a question in the caption, were both read and answered correctly by
Claude, confirming the path-in-context trick works for images and plain documents alike, not just
conceptually.

**Outbound files** already exist as the `details` mechanism (§5.5): anything over 4096 characters goes
as a document rather than a message.

**Compaction.** A long unattended session will auto-compact, and from a phone that looks like a
silent pause of tens of seconds. `PreCompact` and `PostCompact` hooks emit one feed line each
("compacting context…" / "compacted"), which costs one P2 frame and removes an unexplained gap. Worth
doing precisely because it is cheap and the alternative looks like a hang.

### 5.7 Telemetry: the third event path

The channel carries conversation, hooks carry activity, and neither carries a number. Claude Code
exports usage over **OpenTelemetry**, which makes "what is this costing" answerable without parsing
transcripts or scraping a TUI.

The Bridge listens on `127.0.0.1:4318` for OTLP/HTTP, and the generated per-session settings point
each session at it through the `env` block, so no shell plumbing is involved:

```jsonc
"env": {
  "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
  "OTEL_METRICS_EXPORTER": "otlp",
  "OTEL_LOGS_EXPORTER": "otlp",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
  "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",
  "OTEL_METRIC_EXPORT_INTERVAL": "15000"
}
```

What arrives, and why each piece matters:

| Signal | Attributes used | Used for |
|---|---|---|
| `claude_code.cost.usage` | `session.id`, `model`, `query_source` | Per-session spend in `/ls`; the rolling 5-hour total in `/budget`. `query_source` distinguishes `main`/`subagent`/`auxiliary` request origin - it does not distinguish subscription-billed interactive usage from credit-pool-billed `-p`/SDK usage, so it is never the mechanism for verifying §10.5's billing-pool split, which is an architectural guarantee (a real PTY, §2.3/§7.1) rather than something telemetry confirms after the fact |
| `claude_code.token.usage` | `session.id`, `model`, `type` (input / output / cacheRead / cacheCreation) | Distinguishing a session that is genuinely working from one re-reading its own context; a cacheRead-heavy session is cheap and a cacheCreation-heavy one is not |
| `claude_code.api_error` (event) | `session.id` | The quota-stop detector. This is what turns a silently frozen topic into "stopped on a usage limit" |
| `claude_code.session.count` | `session.id` | Cross-check against the routing table during reconciliation (§4.5) |

`session.id` is the join key, which is the same identifier `SessionStart` already binds to the slug, so
telemetry needs no routing of its own.

**The one thing it does not give us is headroom.** Consumption is exported; remaining quota is not.
So the fleet can say "this session has spent $3.10 and the fleet has spent $14 in the last five hours"
and cannot say "you have 20% left". §10.5 works within that limit rather than pretending otherwise.

Two deliberate restraints. `OTEL_LOG_USER_PROMPTS` and the tool-content variables stay **off**: prompts
and tool output would put source code and secrets into a second store for no operational gain. And
telemetry is strictly read-only input to the Bridge - nothing in the feed or the permission path
depends on it, so an OTLP listener failure degrades `/ls` and nothing else.

### 5.8 Screenshots and outbound files

§5.6 solved half of "let the operator see what's happening from a phone" - files travelling
*into* a session. The other half is Claude showing the operator something it produced: a running
web app at a given viewport, a desktop app that isn't a URL at all, or any other file Claude wants
to hand back. The `reply` tool (§3.3) is text-only, and §5.5's "details" mechanism only turns
oversized *text* into a document - neither carries a screenshot's bytes. This closes that gap.

**Outbound path: a new `send_file` channel tool, symmetric to the inbound design.** Claude saves a
file under this session's own `$AIBRIDGE_OUTBOX_DIR` (`$STATE/sessions/<slug>/outbox/` -
`outbox.ts`, eagerly created at launch same as the settings file) and calls
`send_file({ topic_id, path, caption? })`. The channel server does no validation itself - it just
forwards a `SendFileMessage` over the pipe, exactly as `reply` forwards text. The Bridge is the
only thing that decides whether a byte reaches Telegram: `resolveOutboxPath` re-resolves `path`
against `<stateDir>/sessions/<slug>/outbox/` and returns `null` for anything outside it (a `../`
escape, another session's outbox, an arbitrary absolute path like `~/.ssh/id_rsa`) - rejected
silently, logged, never read off disk. `mcp__aibridge__send_file` is pre-approved in the settings
baseline (§6.2) the same way `mcp__aibridge__reply` is, but that pre-approval only covers *calling
the tool*, not *which files* - the outbox boundary is what actually keeps this from becoming an
exfiltration path for anything Claude's context could name a path to. Once the Bridge has the
bytes, it sends a Telegram photo (`sendPhotoFile`, inline-rendered) for `.png`/`.jpg`/`.jpeg`/
`.webp`, or a document (`sendDocumentFile`) for everything else - deliberately narrow, matching
Telegram's own `sendPhoto` format allowlist rather than guessing.

**Web screenshots: the official Microsoft Playwright MCP server (`@playwright/mcp`), registered as
an *ordinary* MCP tool, not the aibridge channel.** `ensurePlaywrightRegistration`
(`claude-config.ts`) writes `projects[<key>].mcpServers.playwright` into `~/.claude.json` at every
launch. Two corrections against the first implementation, both found only by looking (§10.0/§6.5's
own discipline), not by trusting the plan's prior claim that this registry "just works" the way
SeoWrite's entries did:

1. **`command` must be `cmd`/`["/c", "npx", ...]`, not bare `"npx"`.** On Windows, `npx` is
   `npx.cmd`, a batch file - Claude Code spawns an MCP server's command directly, no shell, the
   same class of "bare command name unresolvable via a direct Windows spawn" issue
   `session-launcher.ts` already hit with `bun` (§2.4's `where bun.exe` fix). A bare-`npx` entry
   produced **no error anywhere** - not in the PTY, not in `claude mcp list` (the tool didn't even
   appear as "pending"), matching this file's own two prior documented failure modes exactly
   (§2.4's channel registry, §6.5's `tool_use_id`). Confirmed by diffing against SeoWrite's actual
   `~/.claude.json` entry, which wraps via `cmd /c` - the "just works" claim was only ever true
   *because* of that wrapping, never mentioned as significant until this session went looking.
2. **The registration key is the *main repo's* canonical path, not the worktree's.** Confirmed live
   by running `claude mcp add` from inside a worktree and reading back which project key it
   actually wrote to: `C:/data/projects/aibridge` (the main repo), not
   `C:/data/worktrees/<slug>`. `git rev-parse --git-common-dir` from the same worktree resolves to
   `<main repo>/.git` - Claude Code's per-project identity for `~/.claude.json` state follows a
   worktree's *git-common-dir* back to the main repo, unlike `.mcp.json`-based registration
   (`ensureTrustDialogAccepted`/`ensureMcpJsonRegistration`, resolved by plain cwd and genuinely
   per-worktree). Registering under the worktree's own path - the original implementation - wrote
   to a key Claude Code never reads, again with no error surfaced anywhere.

**Consequence of correction 2: this registration, and its `--output-dir`, is now necessarily
*shared* by every concurrent session on the same repo** - aibridge's whole point is several
sessions in parallel worktrees of one repo, and they'd otherwise clobber each other's
`--output-dir`. So `--output-dir` points at `playwrightSharedDir` (`$STATE/playwright-shared/`,
`outbox.ts`), not any one session's own outbox, and the channel server's instructions tell Claude
to `mv` a screenshot from there into its own `$AIBRIDGE_OUTBOX_DIR` before calling `send_file` -
`resolveOutboxPath` only ever accepts paths inside that session's own outbox, so a file merely
sitting in the shared directory can never be sent directly regardless of what path is named,
verified by its own test (`outbox.test.ts`). Filename collisions between two sessions shooting at
once are mitigated by Playwright's own default filename already including a timestamp, and by this
being single-operator tooling rather than a multi-tenant boundary - acceptable for what this is.

Once actually loaded, Claude drives the browser normally - navigate, resize the viewport or pick
one of the 143 device presets Playwright MCP ships, screenshot (`browser_take_screenshot`, its
`filename` "prefers" a relative name into the shared dir - Playwright MCP restricts writes outside
its own output root unless `--allow-unrestricted-file-access` is passed, which this registration
deliberately omits), `mv` into the outbox, `send_file` it.

**Desktop screenshots: a bundled PowerShell helper, for the "it's not a URL" case.**
`packages/bridge/assets/screenshot-desktop.ps1` uses `System.Drawing.Graphics.CopyFromScreen` to
capture either the whole virtual screen (all monitors) or, given `-WindowTitle`, one window's own
bounds (resolved via `user32.dll`'s `EnumWindows`/`GetWindowRect` - a no-match throws naming what
was searched for, rather than silently falling back to a full-screen capture that would look right
while showing the wrong thing). Its resolved path travels to the session as
`$AIBRIDGE_SCREENSHOT_SCRIPT`, run directly via `Bash` - it is a plain asset file, not a compiled
binary, so unlike the hook client there is nothing to `bun build --compile` here.

**Both paths' directories travel as env vars, set on three different places for three different
reasons:** the channel server's own `.mcp.json` `env` block (so its `instructions` text can name
the real absolute path instead of a placeholder - same "own env, not inherited from the PTY"
reasoning §2.4 already documents for `AIBRIDGE_SLUG`/`AIBRIDGE_TOPIC`), and the PTY's own `ptyEnv`
(so a `Bash` command Claude runs directly - the screenshot script, or pointing a dev server's own
asset dump somewhere - can reference `$AIBRIDGE_OUTBOX_DIR`/`$AIBRIDGE_SCREENSHOT_SCRIPT` without
being told the path in every prompt).

**What starting the backend/frontend itself needs: nothing new.** A session's `Bash` tool is
already unrestricted enough to `npm run dev &` in its own worktree: this section is only about the
missing "now show me" half, not about running the app.

**Permission model.** Running the screenshot script or a Playwright tool call raises the normal
allow/ask/deny escalation (§6) like any other `Bash`/MCP call not on the baseline allowlist -
deliberately *not* pre-approved, since "take a screenshot" can be steered into "read this file and
call it a screenshot" by a sufficiently adversarial prompt. Only the *delivery* tool (`send_file`)
is pre-approved, and only because its own path is path-restricted regardless of approval.

Implemented and live-verified in two passes (2026-08-05): the desktop-screenshot path was confirmed
end to end first (a live session ran the screenshot script and `send_file`, and a real PNG arrived as
an inline photo bubble), then Playwright's initial "no tools available" failure was root-caused to
exactly the two corrections above (bare `npx`, worktree-vs-main-repo registration key) and re-verified
live with the full Playwright toolset loading on a fresh session.

### 5.9 Fixing the Bridge itself from Telegram

A natural question once §7.5 makes "which project" a plain `repos.toml` lookup: can aibridge fix
*itself* the same way, from a phone, with no desk involved? Nothing stops aibridge's own repo from
being registered like any other project - `/new aibridge fix the thing that's broken` cuts a
worktree and starts a session against aibridge's own source exactly like any other `/new`. The gap
was landing that fix and applying it: a worktree session produces a branch, not a change on the
checkout the running Bridge process actually loaded its code from, and §4.5.1's `/restart` only
ever re-execs whatever is already on disk - it has no opinion about getting a fix onto that disk in
the first place.

**`/deploy <slug>`, control-topic only.** Looks up that session's row for `repoPath`/`branch`
(already tracked per-session, §4.2's routing table), and:

1. **Merge, fast-forward only.** `git merge --ff-only <branch>` into `repoPath`'s current HEAD -
   deliberately never a real merge commit; a branch that's diverged from main is a "rebase it
   yourself" case, not something worth resolving automatically over a chat window. Refuses outright
   (no merge attempted at all) on a dirty tree, a missing branch, or a non-fast-forward branch.
2. **Gate.** The same check an operator would run by hand per §9: `bun test` once at the repo root
   (covers every workspace), then `tsc --noEmit` per package that declares a `typecheck` script
   (`discoverTypecheckedPackages` - computed from `packages/*/package.json` at deploy time, not
   hardcoded, so a future new package is covered for free). A gate failure after a real merge runs
   `git reset --hard` back to the commit recorded before the merge started - the repo is never left
   sitting on an untested commit.
3. **Restart, only if this was aibridge's own repo.** `isSelfRepo` compares `repoPath` against
   `resolveBridgeRepoRoot` (the running process's own module directory, resolved three directories
   up from `packages/bridge/src` regardless of the Bridge's actual launch cwd) via the same
   drive-letter/slash canonicalisation §2.4 already uses for `~/.claude.json` keys. Merging a branch
   into any *other* registered project is just the merge+gate above with a confirmation message -
   there's no "Bridge" to restart for it. Merging into aibridge's own repo does the identical
   self-respawn `/restart` already performs (`spawn(process.execPath, ...)`, `detached: true`,
   `process.exit(0)`), so every live session dies and comes back the same way any other Bridge
   restart already does (§4.5) - not a new code path, `/deploy`'s self-repo branch *is* `/restart`,
   just reached after a merge+gate instead of on its own.

   **Confirm-gated on *other* live sessions (operator request, 2026-08-12), same as `/restart`'s own
   gate above.** `restartIfSelfRepo` checks `sessionStore.all()` for any non-`dead` row other than the
   one whose branch was just merged - that one is expected to die and cold-resume as a direct
   consequence of the `/merge`/`/ship`/`/deploy` the operator (or the session itself, for a bare
   `/ship`) just ran, the same way `/restart` itself restarts immediately when only its own topic's
   session is alive. It's specifically *other* sessions this would surprise-kill without warning that
   get a Yes/Cancel confirm card first (`RestartConfirmRegistry`, shared with `/restart`), naming each
   one and its state. `deployMarker` is written only once the operator actually confirms (or
   immediately, on the no-other-live-sessions path) - never at merge time - so a Cancel tap, or a card
   that simply expires, leaves nothing written and the merge stays merged-but-not-yet-applied until
   either a tap or a later plain `/restart` picks it up.

**The crash-loop problem `/restart` never had to solve, because a human always triggered it
knowingly.** A `/deploy`-triggered restart can be wrong in a way `/restart` itself can't: the commit
being restarted *into* might simply not work - and the only thing that could ever tell the operator
that is the Bridge process itself, which is exactly what's failing to come up. `deployMarker`
(`deploy.ts`, `$STATE/deploy-pending.json`) is the safety net: written right before the self-respawn
with the pre-merge commit and the chat/topic to notify, it survives across process boundaries
(unlike anything held only in memory) precisely because a crash is the failure mode being guarded
against. Two checks in `main()`, one at each end of startup:

- **Near the very start** (right after the bot tokens validate, deliberately before any heavier
  setup): if a marker exists and is older than `DEPLOY_CRASH_LOOP_THRESHOLD_MS` (45s - matches §7's
  own Task Scheduler restart cadence, "restart every 1 minute, up to 99 times", so a marker is only
  treated as stale once a boot attempt has had a full cycle to either clear it or crash again, never
  mid-way through the very attempt that wrote it), that boot clearly isn't the attempt the marker
  was written for - `rollbackStaleDeploy` resets `repoRoot` back to `previousHeadSha`, notifies the
  recorded chat/topic, and self-respawns once more (this time onto the reverted commit).
- **At the very end** (once `main()` has reached its last line without throwing - the same "this
  boot actually worked" signal `§4.5`'s own reconciliation already relies on): a marker still
  present is *this* attempt succeeding, not a crash-loop - notified with the new commit, then
  cleared, so the stale check above never sees it again.

This is a best-effort net, not a guarantee, stated as plainly as §4.5.1's own restart-recovery
caveat: if the very first boot after a bad deploy corrupts state badly enough to prevent even
*this* check from running (rather than merely crashing on the way there), nothing here saves it -
that failure mode needs the same physical/Task-Scheduler-level recovery any other unrecoverable
crash would. What it does cover, and was the actual point: an ordinary bug that would otherwise
crash-loop the Bridge forever on a broken commit, with the operator locked out of the one channel
that would tell them, now reverts itself within about a minute and says so.

**Scope.** `/deploy` intentionally does not: merge anything other than fast-forward (no auto-resolve
of a real conflict), run outside the gate this project's own `§9` already calls the test plan, or
touch any session's worktree - `/rm`/`/kill` remain the only things that ever delete a worktree.

Implemented and live-verified 2026-08-05 (`deploy.ts`, with all git/test invocations behind an
injectable `CommandRunner` so the merge/gate/rollback/crash-loop logic is unit-tested without a real
git repo or `bun test` run). A real self-deploy against aibridge's own repo (fast-forwarding a
worktree branch, running the gate, restarting) produced the four expected Telegram messages in order
- ack, merge+gate result with real pre/post SHAs, restart notice, post-respawn success - with the
`deploy-pending.json` crash-loop marker confirmed written before the respawn and cleared after, and
both pre-existing sessions reconciling cleanly afterward.

**`/ship [<slug>]` - `/deploy` plus the two steps an operator otherwise had to do by hand.**
`/deploy` assumes the session already committed and that landing the merge locally is enough; in
practice an operator wanting to close out a session is usually looking at a still-dirty worktree and
a merge that then needs to actually reach the remote. `/ship` is that one command:

1. **Auto-commit if dirty.** `commitIfDirty` runs `git status --porcelain` against the session's
   `worktreePath`; if it's not clean, `git add -A` then a commit with a fixed, clearly-auto-generated
   message (`chore: auto-commit uncommitted work for /ship`) - never freeform, so "the Bridge
   committed this for me" is never mistaken for an intentional commit message in `git log`. A clean
   worktree (the session already committed its own work) is a no-op, not an error.
2. **Merge + gate**, identical to `/deploy` step 1-2 above, via the same `deployBranch`.
3. **Push.** `deployBranch` only ever advances `repoPath`'s local checkout - without this the merge
   never leaves the machine. `pushCurrentBranch` pushes whatever's actually checked out (not a
   hardcoded `main`/`master` - §7.5 repos can name their default branch either way) to its `origin`
   remote. Only reached after a successful merge; a push failure here is reported as its own
   distinct failure rather than rolled back - the merge already happened and stays merged, only "did
   it reach the remote" is in question.
4. **Restart, only if self-repo** - the exact same tail `/deploy` runs (`restartIfSelfRepo`, shared
   between both commands so they can never drift apart on this behaviour).

Marked destructive in the NL router (`isDestructive`) alongside `/restart`/`/deploy`, so a natural-
language match still gets a confirm card under `/assist` before it runs.

**Unlike `/deploy`, `/ship` takes its `<slug>` optionally - the §4.2 `/kill`/`/rm`/`/pause`/`/usage`
convention, not `/deploy`'s control-topic-only restriction.** Sent bare from inside a session's own
topic, it resolves against that topic's own `currentSlug` and runs exactly the same four steps above
- still entirely as trusted Bridge code via a direct `CommandRunner`, never through that session's own
Claude process or its `permissions.ask` gate, so there is no Telegram permission button to tap at all
for this path (a real `git commit`/`git push` invoked *by the session itself* still goes through that
gate as always - `/ship` bypasses nothing there, it simply never asks the session to run those
commands in the first place). This closed a real, observed failure mode (2026-08-09 live use): typing
bare `/ship` inside a session's own topic *before* this existed didn't match `parseFleetCommand` at
all (a missing slug returned `null`), so it fell through and was forwarded to the session's own Claude
process as ordinary chat text - which, if that session's worktree predated this feature and had no
`ship.md` custom command either, led Claude to go searching the repo for what "/ship" might mean
rather than anything happening. An *explicit* slug naming a session other than the one you're
currently in still requires the control topic either way - only a bare invocation resolving to the
session already in view skips that check, since that's exactly as deliberate an operator action as
typing the slug from the control topic, just aimed at the session already on screen.

**The in-session half: `/commit`, `/push`, `/ship` as `.claude/commands/*.md`.** The command above
runs as Bridge code and can land a session without ever opening it - but it needs the session to have
*stopped* touching the worktree first. The complementary gap is landing work from *inside* the
session's own topic, in one command, while the session is still the one doing the work - but a
session's worktree can never check out the default branch itself to fast-forward it the way the
Bridge-level `/ship` does (only one branch can be checked out per worktree, and the default branch is
checked out elsewhere), so "land to main" from in here goes through GitHub instead: push the branch,
then `gh pr merge` server-side. Three commands, each independently useful and the latter two reusing
the former's steps:

- `/commit` - stage + a real commit message + commit.
- `/push` - push the branch + `gh pr create` against the default branch if none exists yet.
- `/ship` - runs this project's own gate first (§9), then commit → push → `gh pr merge`.

All three still go through the same `permissions.ask` buttons `git commit`/`git push`/`gh pr *`
already sit behind (§6.1.1) - nothing here is a new bypass, just fewer manual steps between "the fix
is done" and "the button is in front of the operator." The asymmetry with the control-topic `/ship`
is deliberate, not a bug: the two land to `origin/<default-branch>` via different git plumbing (local
fast-forward+push vs. a GitHub-side PR merge) because that's the mechanism actually available in
each execution context; either one leaves any *other* local checkout of the default branch behind
until it's next pulled.

Implemented 2026-08-09 (`deploy.ts`'s `commitIfDirty`/`pushCurrentBranch`, wired into
`deploy-lifecycle-commands.ts`'s `handleShipCommand`; unit-tested the same way as `/deploy` via the
same injectable `CommandRunner`).

### 5.10 Detail on demand: `/detail` and `/verbose`

§5.3's turn card is deliberately terse - an 80-char one-liner per tool call, capped at 8 lines -
because that's what stays readable glancing at a phone. The gap: sometimes the operator actually
wants to see what a step *did*, the way VS Code's own Claude Code panel shows a collapsed
IN/OUT card per tool call. Telegram has had exactly that primitive natively since Bot API 7.3:
`<blockquote expandable>…</blockquote>` renders collapsed by default, one tap to open, no button/
callback round-trip needed. This section is that primitive, wired to two independent per-session
switches rather than a single "verbose mode":

- **`/detail [<slug>] [compact|full]`** - default `compact` (today's exact card, byte-for-byte
  unchanged for every session that never touches this). `full` wraps each line's *untruncated*
  input - not just the 80-char summary, `hook-events.ts`'s new `fullToolInput` (same field
  preference order as the compact `summarizeToolInput`, just without the cut, falling back to a
  shallow dump of every string field for a tool shape neither matched, since "full" having *less*
  than compact already gave would defeat the point) - in a collapsed blockquote under the same
  always-visible summary line.
- **`/verbose [<slug>] [on|off]`** - default `off`, independent of `/detail`. Whether the tool's
  *actual result* - not just what it was asked to do - also appears inside that same blockquote.
  Kept as its own switch rather than folded into `full` because it's a materially different §8.2
  tradeoff: `fullInput` is data already flowing to Telegram in truncated form (this just stops
  truncating it), while a tool's output is new data that was never going to Telegram at all -
  arbitrary file contents, command stdout, anything the session touched. Off by default, and has
  no visible effect until `/detail` is also `full` (there's no line to attach it to otherwise) -
  the command's own confirmation says so rather than silently no-op'ing.

Both take the same two forms every other session-scoped fleet command already does (`/pause`'s
shape): bare from inside the session's own topic, or `<slug> <value>` from the control topic. A
single token is resolved by checking whether it's a valid value (`compact`/`full`, `on`/`off`)
first, since a slug can never collide with those exact words; a bare command with no value reports
the current setting rather than changing anything (`/autostart`'s own "no argument = status"
convention). Both settings persist per-session in `sessions.feed_detail`/`sessions.feed_verbose`
(new columns, migrated the same `ALTER TABLE ... ADD COLUMN` way `renamed` was), so they survive a
Bridge restart the same way `paused`/`model` already do.

**Where the data actually comes from.** `PreToolUse` already carries `tool_input` in full (§5.1) -
`fullInput` is free, no new hook capture needed. `output` is not: it depends on `PostToolUse`
carrying a `tool_response` field, which - per this project's own repeatedly-learned lesson (§2.4's
channel capability negotiation, §6.5's `tool_use_id`) - is trusted from Claude Code's public
documentation only, **not yet independently live-verified** the way `PermissionRequest`'s payload
was via Stage 0's spike. What *is* live-verified: Stage 0's own 2026-08-03 capture of a real
`PostToolUse` for a `Read` call, sitting in `hook-events.test.ts` since Phase 3, already carries a
`tool_response: { type: "text", file: { filePath, numLines } }` - confirming the field exists and
giving one confirmed shape to key off; `summarizeToolResponse` handles that shape by name and
degrades to "no output" (never a crash) for every other tool's guessed shape (`stdout`/`stderr` for
Bash, `content`/`output`/`result`/`filePath` as a generic fallback) until each is checked the same
way. This is shipped ahead of that check deliberately - the failure mode is "verbose shows nothing
for some tools," not a wrong or dangerous answer - but should not be read as a completeness
guarantee before a live pass confirms the other shapes.

**Card layout in `full` mode is size-driven, not count-driven.** Compact's fixed 8-line cap doesn't
carry over - each line is now a blockquote of unpredictable length, so `renderCard` walks the log
from most recent backwards, keeping whatever fits under `MAX_CARD_CHARS` (3800, comfortably under
Telegram's real 4096-UTF-16-unit cap with headroom for markup), and rolls the rest into the same
"…and N earlier steps" counter compact mode already uses. The `details` button (§5.5) is
unaffected in shape - one line per activity, same as always - but now shows each line's full input
regardless of the session's own `/detail` setting (already an explicit tap, no reason to withhold
it there) and appends output only when that session's `/verbose` is on.

Implemented 2026-08-05 (`session-store.ts`'s persisted `feedDetail`/`feedVerbose` per session,
`hook-events.ts`'s `fullToolInput`/`summarizeToolResponse`, and the corresponding `feed-renderer.ts`/
`fleet-commands.ts` wiring - every pre-existing call site defaults to compact/off, so its output is
unchanged byte-for-byte). Live-verified against a real session and Telegram's actual native
`<blockquote expandable>` rendering: both the full tool input and the tool's real output appeared
together in the collapsed blockquote as designed, confirming `PostToolUse`'s `tool_response` carries
recognisable output for a live Bash call too, not just the one shape independently confirmed at
Stage 0.

---

## 6. Permissions

### 6.1 Four mechanisms, one policy

Claude Code offers four places to intervene, and using two of them for the same purpose would produce
double prompts. The split:

- **`settings.json` permission rules** are the *policy*: deny, ask, allow, evaluated in that order.
  Native, declarative, no code path of ours in the hot loop.
- **The channel permission relay** is the *escalation UI*. It fires only for calls policy did not
  pre-decide.
- **`PreToolUse` hooks** are used for the feed, for `AskUserQuestion`, and for a hard denylist - **not**
  for the routine allow decision. Putting the allowlist in a hook would mean re-implementing rule
  matching that the framework already does correctly, and §6.1.1 shows the framework's version outranks
  the hook's anyway.
- **The OS sandbox** (§6.7) is the *containment boundary*, and it is a different kind of thing from the
  other three: they decide whether a command runs, it decides what the command can reach once running.
  It is what makes a small ask list defensible rather than reckless.

### 6.1.1 Why a target repo's own guard hook does not defeat this

**Worked example, not aibridge's own code:** SeoWrite, the first project registered against this
design, carries `.claude/hooks/guard-git-write.ps1`, a `PreToolUse` hook whose final layer (Layer 6 as
of **2026-08-02**, renumbered that same day from Layer 3 by an unrelated edit to the hook - its own
layer numbers are not stable across the hook's edits, so treat any specific number here as a snapshot,
not a citation) returns `permissionDecision: 'allow'` for every `git commit` and `git push` off a
protected branch - a deliberate choice by that repo's owner, made after being prompted at essentially
every step of a multi-PR session. aibridge does not ship this hook and has no opinion on whether a
registered repo has one; the finding below is about how *any* such hook interacts with the settings
aibridge generates, and it was proven against this one because it was the concrete case in hand.

**v0.2.0 of this plan concluded that this pre-empts the permission system and would let a phone commit
unapproved. That conclusion was wrong**, and the docs are explicit about it:

> "Hook decisions don't bypass permission rules. Claude Code evaluates deny and ask rules regardless of
> what a PreToolUse hook returns: a matching deny rule blocks the call, and a matching ask rule still
> prompts even when the hook returned `"allow"` or `"ask"`."
> - [Configure permissions](https://code.claude.com/docs/en/permissions#extend-permissions-with-hooks)

The full order is **hooks → deny rules → ask rules → permission mode → allow rules → prompt**. A hook
`allow` skips only the *allow-rule* step and the prompt that would follow it. It cannot outrank a deny
or an ask rule, and that is stated as deliberate precedence, not an implementation detail.

**Resolution: an `ask` rule, in the settings the Bridge already generates.**

```jsonc
"ask": ["Bash(git commit *)", "Bash(git push *)"]
```

**This is verified, not inferred.** v0.2.0 reached its wrong conclusion by reasoning rather than
reading, so this correction was tested before being written down. Two headless runs on 2026-08-02,
differing in exactly one line:

| Run | `PreToolUse` hook | `allow` rule | `ask` rule | Command ran? |
|---|---|---|---|---|
| Control | returns `allow` | `Bash(echo *)` | none | **yes**, side-effect file created |
| Treatment | returns `allow` | `Bash(echo *)` | `Bash(echo probe *)` | **no**, "permission for the Bash tool was declined" |

The hook wrote a marker file in both runs, so its `allow` was genuinely delivered and genuinely lost
to the ask rule. Ground truth was a file on disk rather than the model's narration of what it did,
because a model reporting "I ran it" is not evidence that it ran. The probe is three small files
(a settings pair and a PowerShell hook that returns an unconditional `allow`) and belongs in the
package's fixtures as scenario 31, so a client upgrade that changes this precedence fails a test
rather than silently un-gating every commit.

The rest of this section follows from that result. It is strictly better than v0.2.0's proposal in
four ways. It touches **no file in any registered repo**, so a target repo's own guard hook (where one
exists, as in SeoWrite's case) keeps whatever ergonomics its owner chose and needs no
`AIBRIDGE_SESSION`-style gate. It is per-session, so local terminal sessions are unaffected by
construction rather than by a conditional. It cannot be defeated by a future edit to that repo's guard,
because it does not depend on the guard's return value at all. And it survives the sandbox: the
sandbox docs use `Bash(git push *)` as their own worked example of a content-scoped ask rule that
"still force[s] a prompt even for sandboxed commands" (§6.7).

One caveat that follows from the same precedence chain: a **bare** `Bash` ask rule, or `Bash(*)`, is
skipped for commands that run sandboxed. Ask rules must therefore stay content-scoped. Never write
`"ask": ["Bash"]` and expect it to gate anything once §6.7 is on. On the Windows host there is no
sandbox, so the caveat is inert today and becomes live at the §7.6 migration - which is a good reason
to write the rules content-scoped from the start rather than discovering this at Phase 6.

SeoWrite's guard hook needs no work on Windows (§7.3), but where a target repo has one it remains
load-bearing for a reason the `ask` rule cannot cover: its protected-branch and `--no-verify` hard
blocks (Layers 3 and 4 as of 2026-08-02) are `exit 2` blocks. Those are the layers a phone cannot compensate for
- an `ask` rule turns a commit into a button, but nothing turns "you are on `main`" into a button. A
registered repo with no such hook simply has no equivalent hard block, and that is a property of the
repo, not of aibridge.

### 6.2 The per-session settings baseline

Generated by the Bridge into `$STATE/sessions/<slug>/settings.json` at launch and passed with
`--settings`. Three lists, evaluated **deny, then ask, then allow**, first match wins, and specificity
does not reorder them:

```jsonc
{
  "permissions": {
    "deny": [
      "Bash(rm -rf /*)", "Bash(git push --force *)",
      "Bash(curl * | sh)", "Bash(curl * | bash)",
      "Read(.env)", "Read(~/.ssh/**)", "Read(~/.aws/**)"
    ],
    "ask": [
      "Bash(git commit *)", "Bash(git push *)",
      "Bash(gh pr *)", "Bash(npm publish *)", "Bash(dotnet nuget push *)"
    ],
    "allow": [
      "Read", "Grep", "TodoWrite", "NotebookRead",
      "mcp__aibridge__reply",
      "Bash(git status *)", "Bash(git diff *)", "Bash(git log *)",
      "Bash(git branch *)", "Bash(git show *)",
      "Bash(dotnet build *)", "Bash(dotnet test *)",
      "Bash(npm run *)", "Bash(npm ci)",
      "Bash(ls *)", "Bash(cat *)", "Bash(rg *)"
    ]
  }
}
```

`ask` is the list that carries decision 3. An ask rule prompts even when a more specific allow rule
matches the same call, and even when a `PreToolUse` hook returned `allow` (§6.1.1). Omitting a rule
merely leaves a call unresolved so it falls through to a prompt; naming it in `ask` *guarantees* the
prompt. For the handful of genuinely irreversible actions, guaranteed beats incidental.

Everything absent from all three lists still escalates, which continues to include `Edit` and `Write`.

Four documented traps, each a silent-wrong of exactly the kind §9 exists to catch:

- **Path rules are consulted for `Read` and `Edit` only.** Since v2.1.210 a `Write(path)`,
  `NotebookEdit(path)` or `Glob(path)` rule is accepted, never consulted, and warned about at startup.
  `Edit(path)` governs every file-writing tool including `Write`. Use `Edit(...)`, never `Write(...)`.
- **A single leading slash anchors at the settings source, not the filesystem root.** `Read(/secrets/**)`
  means something different in every scope, and for a file passed via `--settings` the anchor is not
  worth reasoning about. The generator emits **only** `~/` home-anchored or `//` absolute-anchored
  paths, never a single leading slash. Bare filenames follow gitignore semantics and match at any
  depth, which is why `Read(.env)` above is correct and `Read(./.env)` was needlessly narrow.
- **Rules match canonical tool names, not the labels shown in the UI.** The tool displayed as
  `Stop Task` is `TaskStop`; a rule written from the label silently never matches. Generated rules and
  hook matchers come from the
  [tools reference](https://code.claude.com/docs/en/tools-reference), not from screenshots.
- **The space before `*`.** `Bash(git diff*)` also matches `git diff-index`. `Bash(git diff *)` does
  not.

One more precedence note worth internalising: a hook that **exits 2** stops the call before permission
rules are evaluated at all, so the guard's protected-branch and `--no-verify` hard blocks outrank
every list above. That is the correct shape - a hard block should not be negotiable by settings.

### 6.3 The relay round trip

```
Claude calls Bash(git commit …)
  → no matching allow rule → local dialog opens, session blocks
  → Claude Code emits notifications/claude/channel/permission_request
      { request_id: "kqxmr", tool_name: "Bash",
        description: "Commit the billing fix", input_preview: "{\"command\":\"git commit -m …\"}" }
  → channel server forwards to Bridge over the socket
  → Bridge posts to the session's topic with an inline keyboard
  → operator taps
  → Bridge sends notifications/claude/channel/permission { request_id, behavior }
  → local dialog closes, tool runs or is rejected
```

Message shape:

```
🔐 refactor-billing wants to run Bash

Commit the billing fix

  git commit -m "fix(billing): correct proration on mid-cycle upgrade"

[ ✅ Allow ]  [ ⛔ Deny ]
[ ♾️ Always allow this pattern ]
```

`callback_data` encoding, well inside 64 bytes: `p:<request_id>:<a|d|A>`. The `request_id` is five
letters from `[a-km-z]` (no `l`, so it never reads as `1` or `I` on a phone), which is a 25⁵ ≈ 9.7M
space, but the Bridge still scopes pending requests **per session** and expires them, because the
space is per-request-in-flight, not global-unique-forever.

### 6.4 `AskUserQuestion` becomes buttons

The protocol relays *permission* prompts. It does not relay Claude's own questions, so those need the
hook path, and this is an officially supported use of it rather than a trick:

- A `PreToolUse` hook with matcher `AskUserQuestion`, declared **synchronous** (all others are async).
- The hook posts each question as its own message with one inline-keyboard row per option.
- It blocks on the Bridge socket until an answer arrives, then returns `permissionDecision: "allow"`
  **together with** `hookSpecificOutput.updatedInput`, which echoes the original `questions` array and
  adds an `answers` object mapping each question's text to the chosen option. The tool then runs
  without prompting and Claude receives the answers as if the terminal picker had been used.

`AskUserQuestion` is one of the tools that **always** reaches the permission step even when an allow
rule matches it, so this hook cannot be accidentally short-circuited by widening the allow list. The
one configuration that breaks it is `permissionMode: "dontAsk"`, which denies always-prompt tools
outright; the generated settings never set it.

**The timeout is a configuration value, not a ceiling to work around.** Command hooks default to 600s,
but `timeout` is a per-hook field with no documented maximum. v0.2.0 proposed a 540s synthetic
first-option answer to stay inside the default; that was solving a problem that does not exist, and
auto-answering a design question with "whatever was listed first" is exactly the kind of silent wrong
decision this system should never make. Instead:

- `"timeout": 3600` on this hook alone. An hour is a realistic worst case for "the operator is in a
  meeting", and every other hook keeps its default.
- At **3540s** the Bridge posts "no answer in an hour, cancelling the question" and returns
  `permissionDecision: "deny"` with a reason. Claude sees an explicit refusal and can re-ask, replan,
  or stop. A visible cancellation is recoverable; a wrong answer silently adopted as a decision is not.
- The topic keeps the question message with its keyboard stripped, so the history shows what was asked
  and that nobody answered.

### 6.5 Reconciliation, and what the protocol does not give us

**There is no "request resolved" event.** If the operator answers at the terminal instead of the phone,
or the session dies with a prompt open, Claude Code drops the late remote verdict *silently* and our
buttons stay live forever. Tapping a stale button does nothing and looks broken.

v0.2.0 accepted heuristic correlation for this. v0.5.0 replaced it with a join on `tool_use_id`,
believing the `PermissionRequest` hook carried one. **Measured on 2026-08-02, it does not.** The real
payload, captured from a denied `Write`:

```jsonc
{
  "hook_event_name": "PermissionRequest",
  "session_id": "e1e1cc55-…",
  "transcript_path": "C:\\Users\\…\\<session>.jsonl",
  "cwd": "C:\\…\\sitting",
  "prompt_id": "57589be3-…",          // per TURN, not per tool call
  "permission_mode": "default",
  "effort": { "level": "medium" },
  "tool_name": "Write",
  "tool_input": { "file_path": "…\\permprobe.txt", "content": "hello\n" },
  "permission_suggestions": [ { "type": "setMode", "mode": "acceptEdits", "destination": "session" } ]
}
```

No `tool_use_id`, no `permission_rule_id`, no `permission_rule_text` - all three were assumed and none
exist. The matching channel notification carried `request_id: "cpyjk"`, `tool_name`, `description` and
`input_preview`, and **no** `session_id` or `prompt_id`. So the two payloads share no field that
identifies an individual call: `prompt_id` is per turn, and one turn can contain many tool calls.
There is no exact join, and there is no version of this design in which there is one.

**So stop joining.** The card renders from the channel notification alone:

- `input_preview` in the measured payload carried the **complete** file path and file content,
  JSON-shaped and untruncated. It is sufficient to render a full approval card by itself.
- `request_id` is all that is needed to answer.
- The 3,500 code-point cap and the `"Run shell command"` fallback for `description` remain real, but
  they degrade the card's prose, not its correctness, and `input_preview` covers the gap.

That deletes the reconciliation problem from the approval path rather than solving it, and demotes the
`PermissionRequest` hook to what it is actually good for: the activity feed, and detecting resolution.

For **resolution** the Bridge still needs to know a prompt was answered elsewhere, and here a
heuristic is unavoidable and acceptable. Pair on `(session_id, tool_name, deep-equal tool_input)`
within the pending window:

- A `PostToolUse` / `PostToolUseFailure` whose `tool_name` and `tool_input` match a pending prompt in
  the same session means it ran. Edit to "✅ allowed (answered at terminal)" and strip the keyboard.
- A matching `PermissionDenied` means refused. Same treatment.
- Absent either, expire at **30 minutes**: strip the keyboard, mark it "⌛ expired".

Deep-equal on `tool_input` is a strong key in practice - two byte-identical calls pending
simultaneously in one session are indistinguishable to the *operator* too, so resolving them in
arrival order is correct behaviour rather than a compromise.

One bonus from the measured payload: `permission_suggestions` names the escalation Claude Code would
itself offer (here `setMode: acceptEdits`). That is a ready-made third button, and it is a better
basis for §6.6's `♾️ Always` than a rule string we invent.

**MCP tool calls relay too.** The 2026-08-02 run raised a permission dialog for the channel server's
own `reply` tool. Every outbound Bridge message would prompt until allowlisted, so
`mcp__<server>__reply` belongs in the §6.2 baseline allowlist from the start.

**Why the observer is not the decision-maker.** `PermissionRequest` can return
`decision.behavior: allow|deny` plus `updatedInput`, and could in principle replace the channel relay
outright. It is not adopted for that here, for two reasons: the decision path has a history of not
being applied ([#19298](https://github.com/anthropics/claude-code/issues/19298), closed as not
planned, though the reporter was using the `PreToolUse` schema on a `PermissionRequest` hook), and a
blocking hook removes the terminal's own dialog, which is the fallback that makes a wedged session
recoverable at the terminal. The relay stays primary because it is the documented remote-approval
path and it leaves both answering surfaces live. If P-4 shows the relay is unreliable, the hook
decision path is the drop-in replacement and §12 records it as such.

### 6.6 "Always allow" is ours, not the protocol's

The protocol is explicit: "Neither verdict affects future calls." So `♾️ Always` is implemented by us:
send `allow` for the current request, **and** append a derived rule to the session's settings allow
list. Deriving that rule is the risky part.

Rules:

- Non-`Bash` tools generalise to the bare tool name (`Edit`, `Write`).
- `Bash` generalises to the **first two tokens plus `*`** and no further: `git commit *`, `npm run *`.
  Never generalise to a bare `Bash(*)`, and never derive a rule from a command containing a shell
  metacharacter (`|`, `;`, `&`, `$(`, backtick) - in that case fall back to allow-once and say so.
- The derived rule is echoed back in the confirmation message so the operator can see what they just
  granted: "♾️ allowed, and added `Bash(git commit *)` for this session".
- **"For this session" is true because the Bridge makes it true, not because Claude Code re-reads
  anything** (measured live 2026-08-12, §12 Phase 2). The running process does *not* act on a rule
  appended mid-conversation - the next matching call escalates to the relay anyway. What honours the
  tap is `pipe-server.ts`'s `handlePermissionRequest` re-reading this session's settings file on
  every permission request and short-circuiting the card itself: `compound-permission.ts` for
  `Bash`, `rule-derivation.ts`'s `isCoveredByBareToolRule` for every other tool (added 2026-08-12 to
  close exactly this gap - until then an `♾️ Always` on a `Write` was a no-op for the rest of the
  conversation, while still confirming otherwise). **If a future change stops re-reading per
  request, that confirmation silently becomes false again** - the re-read, not the file write, is
  the load-bearing half.
- **`Edit` and `Read` are a deliberate exception to the above.** The baseline's own scoped deny
  rules (`Edit(.env)`, `Edit(~/**)`, `Read(~/**)`, ...) mean a bare `Edit` grant could only be
  honoured by deciding whether *this call's* path matches those globs - i.e. by reimplementing
  Claude Code's path-glob semantics, where a subtle mistake auto-approves access to the very secrets
  those rules exist to protect. The Bridge refuses instead, so an `♾️ Always` on an `Edit` still
  re-prompts. Accepted: a repeated prompt is a worse day, a wrong glob is a breach.
- Session-scoped by default. `/persist <slug>` promotes a session's accumulated rules into the
  user-level settings, as a separate deliberate act.
- An `♾️ Always` tap can never add a rule that a `deny` or `ask` entry already covers. Deny wins by
  precedence anyway, but an ask rule silently accumulating an allow twin would be a confusing no-op.

Claude Code's own "Yes, don't ask again" does something very close to this and is worth copying rather
than inventing around: it saves **a separate rule per subcommand** of a compound command, up to five,
so approving `git status && npm test` yields a rule for `npm test` alone. That is the same instinct as
the metacharacter guard above, arrived at independently by the framework, which is mild evidence the
guard is drawn in the right place.

### 6.7 The OS-level sandbox, and why Windows does not get one

Everything above is Claude Code deciding, before a command runs, whether to run it. The
[sandbox](https://code.claude.com/docs/en/sandboxing) is a second, independent layer: the operating
system enforcing what a command can touch **once it is running**, for that command and every child
process it spawns.

**It does not exist on the chosen host.** The docs are unambiguous and say so three times, most
directly: *"The sandbox is built into Claude Code and runs on macOS, Linux, and WSL2. Native Windows is
not supported. On Windows, run Claude Code inside a WSL2 distribution."* The implementation is Seatbelt
on macOS and `bubblewrap` on Linux and WSL2; there is no Windows primitive behind it, so there is no
degraded mode to configure and nothing to probe. This is the entire price of the host decision (§7),
and it is a real one.

The rest of this section is therefore in two parts: **what compensates on Windows now**, and **the
configuration to adopt if and when the fleet moves to WSL2** (§7.6), kept because it is the reason
Phase 6 exists at all.

#### 6.7.1 What the sandbox would have solved, and what covers it instead

Three of this plan's open problems are its documented purpose:

- **Approval fatigue (§10.3).** In auto-allow mode, a Bash command the sandbox can contain runs with
  no prompt at all, because the boundary has replaced the question. The allowlist stops being a list
  of blessed commands to maintain and becomes a small set of exceptions. Fewer prompts means each
  surviving prompt is still read, which is the only real defence against reflexive tapping.
- **Secrets (§8).** `Read`/`Edit` deny rules apply to Claude's file tools and to Bash file commands
  Claude Code recognises such as `cat` and `sed`. They explicitly **do not** apply to a Python or Node
  script that opens the file itself. `sandbox.credentials` does, because it is enforced by the kernel.
- **Self-widening.** The sandbox denies writes to Claude Code's `settings.json` at every scope, so a
  session cannot edit its own permissions. Our `♾️ Always` path still can, because the Bridge writes
  that file from outside the sandbox. That asymmetry is exactly the one we want.

**What actually covers each of those on Windows.** Honestly: the first two are mitigated, not solved.

| Problem | Windows-native answer | Honest gap |
|---|---|---|
| Approval fatigue | The §6.2 allowlist has to carry the whole load again, so it must be broader and is therefore maintained rather than incidental. The prompts-per-hour metric (§10.3) stops being a nice-to-have and becomes the instrument that tells you whether the list is right | A broad `Bash` allowlist is exactly what the sandbox existed to avoid. An allowed `npm test` can do anything a shell can |
| Secrets | `deny` rules on `Read`/`Edit` for `~/.ssh`, `~/.aws`, `$STATE`, plus **keeping the bot tokens out of the sessions' reach by location** rather than by rule: `%APPDATA%\aibridge\.env` is outside every worktree, and the Bridge passes the channel server what it needs over the pipe rather than through the environment | **Not closed.** A Python or Node script written by the session reads those files regardless of any deny rule. This is the single biggest security delta versus WSL2, and §8.3 records it as accepted-with-eyes-open rather than mitigated |
| Self-widening | Generated per-session settings live under `$STATE`, not in the worktree, and `deny` rules cover `Write`/`Edit` against that path | Same subprocess gap as above |
| Network egress | Nothing | Nothing. No allowlist, no filtering |

The compensating control that does hold, and holds independently of all of this, is that
**`guard-git-write.ps1` runs natively and unmodified** (§7.3). The two hard blocks that matter most to
a remote operator - commit on `main`, and `--no-verify` - are `exit 2` refusals enforced by a hook, not
by a permission rule, and a subprocess cannot route around a hook that fires before the tool runs.

**Verdict.** Windows-native is the right host for Phases 1-5 because those phases are about proving the
protocol, the feed and the button paths, none of which the sandbox touches. It is **not** the right
host for unattended overnight running, which is what Phase 6 and §7.6 are for. Do not let the fleet
drift into unattended use on Windows just because the earlier phases worked.

#### 6.7.2 The WSL2 configuration, held for Phase 6

Everything below applies only after §7.6. Recorded now so the migration is a config change rather than
a research task.

**Configuration**, merged into the generated per-session settings:

```jsonc
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,          // never silently fall back to unsandboxed
    "allowUnsandboxedCommands": true,   // retry allowed, but gated - see below
    "network": {
      "allowedDomains": ["github.com", "*.githubusercontent.com",
                         "registry.npmjs.org", "api.nuget.org", "*.nuget.org"]
    },
    "credentials": {
      "files": [
        { "path": "~/.ssh", "mode": "deny" },
        { "path": "~/.aws/credentials", "mode": "deny" },
        { "path": "~/.config/aibridge", "mode": "deny" }   // the bot tokens
      ]
    }
  }
}
```

`allowedDomains` must be pre-populated rather than left to prompt on first use: no domains are allowed
by default, and an unattended fleet discovering that one package registry at a time from a phone is
precisely the prompt storm we are trying to avoid. The last `credentials` entry is the one a reader
might not think of - a session that could read `~/.config/aibridge/.env` could post to the fleet as the
bot.

**The escape hatch is gated, not removed.** When a command fails under the sandbox, Claude may retry
it with `dangerouslyDisableSandbox`. Strict mode (`allowUnsandboxedCommands: false`) forbids that
entirely, which is the right setting for a machine nobody is watching and the wrong one here: a
legitimately-blocked command would simply fail, and a phone operator has no way to unblock it. The
better shape uses the same mechanism as everything else in §6.2:

```jsonc
"ask": ["Bash(dangerouslyDisableSandbox:true)"]
```

That rule is documented for exactly this purpose. The retry becomes a Telegram button rather than
either a silent escalation or a dead end, and the operator sees *which* command wanted out of the
sandbox before deciding. Safety is unchanged; recoverability is much better.

**Consequences to accept:**

- **`failIfUnavailable: true` means a missing `bubblewrap` stops the session starting.** That is the
  right failure for unattended work, but it makes the two packages a hard prerequisite (P-1), not a
  nice-to-have. On Ubuntu 24.04 and later, `bubblewrap` also needs an AppArmor profile before it can
  create user namespaces; the check is `sysctl kernel.apparmor_restrict_unprivileged_userns`.
- **Sandboxed commands cannot launch Windows binaries or reach `/mnt/c/`.** WSL hands those to the
  Windows host over a Unix socket, which the sandbox blocks. This is the constraint that makes the
  Phase 6 migration a genuine move rather than a toggle: it forces working copies onto ext4 (§7.6),
  and it means `guard-git-write.ps1` cannot be invoked at all from a sandboxed command, which is why
  the bash port reappears as a Phase 6 prerequisite after being deleted for Phases 1-5.
- **Worktrees are supported by design.** When the working directory is a linked worktree the sandbox
  additionally permits writes to the shared `.git` directory so `git commit` can update refs, while
  keeping `hooks/` and `config` denied. The §2.3 session model and the sandbox were built for each
  other.
- **Network filtering is hostname-based and does not inspect TLS.** A broad allowed domain remains an
  exfiltration path. Keep the list short; this is a residual, recorded in §8.3.
- **`docker` and `watchman` are incompatible** with the sandbox. Neither is used by aibridge itself,
  and SeoWrite - the first registered repo - is explicit in its own `CLAUDE.md` that Docker is not
  used there either, so the `excludedCommands` escape hatch stays empty for that repo, which is the
  safest state for it. A future registered repo that does depend on Docker or watchman would need its
  own assessment here; this is a per-repo fact, not a property of aibridge.

**Settings found after this section was first written**, to be evaluated during the Phase 6 migration
rather than adopted sight-unseen. The block above predates them and is not wrong, but it is no longer
complete:

| Setting | Min version | Why it may matter here |
|---|---|---|
| `network.strictAllowlist` | v2.1.219 | Denies an out-of-allowlist domain instead of prompting. For an unattended fleet a silent deny is very likely the correct behaviour, since nobody is there to answer |
| `network.tlsTerminate` | v2.1.199 | Prerequisite for credential `mask` mode |
| `credentials` `mask` + `injectHosts` | v2.1.199 | Lets a token reach a specific host without the session ever reading it. Strictly better than `deny` for the fleet SSH/push path if it works as documented |
| `sandbox.filesystem.disabled` | v2.1.216 | Drops filesystem isolation but keeps network isolation. A middle setting worth knowing exists; not the default we want |
| `allowManagedReadPathsOnly`, `allowManagedDomainsOnly` | - | Prevent a session-level setting from widening a managed one. Relevant only if the generated per-session settings ever stop being fully Bridge-owned |

---

## 7. Running on Windows

**Host decision, revised 2026-08-02.** Earlier passes targeted WSL2. The host is now **native
Windows for Phases 1-5**, with WSL2 held as the Phase 6 move for unattended operation (§7.6).

The reasoning, briefly, because it reverses a previously "decided" item and should not be silently
inherited. Claude Code, Bun/Node, the Bridge, the channel server and the hooks all run natively on
Windows; this was confirmed against **2.1.220** on the target machine, including that both channel
flags are live (§2.4). Exactly one capability is Windows-unavailable: the OS-level sandbox (§6.7).
Against that single loss, Windows-native removes a from-scratch WSL2 install and a reboot (the WSL,
VirtualMachinePlatform and Hyper-V features are all **Disabled** on this machine today), removes the
`/mnt/c` boundary and the second clone it forces, and - for a registered repo like SeoWrite that
already carries a PowerShell guard hook - removes any need to port it to bash, because
`guard-git-write.ps1` already runs as-is. Phases 1-5 prove protocol, feed and buttons, and the sandbox
is irrelevant to all three. Phase 6 is where it starts to matter, and that is where the migration sits.

### 7.1 The filesystem: no boundary at all

Working copies live where each registered repo's clone already lives, on NTFS. SeoWrite's registered
clone, for example, is `c:\data\projects\seowrite`; worktrees for any registered repo are cut into
`c:\data\worktrees\<slug>`, since the slug is already unique across the whole fleet regardless of
which repo it belongs to (§4.3).

This is the largest single simplification the host change buys. Under WSL2 the fleet would have worked
on a *different clone* from the Windows-side VS Code checkout, synchronising through the git remote
rather than the filesystem, because ext4 was mandatory for performance and (with the sandbox on)
`/mnt/c` was not merely slow but unreachable. That whole problem disappears: a worktree created from
the phone is visible in VS Code immediately, and `git worktree list` in the everyday clone shows the
fleet.

Two Windows-specific costs to accept:

- **Defender real-time scanning** on `c:\data\worktrees` will slow `dotnet build` and `npm ci`
  noticeably across four concurrent sessions. Add a Defender exclusion for the worktree root as part of
  P-1. This is the Windows analogue of the 9p problem, and it is one settings change rather than a
  second clone.
- **Path length.** Deep `node_modules` under `c:\data\worktrees\<slug>\angular` can approach the 260
  character limit. Keep slugs short (the routing table already generates them) and enable
  `LongPathsEnabled`.

### 7.2 Autostart and supervision

1. The Bridge runs as a **Task Scheduler** task, trigger *At log on* for the operator account, action
   `bun run <bridge>`, with *If the task fails, restart every 1 minute, up to 99 times*. That pair is
   the Windows equivalent of `Restart=always`.
2. Uncheck *Stop the task if it runs longer than*, which defaults to 3 days and would otherwise kill
   the fleet without explanation on the fourth day.
3. Check *Run with highest privileges* only if it proves necessary; it should not be.
4. Session PTYs are children of the Bridge, so there is nothing else to start. A Bridge restart does
   **not** kill running sessions if they are spawned detached, and §2.5's reconnect logic exists
   precisely so they survive it.
5. **`/restart`'s self-respawn must re-trigger this same task (`schtasks /Run`), not raw-spawn a
   successor.** A scheduled task's process runs inside a Windows Job Object; a plain detached
   `child_process.spawn` successor is killed the instant the Task-Scheduler-tracked parent exits,
   silently, before it finishes starting. This also needs the task's `MultipleInstances` policy set to
   `Parallel` (schtasks' own default, `IgnoreNew`, drops the re-trigger while the dying old instance is
   still marked "Running"). Both live-verified 2026-08-06 (0.59.0) - see that changelog entry for the
   full failure mode. `/autostart install` sets this and point 2's time limit automatically now.

**The one honest gap: this starts at logon, not at boot.** After a reboot the machine must reach a
logged-in desktop session before the bot answers. The alternatives are worse than the gap: *Run whether
user is logged on or not* puts the task in session 0, where ConPTY behaviour is not something this plan
should assume and where the Claude Code credential store in the user profile may not resolve. Options,
in order: accept it and reboot deliberately; or enable autologon with the workstation locked
immediately afterwards. **Verification item, not a design decision** - §13 check 1 measures it.

**A remote `/reboot` command (OS-level, distinct from `/restart`'s Bridge-process-only restart) was
considered and deliberately deferred (0.57.0) - not built.** It would only help in the narrow band where
Windows is degraded but still responsive enough to receive the command at all; a genuine hang defeats it
the same way it defeats every other Telegram command, which is the scenario it would most want to cover.
If built, it must gate on a read-only autologon precondition check first (`AutoAdminLogon` in
`HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`) - autologon is what stands between a
remote reboot and stranding the whole fleet with nobody logged in to re-trigger this section's logon
task. Revisit only once a real incident (not a hypothetical) needs it.

### 7.3 A target repo's own guard hook needs no work from aibridge

This section previously described a bash port as a Phase 2 blocker, back when this plan lived inside
the one repo it controlled. That framing does not survive the move to a standalone tool: aibridge does
not own, port, or maintain any target repo's hooks at all. Whatever a registered repo puts in its own
`.claude/settings.json` - a `PreToolUse` guard, or nothing - runs natively from that worktree's own
config, exactly as it would in a desk session, because that is simply how Claude Code loads hooks (from
the working directory's `.claude/`). On a Windows host there is additionally no bash-port question for
a PowerShell hook specifically, because `powershell.exe` is directly reachable; that stops being true
only once a *sandboxed* WSL2 command is involved (§7.6), which is again the target repo's own hook's
problem to solve, not aibridge's.

**Worked example: SeoWrite's `.claude/hooks/guard-git-write.ps1`.** SeoWrite (the first repo registered
against this design) carries a guard hook that matters independently of the Telegram approval path:
§6.1.1 moved approval onto an `ask` rule that needs no hook, but that hook's protected-branch and
`--no-verify` hard blocks are `exit 2` blocks with no settings equivalent. An `ask` rule can turn a commit into a button; nothing turns
"HEAD is on `main`" or "this command carries `--no-verify`" into a button, and those are the two
failures a remote operator is least able to catch by reading a prompt on a phone. Where a registered
repo has a hook like this, it remains the strongest guarantee in the whole system; where it does not,
there is no equivalent and the `ask` rules in §6.2 are the only gate.

**What must still be verified for any such hook**, because "it already works" is an assumption until
tested from this path specifically: that the hook fires for a session launched by the Bridge with a
generated `--settings` file. Settings precedence and hook merging across a `--settings` override plus
the worktree's own `.claude/settings.json` is the risk, not the hook's own logic. Scenarios 11-12 and
§13 check 5 exercise this against SeoWrite's hook as the concrete case in hand.

For the record, since it is a useful illustration of why a hook like this is real code with real edge
cases rather than something worth reimplementing generically, four behaviours in SeoWrite's script are
load-bearing there and each is a silent-wrong risk if a repo's hook drops the equivalent:

- **Positional subcommand matching.** `commit`/`push` must be the actual subcommand, not any word
  after `git`. An earlier version of that hook engaged on `git log --grep=commit`, and prompts on reads
  train the reflex the guard depends on being deliberate.
- **Heredoc stripping** before scanning. `gh pr create --body "$(cat <<'EOF' … EOF)"` routinely quotes
  a git command, and under a hard block a false positive is a refusal - documenting this very rule in
  a PR body would refuse to open the PR.
- **The `-n` asymmetry.** On `commit` it is short for `--no-verify` and must block; on `push` it means
  `--dry-run` and must stay allowed.
- **Every `git` occurrence examined**, not just the first, so `git log && git push` and `xargs git push`
  are caught.

That behaviour is pinned by SeoWrite's own test suite, which is that repo's responsibility, not
aibridge's - aibridge has no test asserting the *content* of any target repo's hook, only that its own
generated `--settings` file does not suppress one (scenarios 11-12).

Scope note, again specific to SeoWrite's hook and recorded only as an example of the kind of gap a
guard hook can have: it deliberately does **not** catch `git push origin main` issued from a feature
branch, because parsing refspecs out of shell text would mean refusing any command whose prose quotes
a push to main. That repo closes the gap in its own `.githooks/pre-push`, which git hands the resolved
refs on stdin - a second, independent compensating control that again belongs to the target repo, not
to aibridge.

**This plan therefore touches no file in any target repo at all.** Everything the Bridge builds is new
files under its own state directory (§7.5); a target repo's hooks, tests and pre-push checks are that
repo's property, read but never written.

### 7.4 Sleep, resume and clock jumps

When the laptop sleeps, sessions freeze and polling stops. Telegram queues updates for **24 hours**, so
on resume the Bridge receives a backlog burst. It must:

- Process backlog in order but **collapse duplicate commands** (three impatient `/ls` taps produce one
  reply).
- Treat any inbound message older than 30 minutes as stale: acknowledge it with "received while
  offline, still want this?" rather than acting on it. Acting on a two-hour-old "yes, push it" is the
  kind of surprise this design must not produce.
- Use a monotonic clock for all timers. Wall-clock deltas across a suspend produce instant expiry of
  every pending prompt, which would look like mass silent denials.

This is inherent to running on a laptop and is **unchanged by the host decision** - Windows sleeps
exactly as WSL2 did, and modern standby can suspend the machine without the lid closing. Two Windows
specifics: the monotonic source is `QueryUnbiasedInterruptTime` semantics (Node's
`process.hrtime.bigint()` is backed by `QueryPerformanceCounter`, which **does** advance across modern
standby, so verify rather than assume), and `powercfg /requests` is the tool for finding out why the
machine did or did not sleep during a long unattended run. §11 records the VPS escape hatch.

### 7.5 Repos, credentials and auth

The plan has said "create a worktree" since v0.1.0 without ever saying from what, using whose
credentials, or as which authenticated user. All three are silent-failure-at-3am material, and none of
them is hard once written down.

**The repo registry.** `/new <repo> …` takes a short name, not a path. The Bridge keeps a registry in
`$STATE\repos.toml` mapping name to an existing clone, and this is the whole mechanism for reuse across
projects: switching from Telegram means picking a different `<repo>` key, not re-deploying anything.

```toml
[seowrite]
path   = 'c:\data\projects\seowrite'       # the everyday clone - no second copy (§7.1)
base   = "main"
model  = "sonnet"                          # optional per-repo default (§10.5)

[somethingelse]
path   = 'c:\data\projects\somethingelse'
base   = "main"
model  = "sonnet"
```

An unregistered name is refused with the list, rather than the Bridge guessing a path. Worktrees are
cut from that clone into `c:\data\worktrees\<slug>`, so `git worktree list` in the clone is a second,
independent view of the fleet during reconciliation (§4.5) - and, on Windows, one the operator can run
in their own terminal against the same clone they already work in. There is one Bridge, one Telegram
supergroup and one topic-per-session model shared across every registered repo; `repos.toml` is the
only place a project's identity is recorded, and adding a second project is editing that file, not
touching any code path in this plan.

`$STATE` is `%LOCALAPPDATA%\aibridge`. Configuration and secrets are `%APPDATA%\aibridge`, kept separate
because the first is disposable and the second is not.

**Git credentials for push.** A commit needs nothing; a push needs an identity, and this is the one
place the design genuinely requires a secret to be reachable by the session. The resolution:

- **SSH, not HTTPS tokens**, with a key dedicated to this fleet rather than the owner's everyday key,
  so it can be revoked without collateral damage. Revocability is doing more work here than it would
  under WSL2: with a sandbox, `~/.ssh` is denied to the session while `ssh` still authenticates through
  the agent, so the key is unreadable by design (§6.7.2). **On Windows that guarantee does not exist** -
  a script the session writes can read `%USERPROFILE%\.ssh` regardless of any `deny` rule. A dedicated,
  separately revocable key is therefore the control rather than a defence-in-depth extra.
- The **OpenSSH Authentication Agent** service (`ssh-agent`, set to Automatic) holds the key, so it is
  unlocked once per boot rather than per session, and the private key file itself need not be read by
  anything during normal operation.
- `user.name` and `user.email` set in the clone, because a worktree inherits them and a commit with a
  broken identity fails the repo's own hooks.

**Claude Code auth.** `claude` must be logged in as the account the Bridge runs as before any of this
works, and the
login is interactive and browser-based. It happens once, by hand, in P-1. Worth calling out because
the failure mode is every session in the fleet dying instantly at first launch with an auth error,
which from a phone reads as "the whole thing is broken".

**Any target repo's own hooks come along for free.** A worktree of a registered repo carries whatever
`.claude/settings.json` that repo has - for SeoWrite, that means `guard-git-write.ps1` and the rest
load from the worktree's own `.claude/` directory, natively and unmodified (§7.3). Hooks load from the
working directory's `.claude/`, with no parent-directory fallback, which a worktree satisfies exactly,
and this holds for any repo registered in `repos.toml`, not only the first one.

### 7.6 The WSL2 migration, held for Phase 6

Windows-native is the right host for building this and the wrong host for leaving it running
unattended overnight, because it has no sandbox (§6.7). This section is the migration, written down now
so that Phase 6 is a checklist rather than a fresh investigation.

**What triggers it.** Any one of: wanting genuinely unattended overnight runs; the prompts-per-hour
metric (§10.3) showing the allowlist has had to grow broad enough to be uncomfortable; or registering a
repo less well-understood than SeoWrite (the pilot project), where the blast radius of a given
allowlist entry has not been assessed the way §10.4.1 assesses SeoWrite's.

**Candidate to evaluate here, not before:** Claude Code's `auto` permission mode (a fifth mode alongside
the four §6.1 already accounts for) - a server-side classifier that reviews actions in place of most
permission prompts, with its own hardcoded deny-list (force-push, prod deploys/destroys, secret
exfiltration, disabling CI, `curl|bash`, and more) independent of the session's settings.json. It did
not exist when §6 was written and is not evaluated anywhere in this plan. It might shrink the
hand-maintained §6.2 `ask`/`allow` lists, since its built-in denials overlap the category those lists
exist to catch - but it raises the same "verified, not inferred" question §6.1.1 already had to answer
once for the guard-hook precedence: does a classifier denial reach the Telegram feed the way a §6.3
permission escalation does, or does it fail silently mid-session? Does it fight the `AskUserQuestion`
hook (§6.4)? Untested. Requires Sonnet/Opus 4.6+ (met by the models in use as of 2026-08-08) and needs a
real headless probe against a running session before any of this plan's other sections cite it as fact
- there is no walking skeleton to probe it against yet (Phase 1), which is why this is a pointer for
Phase 6b's design pass, not a decision made now.

**What the migration costs**, in dependency order:

1. **A reboot.** `Microsoft-Windows-Subsystem-Linux`, `VirtualMachinePlatform` and every Hyper-V
   feature are **Disabled** on this machine as of 2026-08-02. The hardware is not the obstacle
   (Core Ultra 7 255H, `VirtualizationFirmwareEnabled: True`, SLAT present, 24 GB RAM, 143 GB free);
   the reboot is. This is why it is not a Phase 1 prerequisite.
2. **Sandbox dependencies:** `bubblewrap`, `socat`, and `@anthropic-ai/sandbox-runtime` for the seccomp
   filter, with `/sandbox` showing no Dependencies tab. The check runs at startup, so Claude Code must
   be restarted after installing. On Ubuntu 24.04+, apply the `bwrap` AppArmor profile if
   `sysctl kernel.apparmor_restrict_unprivileged_userns` returns 1.
3. **A bash port of any target repo's PowerShell guard hook**, e.g. SeoWrite's would need
   `guard-git-write.sh` at parity with `guard-git-write.ps1` and pinned by that repo's own test suite
   (`test_claude_hook_guards`), because a sandboxed command cannot invoke `powershell.exe` at all. This
   is the target repo's own porting work, not aibridge's, but it is a real prerequisite for that repo's
   hard blocks (§7.3) to keep holding once its worktrees run sandboxed - not something Phase 6b can
   silently skip on the assumption the PowerShell version still applies. The four load-bearing
   behaviours listed in §7.3 for SeoWrite's hook are the parity spec any such port needs to meet.
4. **A second clone on ext4**, because `/mnt/c` is unreachable from a sandboxed command. This is the
   ergonomic cost §7.1 currently avoids: the fleet stops sharing a working tree with VS Code and
   synchronises through the git remote instead.
5. **systemd instead of Task Scheduler:** `[boot] systemd=true` in `/etc/wsl.conf`,
   `loginctl enable-linger`, an `aibridge.service` with `Restart=always`, plus a Windows Task
   Scheduler task at logon running `wsl.exe -d <distro> -u <user> -e /bin/true` to boot the distro.
   Without that last step nothing starts until a terminal is opened.
6. **`ssh-agent` under the systemd user session**, and a fresh interactive `claude` login as the WSL2
   user.

**What does not change**, which is the point of the choices made in Phases 1-5: the Bridge, the channel
server, the hook client, the feed renderer, the routing table and the socket protocol are all
platform-neutral. `node-pty` works on both (§2.3), so the session model is untouched, and Node's `net`
abstracts the named pipe to a unix socket in one line (§2.5). **The migration is configuration plus one
bash script, not a rewrite**, and keeping it that way is a design constraint on everything built before
it.

---

## 8. Security

### 8.1 Threat model in one sentence

Anyone who can send a message the Bridge accepts can execute arbitrary code on the developer's machine,
because that is precisely what the system is for.

### 8.2 Controls

| Control | Detail |
|---|---|
| **Sender gating** | Allowlist on `message.from.id`, checked **before** anything is emitted. Never on `chat.id` or `message_thread_id`: in a group those differ, and gating on the room lets any group member inject. Non-allowlisted messages are dropped silently, never answered |
| **Topic gating** | The topic must also exist in the routing table. Sender allowlist and topic binding are both required |
| **Pairing bootstrap** | First contact returns a 6-character code drawn from the same `[a-km-z0-9]` alphabet as a permission `request_id` (§6.3) - no ambiguous characters on a phone screen - single-use and expiring after 10 minutes; the operator runs `/pair <code>` from the local terminal. Modelled on the official plugin |
| **Untrusted relay text** | `description` and `input_preview` are attacker-influenced. Clients before v2.1.211 do not sanitize them at all. The Bridge escapes them for HTML parse mode, strips bidi overrides and zero-width characters, folds whitespace, truncates to 500 chars in the prompt, and **always renders them inside `<pre>`**. They never reach a parse mode that could forge a button or a fake "✅ approved by system" line |
| **Callback authenticity** | Every `callback_query` is re-checked against the sender allowlist. Telegram callbacks carry the tapping user, and in a group that need not be the operator |
| **Denylist is not overridable** | `permissions.deny` entries cannot be lifted by an `♾️ Always` tap. The button path can only add to `allow`, and `deny` wins in Claude Code's precedence |
| **Secrets** | Both bot tokens in `~/.config/aibridge/.env`, mode `0600`, never in a worktree, never in any target repo. `Read(.env)` and (as of 0.64.0) the whole home directory (`Read(~/**)`/`Edit(~/**)`, `settings.ts`) are denied so a session cannot read credentials and hand them to Claude, which would put them in a transcript |
| **Secrets, actually enforced** | The row above is necessary and insufficient. Read and Edit deny rules cover Claude's file tools and the Bash file commands Claude Code recognises (`cat`, `head`, `tail`, `sed`); they explicitly do **not** cover an arbitrary subprocess that opens the file itself, so a three-line Python script walks past them. `sandbox.credentials.files` (§6.7) is the kernel-enforced version and is the control that actually holds. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips Anthropic and cloud credentials from every subprocess regardless of sandboxing, and is set for all sessions |
| **Output-side secret scrubbing** *(0.64.0)* | The row above still can't stop a subprocess-read secret from reaching Telegram once Claude quotes it in a reply - the deny rules bind Claude's tools, not what it says. `secret-scrub.ts` is the chokepoint that holds regardless: every `reply` and `send_file` caption is pattern-matched (PEM key blocks, AWS access key ids, GitHub tokens, `.env`-shaped `KEY=`/`SECRET=`/`TOKEN=`/`PASSWORD=` lines) and redacted before `pipe-server.ts` sends it, no matter how the text was produced upstream |
| **Telegram account is the perimeter** | 2FA on the Telegram account is mandatory, not advisory. The bot token grants full control of the fleet; treat it as an SSH key |

### 8.3 Accepted residual risks

- **Prompt injection through repository content.** A malicious string in a file Claude reads can try to
  steer it. The allowlist limits blast radius (a poisoned instruction still needs an approved tool),
  but does not eliminate it. This risk already exists for local Claude Code use; Telegram control does
  not increase it, but it does reduce the operator's attention per action.
- **Approval fatigue.** The failure mode of any button-gated system is tapping Allow reflexively. §6.2's
  allowlist exists to keep prompt volume low enough that each prompt is still read.
- **Transcripts on disk.** Session transcripts live in `~/.claude/projects/…` and contain whatever
  Claude read. Nothing here changes that, and the denylist keeps the worst material out.
- **No OS-enforced containment before Phase 6b.** The largest accepted risk on the Windows host, and
  the direct cost of decision 1. A script the session writes reads any file the operator can,
  including `%USERPROFILE%\.ssh` and `%APPDATA%\aibridge\.env`, and there is no network egress control at
  all; the §6.2 `deny` rules bind Claude's own tools and nothing else. Accepted for Phases 1-5 because
  the operator is present and the two `exit 2` guard layers still hold, **not** accepted for
  unattended running. Full treatment in §10.4.1; the migration that closes it is §7.6.
- **TLS is not inspected** *(applies from Phase 6b, when the sandbox proxy exists at all)*. The proxy
  allows or blocks on the client-supplied hostname without terminating TLS, so a broad allowed domain
  such as `github.com` remains a viable exfiltration path, including via domain fronting. The
  mitigation is a short `allowedDomains` list, not a stronger proxy; a custom TLS-terminating proxy is
  out of scope for a single-operator setup. Evaluate `network.strictAllowlist` at the migration
  (§6.7.2).
- **Two tokens, two blast radii.** The feed bot is send-only and never receives updates, so a leak of
  the feed token yields the ability to post noise into one group. The control token is the fleet.
  Rotating them is independent, and the compromise drill in §13 targets the control token.

---

## 9. Testing

aibridge's own testing convention: tooling code must unit-test any helper whose failure mode is
**silent-wrong** rather than a loud abort, plus every exit-code or protocol contract another component
branches on. Framework: `bun test`. Gate: `bun test` in the package's CI job, plus `tsc --noEmit`.

**aibridge's own logging convention.** The Bridge's own operational log - distinct from the
Telegram-facing feed in §5, which is fully specified there - uses three levels: `ERROR` for anything
that strands a pending operator-facing prompt or drops a message the operator needed to see (an
exhausted-retry P0 send per §5.4, a crashed reconciliation pass); `WARN` for degraded-but-recovering
conditions already named elsewhere in this plan (a 429 pause, a version-skew connection, a coalescing
quiet-mode trigger); `INFO` for ordinary lifecycle events (session start/stop, topic create, Bridge
start/restart). Nothing above `INFO` may contain a bot token, a git credential, or full tool input -
the same exclusion §5.7 already applies to telemetry.

Everything below is silent-wrong by nature: a dropped meta key, a mis-derived permission rule and a
mis-parsed verdict all produce a system that appears to work.

### Protocol contract

1. **Meta keys survive.** A payload with keys `topic_id`, `msg_id`, `from` produces a `<channel>` tag
   carrying all three. Unit, `channel/notify.test.ts`. Maps to: inbound routing works.
2. **Hyphenated meta keys are rejected at build time.** The meta builder throws on any key outside
   `[A-Za-z0-9_]` rather than letting Claude Code drop it silently. Unit. This is the specific
   silent-wrong the docs warn about.
3. **Capability declaration is exact.** The constructed `Server` declares `claude/channel`,
   `claude/channel/permission` and `tools`. Snapshot test, so a refactor cannot quietly drop the
   permission capability and disable all remote approval.
4. **Verdict notification shape.** `{ request_id, behavior }` with `behavior` strictly `allow` or
   `deny`. Any other value throws. Unit.

### Permission logic

5. **Verdict routes to the right pending request.** Two concurrent prompts in different sessions; a
   verdict for one does not resolve the other. Unit against the pending registry.
6. **Unknown `request_id` is a no-op**, not a crash and not a wildcard resolve. Unit.
7. **Expired `request_id` is refused** even if the letters match a newer request. Unit with an injected
   monotonic clock.
8. **Rule derivation from `Bash`.** `git commit -m "x"` derives `Bash(git commit *)`;
   `npm run build` derives `Bash(npm run *)`. Table-driven unit test. This is the highest-consequence
   silent-wrong in the system: an over-broad derived rule permanently widens the allowlist.
9. **Metacharacter commands never derive a rule.** `cat x | sh`, `a && b`, `$(curl …)` all fall back to
   allow-once. Table-driven unit. Includes the `Bash(git diff *)` versus `Bash(git diff*)` spacing case.
10. **Denylist beats an `Always` tap**, and so does the ask list. Tapping Always on a denied or asked
    pattern adds no allow rule. Unit.
11. **The generated settings put `git` writes in `ask`, not merely outside `allow`.** Schema assertion
    on the generator output: `Bash(git commit *)` and `Bash(git push *)` appear in `permissions.ask`,
    and no bare `Bash` entry appears there (a bare ask rule is skipped for sandboxed commands, §6.1.1).
    Unit on the generator. This is the assertion that decision 3 survives a refactor.
12. **Generated path rules use safe anchors and canonical names.** No rule uses a single leading
    slash; every path rule is `~/`-anchored, `//`-anchored or a bare gitignore-style name; no rule
    names `Write(path)`, `NotebookEdit(path)` or `Glob(path)`; every tool name is in the canonical
    list. Table-driven unit on the generator, because each of these is accepted silently and never
    matches.
13. **Bash/PowerShell guard parity - a target-repo test, not aibridge's own.** This scenario documents
    what a registered repo's own test suite should assert if it ports its guard hook, not something
    aibridge runs itself: the same table of command strings should produce identical decisions from
    both implementations (positional matching, heredoc stripping, the `-n` asymmetry, multiple `git`
    occurrences). For SeoWrite this lives in `test_claude_hook_guards` in that repo's own
    `scripts/test/test-install-helpers.py`, which treats a **skip as a failure when `CI` is set**, so a
    port that quietly stops being exercised fails loudly there. aibridge's own Phase 2 gate is scenarios
    11-12 (its generated `--settings` file does not suppress whatever hook a target repo has), not this
    one.

### Feed and rate limiting

14. **Coalescing scales with session count.** 50 events in 1 second produce at most one
    `editMessageText`. With 4 active sessions the per-session interval is 12s, and the aggregate P2
    call rate stays at or below 20/minute. Unit with a fake clock, asserting the aggregate - the
    per-session assertion alone would pass while the budget is 4x overrun.
15. **The two token buckets are independent.** Saturating the feed bot does not delay a P0 prompt on
    the control bot by a single tick. Unit against the governor. This is the property that justifies
    the second token, so it is asserted rather than assumed.
16. **P2 drops before P0.** Within the control bot's bucket, a queued permission prompt is sent and a
    lifecycle notice is deferred; within the feed bot's, an edit is discarded rather than queued.
    Unit.
17. **`answerCallbackQuery` is metered.** A button tap consumes a control-bot token. Unit - it is easy
    to forget that a call which sends no message still counts.
18. **`429` handling.** A `retry_after: 7` response pauses **that token's** governor for 7s, leaves the
    other running, and does not retry the P2 edit. Unit with a stub transport.
19. **Prompt reconciliation is exact.** With the `PermissionRequest` observer paired to the relay
    request, a `PostToolUse` for that `tool_use_id` resolves the right prompt while a second concurrent
    same-tool prompt stays live. Unit. Also covers the degraded path: if the observer event never
    arrives, fall back to `(session_id, tool_name, arrival order)` and prefer resolved over live.
20. **Turn card overflow.** 40 activity lines render 8 plus an accurate "…and 32 earlier steps" counter,
    and the full log is retrievable. Unit on the renderer.
21. **Untrusted-text escaping.** `input_preview` containing `</pre><b>approved</b>`, a bidi override,
    and a zero-width joiner renders inert. Unit, with the malicious strings as fixtures.
22. **`AskUserQuestion` round trip.** The hook returns `permissionDecision: "allow"` plus an
    `updatedInput` that echoes the `questions` array verbatim and adds an `answers` object keyed by
    question text. Schema assertion against a captured real payload; a malformed echo is silently
    ignored by Claude Code, which is the failure this catches.
23. **Question timeout cancels rather than answers.** At the configured ceiling the hook returns
    `deny` with a reason and the keyboard is stripped. Unit with an injected clock, asserting
    specifically that no option was auto-selected.

### Lifecycle

24. **Reconciliation matrix.** Each of the five §4.5 rows, against a seeded DB plus a stubbed process
    table and Telegram client. Unit. Include the partial-re-adoption case: a live `pty_pid` whose PTY
    handle the Bridge no longer owns must be adopted as a session and reported as terminal-detached,
    not marked dead and not double-spawned.
25. **Stale inbound after resume.** A message with a 2-hour-old timestamp is confirmed, not executed.
    Unit with an injected clock.
26. **Monotonic timers survive a clock jump.** Advancing wall-clock by 3 hours does not expire pending
    prompts. Unit.
27. **Slug uniqueness and sanitisation.** Prompts producing identical or path-unsafe slugs get distinct,
    safe worktree paths. Unit.
28. **Launch pre-config is written before the process starts.** For a fresh worktree the Bridge writes
    `hasTrustDialogAccepted` into `~/.claude.json` and puts `AIBRIDGE_SLUG`/`AIBRIDGE_TOPIC` in the spawn `env`,
    and it does both before spawning `claude`. Unit against a stubbed PTY factory and a temp config;
    ordering is the whole assertion, because a late write produces a dialog nobody sees.

### Integration

29. **Walking skeleton, end to end.** Against a stub Telegram server: `/new` creates a topic, launches a
    session, an inbound message reaches Claude, and a `reply` lands in the right topic. This is the
    Phase 1 exit criterion. **Note the delivery direction is asymmetric, and this scenario's original
    wording assumed otherwise:** inbound does *not* travel over the channel notification path
    (`notifications/claude/channel`), which §10.1.2 abandoned live on 2026-08-03 - it is written
    straight into the PTY as a `<channel>`-tagged prompt. Outbound still goes through the channel's
    own `reply` MCP tool. Scenario 29a below is the piece that assumption was hiding.
29a. **Inbound arrives by PTY injection, not notification** (§10.1.2). `renderChannelTag(content,
    meta)` produces the tag Claude actually receives, and `index.ts` writes it and its trailing `\r`
    as **two separate** PTY writes - one write carrying both leaves the text sitting unsubmitted in
    the input box, since the TUI's bracketed-paste handling swallows an embedded Enter (found live,
    the same sitting). Assert both halves: the rendered tag's shape/escaping, and that the submit is
    a distinct write rather than part of the payload. The `\r`-as-separate-write rule is the kind of
    thing a future refactor "tidies" into one call, and the failure is silent - Claude simply never
    sees the message.
30. **Permission round trip, end to end.** A gated `Bash` call raises a prompt, a simulated tap sends
    the verdict, and the tool proceeds. Phase 2 exit criterion.

### Telemetry and budget

31. **Ask-rule precedence, as a regression fixture.** The §6.1.1 probe, promoted from a one-off to a
    test: control settings (hook `allow` plus an allow rule) run the command; treatment settings
    (identical plus one `ask` rule) do not. Asserted on a filesystem side effect, never on the model's
    own account of what it did. Integration, and the slowest test in the suite by far, which is
    justified because it is the one that proves a phone cannot commit unapproved. Runs on every client
    version bump (§10.1).
32. **Telemetry ingest, the burn alarm and the weighted budget.** Synthetic OTLP payloads carrying
    `claude_code.cost.usage` for two `session.id` values land against the right routing-table rows; a
    rolling 5-hour total crossing the threshold fires the alarm exactly once, not once per export
    interval. Unit with a fake clock. Also asserts that a `claude_code.api_error` event marks the
    session with the distinct quota-stop state rather than a generic `dead`, and that the unit
    arithmetic admits 4 Sonnet or 2 Opus and refuses 1 Opus plus 3 Sonnet.

### Plumbing

33. **Socket reconnect preserves the important messages.** With the Bridge stopped, a channel server
    queues a `reply` and 200 feed events; on reconnect the `reply` is delivered and the feed queue has
    been trimmed to 100 oldest-first. A blocked `ask` outstanding across the restart still receives its
    answer. Unit against a stubbed socket (§2.5).
34. **Protocol version skew degrades, never disconnects.** A client announcing an older `v` stays
    connected, its known message types still work, and only unrecognised types are refused. Unit.
35. **Command shim resolves against real files.** `/cmd review:pre-push` produces an instruction naming
    `.claude/commands/review/pre-push.md`; `/cmd nope` returns the available list and pushes nothing to
    the session. Unit against a temp command tree, because an instruction to read a nonexistent file is
    worse than an error.
36. **Attachment paths are safe and outside the worktree.** A document named `../../etc/passwd` lands
    in the session inbox under a sanitised name, and the announced path is inside
    `$STATE\sessions\<slug>\inbox\`. Unit, table-driven over hostile filenames. **DONE 2026-08-05** -
    `attachment-inbox.test.ts`'s `sanitizeAttachmentFilename`/`writeAttachmentToInbox` cases, including
    a POSIX and a Windows traversal prefix.
37. **Sessions survive Bridge death.** Spawn a session, kill the Bridge without cleanup, confirm the
    `claude` process is still alive and its channel server still running, then start a new Bridge and
    confirm it re-adopts per scenario 24. **Manual/integration, Phase 1** - this measures a ConPTY
    behaviour rather than our code, and the answer decides whether spawning needs Job Object handling
    (§4.5). Re-run on the §7.6 migration, where the primitives are entirely different.

38. **Channel liveness probe distinguishes blocked from idle.** With a stubbed session that never
    responds, the startup nonce probe times out and the control topic reports a message naming
    `channelsEnabled`; with a session that produces any hook event, the probe passes and no warning is
    posted. Unit with a fake clock. This is the test that would have saved the 2026-08-02 sitting from
    two false failures, and it is the only defence against a silent org-policy revocation (§10.1.1).
39. **`meta` hygiene.** The emitted notification carries no `source` key, every key matches
    `[A-Za-z0-9_]+`, and a `seq` is present and monotonic per session. Unit over the notification
    builder, because all three failures are silent at runtime (§3.2).
40. **`sessions.state` transitions match §4.3's table.** Each hook event drives the row to the
    documented next state and no other: `SessionStart` -> `idle`, `UserPromptSubmit` on an `idle` row
    -> `working`, a blocking `AskUserQuestion` or a relayed permission prompt -> `awaiting_input`, its
    resolution -> back to `working`, `Stop`/`StopFailure` -> `idle`, `SessionEnd` -> `dead`. Table-driven
    unit against a seeded row, asserting the one-step transition and rejecting any transition not in
    the table (e.g. `dead` never re-entering `working` directly).
41. **Non-429 send failures retry, then fail loud rather than vanish.** A stubbed transport that fails
    a P0 send 3 times exhausts the retry budget (1s/2s/4s), logs at `ERROR`, and leaves the pending
    permission request live rather than marking it delivered; the same stub failing a P2 edit is not
    retried at all. Unit with a fake clock and a stub transport (§5.4).
42. **`/model` writes the raw keystroke, not a channel message.** `/model opus` sent in a session's own
    topic calls the PTY write directly with `/model opus\r` and never calls `renderChannelTag` - assert
    against a stubbed PTY write, not the pipe. A name outside `sonnet|opus|haiku|fable` is rejected with
    the valid list and nothing is written to the PTY. Unit (§4.2.1).
43. **`/mode` computes the right number of Shift+Tab writes and tracks the result.** From a routing-table
    state of `manual`, `/mode auto` writes `\x1b[Z` exactly three times (§4.2.2's cycle order) and updates
    the tracked state to `auto`; a second `/mode auto` immediately after writes zero times, not three -
    the tracked state, not a fresh assumption of `manual`, is the source of truth for the next call. A
    name outside the four modes is rejected before anything is written. Unit against a stubbed PTY write
    and a seeded routing-table row, table-driven over every (current, target) pair in the cycle.
44. **`/restart` spawns a detached successor before exiting, and only from the control topic.** A
    session-topic `/restart` is rejected (fleet-scoped, not session-scoped, unlike `/model`/`/mode`); a
    control-topic `/restart` calls `spawn` with `detached: true` and the running process's own
    `process.argv`, then calls `process.exit` - assert the spawn call's arguments and that exit is
    called after it, not a real process kill (§4.5.1). Unit against a stubbed `spawn`.

Scenarios 29 and 30 need a **stub Telegram Bot API server** (a local HTTP server implementing
`getUpdates`, `sendMessage`, `editMessageText`, `createForumTopic` and `answerCallbackQuery`, for two
distinct tokens). Building it is part of Phase 1, not an afterthought: without it there is no way to
test any of this without a live bot and a phone in hand.

---

## 10. Risks

### 10.0 Inbound channel delivery: RESOLVED, proven end to end on 2026-08-02

**Kept at the top of §10 as the record of the one measurement the whole design rests on. It failed
twice, then passed once the cause was found. The cause was not the protocol.**

#### What the two failures actually were

A headless probe (8 events, 2 turns) and then an interactive probe (20 events, real TTY, client
**2.1.220**) both reported *"NONE RECEIVED"* with no error returned to the server. The earlier
hypothesis in this section - that headless mode does not run channel delivery - was **wrong**. The
interactive run falsified it.

The real cause: **`channelsEnabled` was unset on the claude.ai Team organisation.** Per the docs,
claude.ai Team and Enterprise block channels until an Owner enables them, and when blocked *"the MCP
server still connects and its tools work, but channel messages won't arrive."* That is an exact
description of both failures, and it is why the server saw a clean handshake and a served
`tools/list` while every push vanished.

The natural experiment that settled it, from one session's logs:

| Time | Event | Outcome |
|---|---|---|
| 11:32:10 | session starts, handshake OK, `tools/list` served | - |
| 11:32:13 - 11:35:23 | 20 `notifications/claude/channel` pushed | **all dropped silently** |
| ~11:36 | Owner enables Channels in the claude.ai admin console | - |
| 11:38:15 | `permission_request` relayed to the same running session | **delivered** |

The setting took effect on a **running** session, without a restart. A re-run with the setting on
delivered all 20 events.

#### What is now proven

- **Delivery works in all three positions**: in the initial context, injected *mid-turn while Claude
  was working* (16 events arrived batched as system notifications), and in the user-turn slot. Mid-work
  injection is what §5.2 depends on and it was previously only an assumption.
- **Claude acts on an event with no user turn.** The first event arrived and Claude called the `reply`
  tool unprompted. The design does not need a poke to wake a session.
- **The `meta` contract holds.** `routing_id`, `slug` and `hyphen_test` all survived as tag attributes.
- **`source` is reserved.** Claude Code sets it from the server name. The probe also passed `source` in
  `meta`, producing a malformed `<channel source="x" source="x" ...>` with the attribute duplicated.
  See §3.1: the Bridge must never put `source` in `meta`.
- **The `reply` tool is not a per-event acknowledgement.** Of 20 delivered events, Claude replied to
  **one**, then accurately recited all 20 when asked. Absence of a reply says nothing about delivery.
  See §6.2.

#### What this leaves behind

The dependency on `channelsEnabled` is not a resolved risk, it is a **new** one, and a sharper one
than research-preview churn: it is a managed setting that users cannot override, it is off by default
for Team and Enterprise, and turning it off drops events **silently** rather than erroring. See
§10.1.1.

The probe server (`scratchpad/sitting/`) is the seed of the Phase 1 walking skeleton.

### 10.1 Research-preview churn

The channel protocol is explicitly a research preview: "the `--channels` flag syntax and protocol
contract may change based on feedback." Custom channels are not on the allowlist, so every session must
launch with `--dangerously-load-development-channels`, which prints a **full-screen confirmation
dialog** the supervisor has to answer before the session is usable.

**Re-run the two-second flag check on every version bump**: `claude --dangerously-load-development-channels`
with no argument should report `argument missing` rather than `unknown option`. The flag being hidden
from `--help` means a removal would otherwise be discovered at the worst possible moment.

Consequences and mitigations:

- The confirm dialog must be handled at launch. Since the Bridge owns each session's PTY (§2.3), it
  writes the confirmation to stdin after detecting the prompt - a method call on a handle it already
  holds, rather than shelling out to `tmux send-keys`. This is the one place the design injects
  keystrokes, and it is confined to a single known prompt at a single known moment. There is
  no pre-accept flag; that gap is known and general, not specific to channels
  ([#52501](https://github.com/anthropics/claude-code/issues/52501)). The other two launch dialogs are
  eliminated by configuration rather than keystrokes (§2.4).
- **Version-pin Claude Code** and treat upgrades as a change requiring a protocol smoke test. Scenarios
  1, 3 and 4 form that smoke test. The pin matters more than usual here because several behaviours
  this plan depends on carry explicit minimum versions - relay-text sanitisation at v2.1.211, the
  `Write(path)` startup warning at v2.1.210, `sandbox.credentials` masking at v2.1.199 - and because
  the workspace-trust logic the launch path pre-accepts has changed twice recently under advisory.
- Isolate every protocol touchpoint behind `channel/protocol.ts` so a breaking change is one file.
- **The escape from the dev flag is self-service, not a wait on Anthropic.** Corrected 2026-08-02
  against the published docs: during the research preview, `--channels` accepts a plugin only from
  the Anthropic-maintained allowlist *or* from the org's own `allowedChannelPlugins` in managed
  settings - the same admin console, and the same Owner role, that already controls `channelsEnabled`
  (§10.1.1, §4.1). Once the channel server is packaged as a plugin in an org-owned marketplace, the
  Devitgroup Ltd admin can add an entry like `{"marketplace": "devitgroup-plugins", "plugin":
  "aibridge-telegram"}` to `allowedChannelPlugins`, and every session launches with plain `--channels
  plugin:aibridge-telegram@devitgroup-plugins` - the dev flag, its full-screen confirm dialog and the
  keystroke injection above all disappear at once. This does not require Anthropic to publish or
  approve anything. Package as a plugin from Phase 5 so this path stays open, and note that setting
  `allowedChannelPlugins` to an empty array blocks the allowlist but **not**
  `--dangerously-load-development-channels` - only an unset `channelsEnabled` blocks the dev flag too.

### 10.1.1 `channelsEnabled` is an org switch we do not control

Discovered the hard way (§10.0). On claude.ai **Team and Enterprise**, channels are blocked until an
Owner enables them, via **claude.ai -> Admin settings -> Claude Code -> Channels**, or
`channelsEnabled: true` in managed settings. It was unset on the Devitgroup Ltd org and was enabled on
2026-08-02.

Four properties make this worse than an ordinary dependency:

- **It is a managed setting users cannot override.** No local config, no flag, no workaround. The
  docs are explicit that it blocks *"all channels including the development flag."*
- **Failure is silent.** No error to the server, no exception, no non-zero exit. `mcp.notification()`
  resolves normally because it resolves when the bytes hit the transport, not on delivery. A revoked
  setting looks exactly like a healthy bridge with a quiet user.
- **It is off by default** for Team and Enterprise, so any second machine, new org member, or fresh
  org hits this before anything works.
- **It applies live.** The 2026-08-02 evidence shows it taking effect on a running session. A
  mid-flight revocation would strand every open session with no signal.

Mitigations:

1. **A startup liveness check, not an assumption.** On session launch the Bridge pushes a synthetic
   event carrying a nonce and watches for the hook-visible turn it should provoke. No response inside
   a few seconds means the channel is dead, and the control topic says so in plain words naming
   `channelsEnabled`. This is cheap and it is the only way to tell "blocked" from "idle".
2. **The same probe on a timer**, so a mid-flight revocation surfaces as an alert rather than as
   silence.
3. **Record it as a hard prerequisite** in §4.1 alongside the supergroup and bot tokens.
4. If the org ever revokes it and will not restore it, the design has no fallback and **Remote Control
   is the answer** (§11). Say so out loud rather than attempting a workaround.

Note the asymmetry found on 2026-08-02: `permission_request` relay was delivered while inbound pushes
were still being dropped. Do not use a working relay as evidence that inbound delivery is healthy.

### 10.1.2 `notifications/claude/channel` is broken upstream, independent of `channelsEnabled` - decision: stop using it for inbound

**This supersedes §10.0's "RESOLVED, proven end to end" framing.** That record stands as-is (kept
per this plan's own convention of not rewriting history), but Stage 7 manual verification on
**2026-08-03**, against the same pinned client **2.1.220**, with `channelsEnabled` freshly reconfirmed on
via a live admin-console screenshot, with every §2.4 registration correction above applied (`.mcp.json`,
`bun.exe` resolved, `AIBRIDGE_SLUG` on the server's own `env`), and with the channel server **confirmed
connected** (`channel server for "test-session" connected` logged at the Bridge, `hello_ack` received) -
sent two real Telegram messages end to end through the pipe, into `forwardInbound()`, through a
`server.notification()` call that **resolved with no error**. Neither produced any reaction in the live
session: no inbound line in the transcript, no `reply` tool call, nothing, after waiting well past the
~8 second window §10.0's own proof run needed. This is not the `channelsEnabled` failure mode from
§10.0/§10.1.1 - that one is silent in exactly the same way, but every variable §10.1.1 names as the cause
was independently ruled out this time before concluding anything.

**Direct confirmation, not inference.** The MCP SDK's `Server.getClientCapabilities()`, logged
immediately after `server.connect(transport)` succeeds in this exact session, returned **`undefined`** -
Claude Code never sent *any* client capabilities, let alone `experimental["claude/channel"]`. A working
channel would show that key present.

**This is a known, currently-open Anthropic bug, not a defect in this design or its implementation.**
[anthropics/claude-code#36431](https://github.com/anthropics/claude-code/issues/36431) is the
consolidated tracker (duplicates folded in: #45563, #36429, #36411, #36975, #64470, and others). Reports
span from macOS to native Windows to WSL2, both `--channels` and `--dangerously-load-development-channels`,
multiple channel plugins (Telegram, Discord) and hand-rolled test servers, and Claude Code versions from
2.1.80 through at least 2.1.220 (this plan's pinned version) - including a `--bg` background-daemon
repro (2.1.150) showing `/mcp` itself reporting `1 MCP server failed` while the transport-level handshake
still completes. One commenter on the tracker independently found the exact same `getClientCapabilities()`
smoking gun reported here, on a completely different host and channel plugin. A `getClientCapabilities()`
data point posted 2026-ish in the thread suggested the capability negotiation might have been fixed for
`--channels plugin:<id>` between host versions 2.1.158 and 2.1.170 on some platforms, but a later
comment in the same thread reproduces it again on 2.1.145-2.1.158 with the *same* plugin version that
supposedly fixed it elsewhere - so "fixed" is not a safe conclusion for any specific version, and this
plan's own 2.1.220 repro (well past that window, using the raw `server:` dev-flag path rather than a
marketplace plugin) confirms it is not fixed for this design's exact configuration. Outbound is
unaffected: every report, including this plan's own, confirms the `reply` **tool call** works
perfectly - only the notification-push direction is broken. This matches Claude Code's own docs
distinguishing a "standard MCP server" (tool calls only, unaffected) from a "channel" (adds the pushed-
event capability, broken) - see the comparison table in `/docs/en/remote-control`.

**Anthropic's own documented alternative doesn't fit this design.** `code.claude.com/docs/en/remote-control`
describes a first-party mechanism ("Remote Control") that pushes messages into a running session from
claude.ai/the Claude mobile app - and it is *not* built on `notifications/claude/channel` at all; it is a
separate, proprietary streaming protocol between the local `claude` process and Anthropic's own backend
(the local process "registers with the Anthropic API and polls for work"), so it is not affected by this
bug and not something a third-party MCP server can plug into. §11 already evaluated and rejected Remote
Control as this design's zero-build alternative (no Telegram UI, no topic-per-session organisation, no
custom buttons) - that conclusion still holds; Remote Control's immunity to this specific bug doesn't
change the fact that it isn't the product being built.

**Survey of how other projects solve the same problem (2026-08-03).** None of the community
Telegram/Discord-to-Claude-Code bridges found rely on `notifications/claude/channel` for inbound
delivery at all - which, in hindsight, is itself a signal about how load-bearing this bug is industry-
wide:

| Project | Inbound mechanism |
|---|---|
| [oscarsterling/claude-telegram-remote](https://github.com/oscarsterling/claude-telegram-remote) | Injects messages into the tmux session via keystrokes, "wrapped in Telegram channel tags so Claude treats it as a real message" - the same `<channel source=... topic_id=...>` wrapping this plan already uses, just delivered as typed input instead of a notification |
| [jsayubi/ccgram](https://github.com/jsayubi/ccgram) | Keystroke injection across tmux, Ghostty (AppleScript), or a **headless `node-pty` PTY as a fallback** when neither is available - the same primitive this plan already uses for the dev-channels confirmation keystroke |
| [alexei-led/ccgram](https://github.com/alexei-led/ccgram) | tmux `send-keys`, same pattern |
| [hanxiao/claudecode-telegram](https://github.com/hanxiao/claudecode-telegram) | tmux `send-keys`, same pattern |
| [prassanna-ravishankar/repowire](https://github.com/prassanna-ravishankar/repowire) | Its own local daemon mesh with an MCP tool surface (`ask_peer`, `notify_peer`) rather than the channel-notification push path - explicitly chosen, per its own maintainer commenting on this bug's tracker, because it "never touches the channel capability negotiation that's failing" |

Two open Anthropic feature requests
([#24947](https://github.com/anthropics/claude-code/issues/24947),
[#53049](https://github.com/anthropics/claude-code/issues/53049)) ask for a first-class
`claude inject`/message-injection API and remain unimplemented, which is further evidence this is a
known gap rather than a corner nobody has hit yet.

**Decision: Phase 1 switches inbound delivery from `notifications/claude/channel` to direct PTY text
injection, keeping the `reply` MCP tool for outbound exactly as designed.** Concretely:

- The Bridge, which already owns the PTY (§2.3) and already injects keystrokes for the dev-channels and
  MCP-consent dialogs (§2.4), writes the inbound Telegram text directly to the PTY's stdin, wrapped in
  the same `<channel source="aibridge" topic_id="..." msg_id="..." from="...">...</channel>` shape
  `buildMeta` already produces for the (now-unused) notification path, followed by `\r` - i.e. exactly
  what a human operator typing that text into the TUI and pressing Enter would send. This is the same
  primitive already proven working three times this session (the dev-channels dialog, the MCP-consent
  dialog, and the shift+tab manual-mode toggle).
- The channel server keeps declaring `experimental: { "claude/channel": {} }` and the `reply` tool
  exactly as built (§3.1-§3.3) - dropping the capability declaration buys nothing since tool calls were
  never the broken part, and keeping it costs nothing beyond the dialogs above. What changes is that
  `forwardInbound()` (§3.2) becomes dead code for Phase 1: the Bridge delivers inbound text to the PTY
  directly instead of routing it through the channel server's `server.notification()` call. Revisit
  removing the capability declaration and the dev-flag entirely once #36431 is fixed and this plan can
  return to the originally-designed path, which is materially simpler (one fewer full-screen dialog,
  and inbound delivery becomes push-based instead of PTY-text, which correctly restores the ability for
  multiple queued messages to land as one system notification rather than one CLI turn each - see
  §10.0's "16 events arrived batched" finding, which this workaround cannot reproduce).
- This is a real behavioural change worth naming: each Telegram message becomes a normal queued user
  turn in the transcript (visibly, with its own turn boundary) rather than an ambient system
  notification Claude could act on unprompted mid-turn. Claude Code's own prompt queue already handles
  typing while busy (queues, delivers in order), which is the same mechanism an operator relies on
  typing at the desk, so this is not new risk - it is a return to exactly how a human drives the TUI,
  which several of the surveyed projects call out as a feature ("Claude treats it as a real message")
  rather than a compromise.
- **Built and proven live the same day (2026-08-03), same Stage 7 session.** `packages/protocol`
  gained `renderChannelTag(content, meta)` (validates via `buildMeta`, XML-escapes, appends `\r`);
  `Routing` gained `setPtyWrite`/`getPtyWrite` so `index.ts` can reach the PTY by slug; the Telegram
  `onUpdate` handler now calls `write(renderChannelTag(...))` instead of `pipe.sendInbound(...)`.
  `pipe-server.ts`'s `sendInbound` and `channel-server`'s `forwardInbound`/notification path are
  untouched and still covered by their existing tests - genuinely dead in this call site, not deleted,
  per the "revisit once #36431 is fixed" note above. One real snag on the way to green, worth recording:
  a `.write()` call carrying the whole tag *and* the trailing `\r` in one chunk left the text sitting
  unsubmitted in the input box - plausibly the TUI's bracketed-paste handling (`\x1b[?2004h`, seen in
  every startup banner) treating a large single write as pasted content and swallowing the embedded
  Enter. Sending the `\r` as a **separate, subsequent** `.write()` call submitted it reliably; the dev
  control server's existing `/write` endpoint made this trivial to isolate live. Full round trip
  confirmed against the real "AI Bridge Control" group: `hi7` sent from the phone at 10:06, Claude
  called `aibridge - reply(topic_id: "3", text: "hi! what do you need?")`, the permission prompt was
  approved, and the reply landed in Telegram at 10:08 - the true end-to-end form of scenario 29, closing
  Stage 7's core exit criterion. `bun test` (43 tests) and `tsc --noEmit` stayed green in both touched
  packages throughout.
- **The `\r`-as-separate-write fix is in production code**, not just recorded here:
  `renderChannelTag` (protocol) deliberately omits the trailing `\r` now, with a doc comment
  explaining why, and `index.ts`'s inbound handler calls `write(renderChannelTag(...))` then
  `write("\r")` as two distinct writes.
- ~~Still open, not yet done: (a) the "New MCP server found" consent dialog `.mcp.json` registration
  (the §2.4 correction above) now raises on every `/new` needs the same treatment correction 3 already
  gives the dev-channels warning.~~ **Moot since 0.55.0** (struck 2026-08-13). That dialog was a
  property of the `.mcp.json` + `--dangerously-load-development-channels` launch path, which the
  plugin cutover deleted outright - `session-launcher.ts` only knows how to launch the plugin form
  now, and a plugin's own registration raises no per-worktree consent dialog. There is nothing left
  to give "the same treatment" to.
- ~~(b) the §9 test scenario list needs a scenario for "inbound delivered via PTY injection, not
  notification" replacing the assumption baked into the existing scenario 29 language.~~ **Done
  2026-08-13**: scenario 29's wording now names the asymmetry explicitly (inbound by PTY injection,
  outbound by the `reply` tool), and new **scenario 29a** covers `renderChannelTag` plus the
  two-separate-writes submit rule that a refactor would otherwise silently collapse.
- (c) **Still open**: file our own comment on
  [#36431](https://github.com/anthropics/claude-code/issues/36431) with this plan's specific repro
  (`getClientCapabilities()` returning `undefined` for a raw `server:` dev-flag registration, not
  just marketplace plugins) - the existing thread's evidence table is missing this exact
  configuration. Deliberately not posted unprompted: it is a public comment under the operator's own
  GitHub identity, so it needs their explicit go rather than being done on their behalf. Draft text
  is ready (2026-08-13) and lives with whoever is running this pass; the content is the two facts
  already recorded in §10.1.2 above - the exact configuration probed, and that inbound had to be
  switched to PTY injection as a result.

### 10.2 Feed volume exceeds the rate budget

Largely retired by the second bot token (§5.4): P2 now has a dedicated 20/minute and cannot delay a
permission prompt at all. Residual: four sessions on tool-heavy turns still saturate the feed bot and
sit at 12s refresh, which feels laggy. Accepted. If it bites, the next moves are a third send-only
token, or lowering the §10.5 unit budget so fewer sessions run at once.

### 10.3 Approval fatigue producing reflexive Allow

Covered by §6.2, §6.7 and §8.3. The sandbox is the structural answer rather than the policy one: in
auto-allow mode a contained Bash command produces no prompt, so the prompts that remain are the ones
that genuinely leave the boundary. Measure it anyway: the Bridge logs prompts-per-hour, and if the
median session exceeds roughly 10, the boundary is drawn too tight and should be widened deliberately
rather than by reflex tapping.

### 10.4 Laptop sleep behaviour proves intolerable

Covered by §7.4, and unchanged by the host decision - Windows suspends exactly as WSL2 would, and
modern standby can do it without the lid closing. Escape hatch in §11. The Bridge and channel server
contain no OS-specific code beyond the two lines identified in §7.6, so a move to a VPS (or to WSL2) is
an operational change rather than a rewrite. That portability is a design requirement, not an accident,
and it is now load-bearing twice over because §7.6 depends on it too.

### 10.4.1 Losing the sandbox for Phases 1-5

New with the host decision, and the honest counterweight to it. Until §7.6, there is **no OS-enforced
boundary**: a script the session writes can read any file the operator can, including
`%USERPROFILE%\.ssh` and `%APPDATA%\aibridge\.env`, and there is no network egress control at all. The
`deny` rules in §6.2 constrain Claude's own file tools and the Bash file commands Claude Code
recognises, and nothing else.

What makes this acceptable for Phases 1-5 rather than merely tolerated:

- **The operator is present.** These phases are development, run at the desk, with someone watching.
  The threat the sandbox addresses is unattended execution, which is Phase 6.
- **The two hard blocks still hold**, because they are hooks rather than permission rules and fire
  before the tool runs (§7.3).
- **It is measured, not assumed.** The prompts-per-hour metric (§10.3) is promoted from a Phase 6
  nicety to a Phase 3 deliverable, because on this host it is the only instrument that says whether the
  allowlist has quietly grown too broad.

What would be unacceptable: letting the fleet drift into overnight unattended running on Windows
because the earlier phases worked. §12's Phase 6 exists to prevent exactly that, and §13 check 7 is
skipped-with-a-note rather than passed until the migration.

### 10.5 Usage limits and cost

The owner is on **Max 5x** with **Sonnet as the `/new` default**. That combination is comfortable
rather than binding: quota stops being the first constraint the fleet meets, and the §5.4 rate budget
goes back to deciding the concurrency cap. Claude Code still meters on a 5-hour rolling window plus a
weekly cap, so the failure mode has not disappeared, it has just stopped being routine. The realistic
version of it now is an Opus-heavy afternoon, not a Tuesday.

That shape is what the mechanism is built around:

1. **A weighted concurrency budget, not a session count.** The cap is **4 units**, where Opus costs 2,
   Sonnet 1 and Haiku 0.5. So four Sonnet sessions run happily, two Opus sessions do, and one Opus
   plus two Sonnet does. A flat cap would either under-use the plan on a Sonnet day or over-commit it
   the moment two sessions were upgraded; weighting encodes the actual constraint in one line of
   arithmetic. `/new` refuses over-budget with the current allocation in the refusal, and `--opus` on
   a full fleet says which session to kill first.
2. **Burn-rate alarm, driven by §5.7.** The Bridge tracks rolling 5-hour spend from
   `claude_code.cost.usage`. At a configurable threshold it posts once to the control topic with the
   per-session breakdown. With a Sonnet default this is a guardrail rather than a daily event, which
   is the right pressure: an alarm that fires constantly is an alarm nobody reads.
3. **Quota stops are announced, never silent.** A `claude_code.api_error` event, or a `StopFailure`
   hook carrying a rate-limit error, marks the session with a distinct state and posts "stopped on a
   usage limit" into its topic. From a phone, a quota stop and a wedged session look identical, and
   that ambiguity is the real cost here, more than the money. This one matters regardless of which
   model is default.
4. **`/new --opus` is one word away.** The default is the cheap correct choice for the work that
   actually gets driven from a phone (implement this plan, fix this test, chase this failure), and the
   upgrade is available for the session that genuinely needs it. Defaulting cheap and upgrading
   deliberately is the right way round: the reverse trains the operator to ignore the cost signal.
5. **A monthly spend limit is self-serve** on Max, under Settings → Usage. Set one before the first
   unattended overnight run rather than after.

One fact makes the subscription arithmetic better than it first looks: **interactive sessions draw on
the subscription**, while the separate non-interactive credit pool ($100/mo on Max 5x) covers
`claude -p`, the Agent SDK and CI. Running real interactive `claude` processes therefore keeps the fleet
on the plan rather than burning credits, which is a second and independent reason to prefer §2.3's
session model over the `stream-json` alternative in §5.2. The cost argument and the capability
argument point the same way here, which is not always true and is worth noticing when it happens.

**What is still not solved:** remaining quota is not exported (§5.7), so every number above is
consumption looking backwards.

### 10.6 Plan mode is unavailable in channel sessions

Found in pass 4, and it is a capability loss rather than a risk to mitigate.

Since **v2.1.75**, `EnterPlanMode` and `ExitPlanMode` are disabled whenever a channel is configured -
not when a prompt arrives from a channel, but whenever one *exists in the configuration*. Every session
this design launches has a channel, so **no Telegram-driven session can use plan mode.** The behaviour
was reported as a bug and
[closed as not planned](https://github.com/anthropics/claude-code/issues/41787), so it should be
treated as intended and durable rather than as something to wait out.

It is coherent with the rest of the protocol: plan approval is a modal dialog, and the docs are
explicit that modal dialogs do not relay. There is an open proposal to extend the relay to cover them
([#38498](https://github.com/anthropics/claude-code/issues/38498)); until it lands, this stands.

**The workflow consequence, stated plainly.** Planning happens at the desk, execution happens from the
phone. That is a smaller loss than it first appears, because it matches how the original request was
framed: *"in the first session I say, we have this plan, let's implement it."* Implementation is the
Telegram use case. Writing the plan is not, and in SeoWrite - the pilot project - planning already
happens in long desk-bound sessions with `plan-craft` and a lot of reading; other target repos are
free to plan however they already do.

What this rules out concretely:

- Asking a Telegram session to "plan this first, then check with me". It will simply implement.
- The plan-approval checkpoint as a safety mechanism. The `ask` rules in §6.2 are the only gate, which
  raises the stakes on them being right and is another reason the §6.1.1 probe was worth running.
- `/plan` as a workaround. It is a TUI toggle, and TUI input is exactly what a Telegram operator does
  not have (§4.2).

If plan-mode-from-a-phone turns out to matter, [Remote Control](https://code.claude.com/docs/en/remote-control)
has it today, because it drives the real TUI rather than pushing events into it. That is a genuine
point in its favour and §11 records it. The alarm can say "you have spent a lot, fast" and cannot say "you have
40 minutes left". Closing that would mean scraping `/usage` out of a TUI, which is exactly the kind of
fragile coupling this plan avoids elsewhere. Accepted, and revisit if Anthropic exports quota state.

---

## 11. Deliberately not building

| Not building | Why | If needed later |
|---|---|---|
| Raw TUI mirror | Decision 2. Unreadable on a phone and unaffordable within the rate budget | `stream-json` per §5.2 |
| Multi-user / team access | Single operator. Multi-user means per-user authorisation and audit, which is a different system | - |
| Discord, Slack, iMessage | Telegram's bot-API client lives in its own module, but no `Transport` interface is built ahead of a second implementation - one concrete transport doesn't justify the seam yet (YAGNI) | Extract the interface then, from two concrete implementations instead of a guess at one |
| Cloud or VPS hosting | Decision 1 | Bridge and channel server are OS-neutral (§7.6); the port is a service unit plus a clone |
| Voice input | Out of scope | Telegram voice messages plus transcription, as `RichardAtCT/claude-code-telegram` does |
| Marketplace publication | Requires an Anthropic partner contact and does not help a single operator | Phase 5 packages as a plugin anyway |
| Replacing the terminal | The desk stays the primary interface for anything long-form. Telegram is a remote control, not a replacement | - |
| Plan mode from a phone | Not a choice: channels disable `EnterPlanMode`/`ExitPlanMode` outright (§10.6) | Remote Control has it today, because it drives the real TUI |
| Slash-command passthrough | Channel messages reach Claude's context, not the CLI, so `/foo` is just text | The `/cmd` shim in §4.2 covers most of it |
| A live TUI mirror per session | `tmux attach` is gone with the host change (§2.3); reproducing a terminal in Telegram is decision 2 all over again | `/attach` posts a PTY tail; `claude --resume` at the desk |
| The OS sandbox, before Phase 6 | Not a choice: unsupported on native Windows (§6.7) | §7.6 is the migration, written as a checklist |
| Reconfirming stale replayed messages | Today a Bridge restart replays every Telegram update queued while it was down (offset-persisted, §4.5.1) with no "still relevant?" check - a stale destructive control-topic command could re-fire on boot. Speculative: no incident has actually happened yet, and the real risk is narrow (destructive control-topic commands only; stale session-topic chat replay is harmless) | Compare a replayed update's Telegram `date` to the Bridge's own start time; if it queued while down, route control-topic exact commands through the existing confirm-card infra (`nl-confirm.ts`'s pattern) instead of auto-executing. Leave session-topic free text untouched |
| A Windows-native OS-enforced sandbox (restricted process token + per-worktree ACLs) | §8.3's "no OS-enforced containment before Phase 6b" gap (a subprocess Claude writes reads any file the operator can, `deny` rules bind only Claude's own tools) already has a planned fix - the §7.6 WSL2 migration's kernel sandbox. Building a parallel Windows-native mechanism now (spawn each session's PTY under a restricted token via `CreateProcessAsUser`, with NTFS ACLs scoping read/write to that session's own worktree) would duplicate that work and likely get thrown away at the Phase 6 cutover. The two cheap, non-duplicative mitigations - broadened `~/**` deny rules (§6.2) and output-side secret scrubbing on every `reply`/`send_file` (§8.2) - ship instead; see 2026-08-06's changelog entry | Build this only if the Phase 6/WSL2 migration stalls or is rejected outright and OS-enforced containment is still wanted - it is the Windows-native fallback for that gap, not a step on the way to WSL2 |
| A local file-server + tunnel (Tailscale Funnel/ngrok) so §3.6's `/browse`/`/find` could open an unpushed file in a real browser | New internet-facing surface and setup cost, for a case §3.6's `👁 View` (scrubbed inline excerpt) and `📄 Send file` (exact current bytes) already cover - "give me the current file" doesn't need a browser, and `🔗 GitHub` already covers the pushed-and-clean case with a real link button | Revisit if GitHub-link coverage turns out to be hit often enough in practice that document delivery starts feeling like a workaround, not if it's merely requested once |
| Control-topic or cross-repo variant of `/browse`/`/find` | Out of scope per the operator's explicit choice when §3.6 was designed - every other Bridge-native file access in this plan stays session-worktree-scoped, and a control-topic variant would need its own `resolveWorktreeRelPath`-style root check against `repos.toml`'s checkout path instead | If ever wanted, build it as a genuinely separate containment root, not a relaxation of the session-scoped one |

**The zero-build alternative, stated plainly.** [Remote Control](https://code.claude.com/docs/en/remote-control)
already delivers most of this today with no code: `claude remote-control --spawn worktree --capacity 32`
gives parallel sessions each in its own worktree, a session list, live subagent and workflow progress,
permission prompts on the phone, and push notifications - through the Claude mobile app and
claude.ai/code. What it does not give is the Telegram UI, topic-per-session organisation, or custom
inline-button interactions. It also has open bugs on mobile permission prompts rendering and unblocking
the local TUI ([#35637](https://github.com/anthropics/claude-code/issues/35637),
[#59855](https://github.com/anthropics/claude-code/issues/59855)).

If at any phase boundary the remaining work looks larger than the marginal value over Remote Control,
stopping is a legitimate outcome. Phase 1 is deliberately cheap so this judgement can be made with real
information rather than in advance.

---

## 12. Phases

Prerequisites, before Phase 1:

- **P-1** Windows host prepared. Bun installed; `node-pty` building against the installed toolchain
  (it is a native module, so this is the one dependency that can fail on a clean machine, and it fails
  at `bun install` rather than at runtime). This is two distinct risks, not one: a missing build
  toolchain fails the install outright, but `node-pty`'s older builds predate Bun's N-API support and
  can also fail to *load* the compiled `.node` file at runtime under Bun specifically, with an
  ABI-shaped error that survives a clean `bun install` - check for a NAPI-based `node-pty` release
  before pinning a version. Defender exclusion for `c:\data\worktrees` and
  `LongPathsEnabled` set (§7.1). `claude` logged in as the account the Bridge will run as - interactive,
  browser-based, once. A fleet-only SSH key loaded into the **OpenSSH Authentication Agent** service,
  set to Automatic. `user.name` / `user.email` set in each registered clone. `$STATE\repos.toml`
  populated with at least one repo (§7.5).
  **No reboot, no WSL, no sandbox packages** - all four moved to §7.6 and Phase 6.
- **P-2** Telegram supergroup with Topics enabled; **two** bots created; the control bot promoted to
  admin with `can_manage_topics`; the feed bot added as a member that can post; both tokens in
  `~/.config/aibridge/.env` mode 0600. Note that any admin holding `can_delete_messages` can delete topics
  regardless of `can_manage_topics`, so keep the admin list to the operator and the control bot. The
  Bridge validates both tokens with a `getMe` call **at startup**, before registering the `getUpdates`
  poller or accepting any session launch, and refuses to start with a named error naming which token
  failed - a bad or revoked token must never surface for the first time deep inside the first
  `sendMessage` call.
- **P-3** *(deleted for Phases 1-5.)* Was the `guard-git-write.sh` bash port. On a Windows host
  `guard-git-write.ps1` runs natively and unmodified, so this plan now touches **no existing repo
  code at all** (§7.3). The port returns as a §7.6 migration item, because a sandboxed WSL2 command
  cannot invoke `powershell.exe`.
- **P-4** Claude Code version pinned and recorded, then a **protocol probe** against a throwaway
  channel. Status as of 2026-08-02 against pinned **2.1.220**:

  | # | Behaviour | Status |
  |---|---|---|
  | 0 | The dev-channels flag still exists | ✅ **Verified.** Hidden from `--help`, recognised by the parser as variadic `<servers...>`. Re-check on every version bump (§10.1) |
  | 1a | A custom channel server loads and connects via the flag | ✅ **Verified.** Full handshake, protocol `2025-11-25`, `experimental` capability accepted, `reply` tool visible, Claude reported the channel connected |
  | 1b | No MCP consent dialog for a fresh worktree with user-level registration | ✅ **Verified interactively.** No consent dialog. Caveat: the probe used `--mcp-config`, so the `.mcp.json` path is untested (§2.4) |
  | 1c | **Inbound `notifications/claude/channel` events reach Claude's context** | ✅ **VERIFIED.** All 20 events delivered, in the initial context, mid-turn, and in the user-turn slot. Two earlier failures were `channelsEnabled` being unset on the Team org, not a protocol fault. See §10.0 |
  | 2 | `hasTrustDialogAccepted` suppresses the workspace-trust dialog | ➖ **Moot.** With the `projects[]` entry deleted entirely, no trust dialog appeared. Keep the pre-accept anyway (§2.4) |
  | 3 | The `ask` rule fires with the sandbox on and auto-allow enabled | ➖ **Moot until §7.6** - there is no sandbox on Windows. The rule's precedence over a hook `allow` is already verified (§6.1.1) |
  | 4 | The `PermissionRequest` observer hook fires and carries `tool_use_id` | ⚠️ **Half.** The hook fires reliably, but there is **no `tool_use_id`, `permission_rule_id` or `permission_rule_text`** - all three were assumed. No field joins it to the relay's `request_id`. §6.5 is rewritten: the card renders from the channel payload alone. **No longer gates Phase 2** |
  | 5 | `AskUserQuestion` `updatedInput` + `answers` is accepted | ✅ **Verified interactively.** The hook answered out of band with the last option and Claude proceeded on it with no dialog shown |
  | 6 | First-run onboarding dialogs | ❌ **New blocker found.** A theme picker and a fullscreen-renderer offer precede everything, before any banner. Unattended launch on a fresh config deadlocks on a blank screen. Pre-seed both (§2.4) |
  | 7 | `channelsEnabled` is on for the org | ✅ **Enabled 2026-08-02** by the Owner. Now a hard prerequisite and a live risk, not a one-off (§10.1.1) |

  **The sitting ran on 2026-08-02 and P-4 is closed.** Item 1c, the go/no-go, passed. Two items were
  answered by being made irrelevant (2, 4), and two new findings came out of the same pass (6, 7). The
  probe kit is in `scratchpad/sitting/` and is the seed of the Phase 1 skeleton.
- **P-5** Monthly spend limit set under Settings → Usage, before the first unattended run (§10.5).

### Phase 1 - walking skeleton

One session, one topic, no feed, no permission relay. Prove the protocol end to end before building
anything on top of it.

- ~~**Phase 1.0, the interactive protocol sitting.**~~ **Done 2026-08-02.** The go/no-go passed and
  P-4 is closed; see the table above and §10.0. Phase 1 starts at the Bridge.
- Bridge with a single `getUpdates` loop and the named pipe.
- Channel server: `claude/channel`, `reply` tool, nothing else.
- Manual launch: one `claude` on one Bridge-owned PTY, one hardcoded topic.
- The stub Telegram server (§9), because everything after this depends on being testable.
- ~~Measure whether sessions survive Bridge death (scenario 37, §4.5)~~ **Done 2026-08-03: they do
  not.** Killing the Bridge alone (not a tree-kill) took `claude.exe` and its channel-server child down
  with it - zero survivors, immediately. The Job Object opt-out named in §4.5 as a fallback is now a
  concrete Phase 5 candidate, not a contingency; see §4.5 for the reconciliation-table consequences.
- **Exit:** scenario 29 passes (also done, 2026-08-03: §10.1.2's PTY-injection path proven live against
  the real Telegram group - a message typed in the topic reached Claude and a real reply appeared in
  that topic). **Phase 1 is complete.**
- **Added post-exit, 2026-08-03: an operator-visible "Claude is working" signal.** Not a scenario in
  §9's list, but a cheap addition once §10.1.2's PTY injection meant the operator could send a message
  and then wait with no feedback until the reply's permission prompt was confirmed. Two independent
  mechanisms, kept side by side rather than one replacing the other: `sendChatAction("typing")` (renders
  correctly on mobile clients, but Telegram Desktop has a confirmed client bug, tdesktop#30452, that only
  shows it in the topics overview list rather than inside the open topic - discovered live when a direct
  API call returned `ok:true` with nothing visible in the open topic on Desktop), and a real
  "🤔 Thinking..." message sent on turn start and edited in place into the reply text via
  `editMessageText` once it lands (real messages render identically everywhere, so this covers Desktop).
  Proven live: placeholder appears, gets edited into the actual reply with no duplicate message, typing
  action confirmed visible on both mobile and desktop.

### Phase 2 - permission relay

~~**Unblocked.**~~ **Done 2026-08-03.** P-4 item 4 was the last gate and the 2026-08-02 sitting
resolved it by removing the dependency rather than satisfying it (§6.5). P-3 is gone (§7.3) and
item 3 is moot until §7.6.

- ~~`claude/channel/permission` capability; the request handler and verdict emitter.~~ **Done, and
  live-verified before being built on**: a throwaway spike confirmed the notification actually
  fires (§6.3's four fields, exact) and a verdict genuinely closes the local dialog, before any
  real code was written on top of the assumption.
- The non-blocking `PermissionRequest` observer hook and the pairing registry (§6.5): **deferred to
  Phase 3.** §6.5 already concludes the card renders from the channel notification alone and does
  not need this hook; the hook's only remaining job is the *resolution* heuristic (detecting a
  prompt answered at the terminal instead of the phone), which needs the compiled hook client that
  is itself a Phase 3 deliverable. Phase 2 ships with 30-minute expiry as the only resolution path
  in the meantime - an honest gap, not a silent one.
- ~~Inline keyboard, `callback_data` encoding, callback sender re-check.~~ **Done**
  (`permission-callback.ts`).
- ~~The settings baseline of §6.2 including the `ask` list, generated per session.~~ **Done**
  (`settings.ts`, wired into `session-launcher.ts`'s `--settings` flag), content-scoped from the
  start per §6.1.1.
- Verify SeoWrite's own `guard-git-write.ps1` still fires for a Bridge-launched session carrying a
  generated `--settings` file: **not applicable to this pass** - the live verification ran against
  aibridge's own `test-session` (this repo, no such hook). Still open for the first real registered
  target repo that has one.
- ~~`♾️ Always` with rule derivation and the metacharacter guard.~~ **Done**
  (`rule-derivation.ts`). ~~One open question flagged rather than solved: whether a running session
  hot-reloads its `--settings` file mid-conversation, so an `Always` tap's derived rule is
  confirmed *written*, not confirmed *effective on the very next matching call* - unverified.~~
  **Measured live 2026-08-12** (`scripts/telegram-automation/always-rule-check.js`, both variants,
  against real throwaway sessions). The answer is "no, and it only looks like yes for `Bash`":

  | Variant | Tap `♾️ Always` on | Next matching call | Second card? |
  |---|---|---|---|
  | `bash` | `mkdir -p archeck-probe-a` → writes `Bash(mkdir -p *)` | `mkdir -p archeck-probe-b` | **No** |
  | `write` | a `Write` → writes `Write` | a second `Write` | **Yes** → **No** *(fixed same evening)* |

  The `bash` row is not evidence of a hot-reload. That second call **still escalated** - it reached
  the relay and its `PermissionRequest` observer hook fired - so the running Claude Code process did
  not act on the rule that had just been written. No card appeared only because `pipe-server.ts`'s
  own compound-decomposition path (§6.2) re-reads the session's settings file *per request* and
  short-circuited it, logging `auto-approved compound Bash for slug "..." - every sub-command
  already allowed: mkdir -p archeck-probe-b`. That path is gated on `msg.tool_name === "Bash"`,
  which is exactly why the `write` row behaves differently: nothing re-reads the file for a non-Bash
  tool, so the rule sits on disk unused until the session is relaunched.

  **This was a real defect rather than a documentation nit** - for every non-`Bash` tool the tap
  told the operator "allowed, and added `Write` for this session" and then prompted again on the
  very next `Write`, for the rest of that conversation - **and it was fixed the same evening**
  (`codebase-hardening-plan.md` P0-7): `rule-derivation.ts`'s new `isCoveredByBareToolRule` gives
  the non-Bash case the same treatment `Bash` already had, checking the freshly-read allow list for
  the bare tool name before a card is posted. The message was not weakened; the behavior was made to
  match it. Re-running the `write` variant against the fix flipped it to "no second card", with the
  file written and `auto-approved Write ... already allow-listed for this session` in `bridge.log`;
  the `bash` variant still passes. `Edit`/`Read` deliberately still prompt - see §6.6 for why a
  scoped deny rule makes a bare grant unsafe to honour there.

  One honest limit of this measurement: it establishes that the escalation still happened, which is
  enough for the conclusion above, but it cannot distinguish "Claude Code never re-reads
  `--settings`" from "it re-read the file and declined to match the new rule". Distinguishing those
  needs a session *launched* with the rule already in its settings file, which neither variant does.
- **Exit:** scenario 30 passes (automated, and live-verified twice against the real Telegram group -
  a Write card and the resulting `git commit` ask-card, both tapped from the operator's actual
  phone, the second one landing a real commit), plus scenarios 4-13. **Phase 2 is complete.**

### Phase 3 - activity feed

- ~~Compiled hook client; hook registration in the generated settings.~~ **Done** - `packages/hook-client`
  (`bun build --compile`), forwarding every §5.1 event over the pipe with a `hello`+`event` pair per
  firing; wired into `settings.ts`'s `hooks` block, all `async: true`.
- ~~Turn card renderer; per-topic coalescing; the two-token priority governor; `details` button.~~
  **Done** - `hook-events.ts` (normalizer), `feed-state.ts` (turn-card state + prompts-per-hour +
  `turnSeq`), `feed-renderer.ts` (§5.3's card layout, 8-line cap, HTML escaping via
  `feed-escape.ts`, plus `renderDetailsPlainText` for the oversized-log document path),
  `rate-governor.ts` (P0/P1/P2 lanes, 429 handling, retry/backoff, plus `scheduleAsync<T>`) and
  `feed-coalescer.ts` (session-count-scaled flush interval) are all built and live-verified. The
  `details` button (§5.5) shipped in 0.41.0: `details-button.ts`'s `d:<slug>:<turn>` callback_data,
  posted as a small separate control-bot anchor message once per turn (the card itself can't carry
  it - see that changelog entry for why), tap posts the full log or, past 4096 chars, a real
  uploaded document via a new `TelegramClient.sendDocument`.
- **The prompts-per-hour metric**, promoted here from Phase 6. Implemented as a rolling-hour counter in
  `feed-state.ts`, logged at `WARN` past a threshold (20/hour - this implementation's own choice, not a
  number the plan specifies) - exposing it via a fleet command is Phase 5 work.
- ~~**Deliberately deferred rather than done in this pass:** P0/P1 (reply, permission cards,
  `answerCallbackQuery`) still call the control bot directly rather than through `rate-governor.ts`.~~
  **Done in 0.41.0** - see that changelog entry. `TelegramClient` needed one real fix first
  (converting an actual HTTP 429 into `RateLimitedError`, which the governor's own 429-pause path
  had never had a live source for) before the wiring meant anything.
- **Live-verified 2026-08-03** against the real Telegram group: a real Read+Bash+subagent turn produced
  a turn card from the feed bot (`om-aibridge-feed`, a distinct sender identity from the control bot,
  confirming the two-token design), updating in place with correct icons and duration; a concurrently
  raised Phase 2 permission prompt (a real `git commit`) posted and was answered normally while the
  feed was active, confirming P0 isn't starved by P2 traffic in practice. Not independently verified:
  the "two sessions running" half of the exit criterion below, since Phase 1 only launches one hardcoded
  session - genuinely testable only once Phase 5's `/new` exists.
- **Exit:** scenarios 14-21 pass (all as real unit tests - `rate-governor.test.ts`,
  `feed-coalescer.test.ts`, `feed-renderer.test.ts`, `feed-escape.test.ts`, `hook-events.test.ts`,
  `feed-state.test.ts`), and a real tool-heavy turn stays inside the rate budget - confirmed with one
  session; the two-concurrent-sessions half of this exit criterion is carried forward to Phase 5.
  **Phase 3 is complete - both named gaps (the `details` button, P0/P1 governor wiring) closed in
  0.41.0, live-verified against the real dev Bridge.**

### Phase 4 - questions

~~**Done 2026-08-03.**~~ Implemented and live-verified end to end.

- ~~`AskUserQuestion` blocking `PreToolUse` hook; option keyboards; `updatedInput`/`answers`
  return.~~ **Done** - `hook-client`'s `--ask` flag distinguishes the blocking invocation from the
  async catch-all firing on the same payload; `ask-once.ts`/`ask-message.ts` (hook-client) and
  `ask-registry.ts`/`ask-callback.ts` (Bridge) implement the round trip, one Telegram card per
  question, keyed by the tool's own `tool_use_id` rather than a Bridge-invented id.
- ~~The per-hook `timeout` and the cancel-on-timeout path (§6.4).~~ **Done** - `timeout: 3600` on
  the `AskUserQuestion`-matched hook entry, Bridge-side cancel at 3540s (the periodic sweep already
  used for §6.5's permission-expiry), hook-client's own 3550s local backstop behind that in case
  the Bridge is unreachable for the whole hour. The 3540s path is unit-tested (scenario 23) and
  spike-verified against the real stdout contract, not verified under a real hour-long wait.
- **Live-verified 2026-08-03** against the real Telegram group and the real Claude Code binary: a
  genuine `AskUserQuestion` call produced no terminal picker at all, posted a real question card
  from the control bot, and tapping an option both finalized the card (checkmark, keyboard
  stripped) and made Claude proceed with the chosen answer - the exact behaviour a terminal picker
  tap would have produced, sourced from the phone instead.
- **Found live, not anticipated:** the hook-client binary cache (`session-launcher.ts`, since
  Phase 3) only checked whether the compiled binary existed, never whether it was stale - the new
  `--ask` flag had no effect at all on first boot because the cached binary predated it. Fixed to
  rebuild whenever any hook-client source file is newer than the binary.
- **Exit:** scenarios 22 and 23 pass (unit-tested against real captured payloads/output shapes),
  and a real `AskUserQuestion` was answered from the phone. **Phase 4 is complete.**

### Phase 5 - the fleet

- ~~`/new`, `/ls`, `/kill`, `/rm`, `/attach`, `/pause`.~~ **Done** (2026-08-03) and live-verified: two
  concurrent sessions (Phase 1's hardcoded one plus a real `/new`), `/ls`'s aligned table, `/pause`
  toggling feed suppression, `/kill` closing a topic and stopping the process, `/rm` removing the
  worktree/topic/row. `/attach` is implemented and unit-tested (PTY ring-buffer tail plus a
  `claude --resume` hint) ~~but not yet exercised live against a real multi-line PTY tail~~ - **and
  the first time it was, on 2026-08-13, it turned out to be broken.** Against a real session's tail
  the rendered card exceeded Telegram's 4096-unit cap, the P1 send failed three times with
  "Bad Request: message is too long", and the operator saw **nothing at all** - no output, no error,
  because a failed command confirmation is only a log line. The arithmetic was hiding in plain
  sight: `routing.ts` bounds the raw ring buffer at 4000 chars, then `renderAttach` HTML-escapes it,
  and PTY output is full of `<`, `>` and `&`, each expanding to a 4-5 character entity. Fixed by
  bounding the *rendered* message instead (trimming the escaped tail from the front, never through
  an HTML entity - a half-cut `&amp;` would swap "too long" for "can't parse entities") with an
  explicit "earlier output trimmed to fit" marker. See `codebase-hardening-plan.md` P1-10.
- ~~Topic lifecycle including create, rename-once and delete.~~ **Create, delete and rename-once all
  done** (2026-08-04). Rename-once fires off a session's first real `reply` (a new `renamed` column,
  capped at one edit per session); the `SessionStart`-reported-title path §4.4 also named was retired in
  0.74.0, not implemented - checked directly against Claude Code's hooks reference, `sessionTitle` turned
  out to be a `SessionStart` hook *output* field (what a hook can tell Claude Code to display), never an
  *input* field the Bridge could read. Nothing was missing; §4.4 now only describes the one path that
  was ever buildable.
- ~~Worktree provisioning per session; the SQLite routing table.~~ **Done**, including
  reconciliation now - `session-store.ts` persists §4.3's schema at `$STATE/aibridge.db`, with §4.3's
  state-transition table enforced (`isValidTransition`); the hook-driven half of the table
  (`SessionStart`/`UserPromptSubmit`/`Stop`/`StopFailure`/`SessionEnd`) and the permission/ask half
  (`awaiting_input` <-> `working`) are both wired, and `sessionId` is now actually captured from
  every hook event (missing until 2026-08-04 - see the 0.22.0 changelog entry). ~~Reconciliation not
  wired into Bridge startup~~ **done** (2026-08-04): every non-dead row is resumed via
  `claude --resume` on every restart, live-verified across three genuinely-live sessions surviving a
  real restart with zero `No conversation found` errors.
- The supervisor: launch (done, reused from Phase 1); ~~health and restart-on-crash~~ **done**
  (2026-08-04) - a PTY's `onExit` triggers the identical `claude --resume` path a Bridge restart
  gets, distinguishing a real crash from a deliberate `/kill`/`/rm` by whether the slug still points
  at that exact PTY object at the time the (async) exit fires.
- ~~Package as a plugin so the allowlist path stays open (§10.1).~~ **Artifact done** (2026-08-04):
  `.claude-plugin/marketplace.json` (`devitgroup-plugins`) plus `plugins/aibridge-telegram/`, a plugin
  binding the existing channel server as an MCP-based channel, with `resolve-slug.ts` deriving the
  per-session slug from `CLAUDE_PROJECT_DIR` since a plugin's `mcpServers`/`env` block is static and
  can't carry a per-worktree `AIBRIDGE_SLUG` the way `session-launcher.ts`'s own `.mcp.json` write
  does. `claude plugin validate`, a real local `marketplace add`/`install`, and a real
  `--dangerously-load-development-channels plugin:aibridge-telegram@devitgroup-plugins` launch against
  a throwaway stub pipe all succeeded live - see the 0.25.0 changelog entry. **Cutover not done**: the
  fleet's actual launch path (`session-launcher.ts`) still uses `server:aibridge` + `.mcp.json`,
  unchanged - switching it to the plugin form is a separate decision, deliberately not made without
  asking.
- ~~The OTLP listener and telemetry ingest (§5.7); `/ls` cost columns, `/budget`, the burn-rate alarm
  and the distinct "stopped on a usage limit" state (§10.5).~~ **Done** (2026-08-04) - see the 0.24.0
  changelog entry for the live-spike-driven design deviation (cost sourced from `/v1/logs`'
  `claude_code.api_request`, not `/v1/metrics`' delta-temporality `cost.usage`; `http/json`, not
  `http/protobuf`). Live-verified end to end against the real Telegram group with a genuine tracked
  spend; ~~the `quota_stopped` state itself is unit-tested but never live-triggered (no real rate limit
  was forced this sitting)~~ **live-exercised 2026-08-13**, end to end against the running Bridge: a
  synthetic `claude_code.api_error` OTLP/JSON record POSTed to the real listener on
  `127.0.0.1:4318/v1/logs` for a real throwaway session's `session.id` drove the whole path -
  `parseOtlpLogsBody` → `slugForSessionId` → `markQuotaStopped` → the row moving to `quota_stopped`
  → the operator-visible notice landing in that session's own topic ("stopped on a usage limit
  (§10.5) - this looks frozen but isn't wedged"). Only the *upstream source* was synthetic; every
  line of Bridge code on the path was the real one. A genuine rate-limit stop still hasn't been
  observed, and that remains the one thing this substitution can't establish: that Claude Code
  actually emits `claude_code.api_error` in that shape when a real limit is hit (§10.5's own
  never-independently-observed caveat, unchanged).
- ~~Per-session model routing: Sonnet default, `--opus` and `--haiku` overrides~~ **Done** and
  live-verified (`/new --opus <repo> <prompt>` launches with `--model opus`). ~~The weighted unit
  budget that admits them (§10.5) is not done~~ **done** (2026-08-04): `concurrency-cap.ts` refuses
  `/new` before any topic/worktree is created once the fleet is at 4 weighted units, reporting the
  current allocation in the refusal - unit-tested against §10.5's own worked examples, not yet
  live-exercised against four real concurrent sessions.
- ~~`/model <name>` (§4.2.1), reusing the dev-flag confirm keystroke's raw PTY write as a real feature
  instead of a debug-only affordance, so a running session's model can change mid-conversation.~~
  **Done** - implemented earlier; gained a bare-`/model` button keyboard on 2026-08-03.
- ~~`/mode <name>` (§4.2.2), the same primitive driving the Shift+Tab permission-mode cycle. The cycle
  order it depends on is live-verified (2026-08-03), not carried forward as a plan-time assumption.~~
  **Done** - implemented earlier; gained a bare-`/mode` button keyboard on 2026-08-03, live-verified
  (a tap correctly drove the Shift+Tab cycle: manual -> acceptEdits).
- `/effort <name>` (§4.2.3) - **Done** (2026-08-03), added and live-verified in the same sitting,
  including the confirmation-dialog second `\r` (with its required delay) and a bare-`/effort` button
  keyboard.
- ~~`/restart` (§4.5.1): the self-respawn primitive the supervisor's own automatic restart-on-crash
  duty already needs, made reachable as a fleet command.~~ **Done** (2026-08-04): self-respawns via
  `spawn(process.execPath, process.argv.slice(1), {detached:true})` then `process.exit(0)`,
  control-topic only; live-verified the successor reconciles cleanly and does not replay stale
  Telegram history (a real bug this exposed and fixed - see the 0.22.0 changelog's `getUpdates`
  offset-persistence note).
- `/rm --dead` and `/rm --prefix <text>` (added 2026-08-04, not originally in §4.2): bulk-cleanup
  forms, always scoped to `dead` rows regardless of which filter matched, so a bulk command can never
  turn into an accidental mass-`/kill` of a live session. Added because this phase's own live testing
  routinely piles up many dead rows with no way to clear them but one `/rm <slug>` at a time -
  live-verified removing nine at once while correctly leaving three live sessions untouched.
- `/kill --all` and `/rm --all` (added 2026-08-04, not originally in §4.2): unlike their `dead`-only
  siblings above, these can act on live sessions too - so instead of executing on the same message,
  both post a Yes/No inline-keyboard confirm card (`fleet-confirm.ts`) and only act once tapped,
  matching the existing permission-approval button pattern (§6.3) rather than a typed `--confirm`
  flag. A 5-minute TTL, not the 30-minute permission-prompt one, since this is an operator confirming
  their own just-typed command rather than waiting on Claude. Deliberately scoped down from covering
  every destructive command (including single-slug `/kill`/`/rm`) per explicit operator direction -
  only the two genuinely fleet-wide forms get the button. **Live-verified (2026-08-04, see 0.29.0)**
  against a real button tap after finding and fixing a real bug: the confirm card silently never
  posted when the command was typed from the control topic itself, because `postFleetConfirm`
  refused an `undefined` topic id that every sibling command handler already treats as "the control
  topic" and handles fine.
- ~~The four-concurrent-Sonnet-sessions-for-an-hour endurance run.~~ **Done (2026-08-04) - see the
  0.31.0 changelog entry.** Two attempts before this one failed for two different real reasons
  (`sendChannelText`'s lost-Enter race, then the permission-expiry sweep's missing `deny` verdict -
  both found and fixed live, see 0.27.0/0.30.0). The third attempt sidestepped the permission-prompt
  path entirely (tasks restricted to already-allowlisted `Read`/`Grep`/`git log|diff|show`/
  `mcp__aibridge__reply`) and ran a genuine hour with zero `PermissionRequest` events, `/ls` staying
  clean throughout, and all four sessions' actual `reply` output verified as correct and on-topic via
  `inspect-topic.js` - not just fleet-command state.
- ~~`sendChannelText` (§4.3's inbound-delivery path, `index.ts`) writes the `<channel>`-tagged prompt
  and its trailing `\r` as two separate raw PTY writes with no confirmation the Enter actually
  submitted, then starts the "Thinking..." placeholder unconditionally regardless - found
  2026-08-04, reproduced live on a single, isolated `/new`.~~ **Fixed (2026-08-04):** a
  settle-then-verify retry - wait for the write's own echo to land, then check for real
  (non-ANSI-only) PTY output; retry just the `\r` once if there's none, give up loudly if the retry
  also produces nothing. Live-verified on two fresh `/new` calls: both showed real spinner activity
  immediately post-fix, unlike the original bug's total silence.
- **Exit: met (2026-08-04).** Scenarios 24-28, 32, 42, 43 and 44 pass; the weighted budget correctly
  refused a 5th `/new` against a real, fully-occupied fleet and the fleet's spend was visible in
  `/budget` throughout. Startup reconciliation, `/restart`, rename-once, the supervisor's
  crash-restart duty, `/budget`, the weighted concurrency cap, the quota-stop state and the
  plugin-packaging artifact are all built and live-verified on their own terms (scenario 24's live
  half, not just its unit test; `/budget`/`/ls`'s cost column confirmed live against real tracked
  spend; the plugin marketplace/install/launch chain confirmed live). The endurance run itself is now
  also done and verified against real per-session output, not just fleet-command state (0.31.0).
  ~~Whether to cut the fleet's actual launch path over from
  `--dangerously-load-development-channels server:aibridge` to the plugin form remains a separate
  decision, deliberately left open rather than made unasked (see the 0.25.0 changelog entry).~~
**Done (0.54.0/0.55.0).** The operator opted in and set the org's real `allowedChannelPlugins`.
  One real gap found and fixed (a stale plugin bundle); one suspected gap (§5.8's send_file/
  screenshot env vars under plugin mode) turned out not to exist once actually live-tested
  (0.53.0). A real restart of the dev Bridge under the plugin default reconciled both live
  sessions cleanly, and a real message into one of them produced a real `mcp__aibridge__reply`
  round trip with no dev-flag dialog anywhere in the path (0.54.0). The old
  `--dangerously-load-development-channels`/`.mcp.json` code path - including the
  `AIBRIDGE_CHANNEL_MODE` rollback toggle itself - is now deleted outright (0.55.0), per the
  operator's explicit call once the plugin form was proven live: `allowedChannelPlugins` is the
  real lever, not a code-level flag, so there was nothing this toggle was actually protecting.
  `session-launcher.ts` only knows how to launch the plugin form now.

### Phase 6 - hardening, and the WSL2 migration

Two separable halves. The first is worth doing on Windows regardless; the second is what makes
unattended running defensible, and **should not be skipped just because Phases 1-5 worked** (§10.4.1).

**6a, on Windows:**

- ~~The full §4.5 reconciliation matrix, including the partial-re-adoption case.~~ **Done (0.33.0).**
  `topic-probe.ts`/`orphan-scan.ts`/`process-scan.ts` cover the two rows that needed live process/topic
  enumeration, wired into `index.ts`'s real startup path alongside the existing DB-observable rows in
  `reconciliation.ts`. The "partial-re-adoption" case (row 1, "process alive") is confirmed not to occur
  on this stack (§4.5's 2026-08-03 measurement) - `readopt` is kept only as defensive handling for a
  recycled pid, per that section's own note.
- ~~The Task Scheduler task itself (`autostart.ts`, `/autostart`); the README half (setup, recovery,
  VPS escape hatch).~~ **Both done.** The task/command is built and live-verified (0.32.0/0.33.0); the
  README half landed in 0.34.0, including one real gap found while writing it - a Task Scheduler
  launch captures no stdout/stderr, so there was no production log file. ~~That gap is still open.~~
  **Closed in 0.74.0**: `logger.ts` gives the Bridge its own file sink
  (`%LOCALAPPDATA%\aibridge\bridge.log`, 10MB cap, one rotated `.1` backup) independent of launch
  method, so an autostarted Bridge logs exactly like a dev-launched one instead of depending on
  `scripts/dev-bridge.sh`'s shell redirect; `uncaughtException`/`unhandledRejection` are logged
  before exit. Live-verified there and re-confirmed 2026-08-12 (P0-6's own WARN path is threaded
  into this same log).
- ~~Stale-inbound handling and monotonic timers (§7.4).~~ **Done (0.35.0).** `stale-inbound.ts`/
  `stale-confirm.ts` gate any inbound message older than 30 minutes behind a Yes/No confirm card
  instead of dispatching it; `monotonic-clock.ts` is now the default clock for every TTL/expiry
  registry. Unit-tested and live-verified for the *unaffected* live path (a real `/ls` and a real
  plain-text message both round-tripped correctly post-refactor); **not** independently
  live-verified: the stale-confirm card firing for a genuinely 30-minute-old backlog message, or
  the monotonic clock's behaviour across a real modern-standby suspend - §7.4's own named risk,
  still open as a live check rather than a build item.
- ~~Quiet mode.~~ **Done (0.35.0).** `RateGovernor.p2PressureExceeded()` (60s window, minimum
  4-sample guard against false-triggering on ordinary low-volume traffic) drives both
  `FeedCoalescer`'s doubled interval and a one-time "feed throttled" notice. Unit-tested with a
  fake clock; ~~not yet live-forced with a real four-session feed storm~~ **live-forced and
  confirmed 2026-08-13** (`scripts/telegram-automation/quiet-mode-check.js`): the notice
  `⚠️ feed throttled, 5 sessions active` posted to the control topic mid-storm, with ~130 real
  `P2 feed edit dropped - feed bucket empty` warnings behind it.

  **What it took is worth recording, because the first attempt failed and the reason is structural.**
  Three sessions each running one long list of tool calls produced almost no drops at all:
  `FeedCoalescer.interval()` is `3000 * activeSessionCount`, so coalesced card edits are held at
  roughly the feed bucket's own 20/minute budget *no matter how tool-heavy a single turn is* - the
  coalescer is doing exactly its job. The pressure that trips quiet mode is **per-turn** overhead
  (a card create and a details anchor for every turn), so the storm has to maximise turn *count*,
  not tool count: 10 short messages round-robined into each of 3 sessions did it immediately. Anyone
  re-running this check, or reasoning about feed load generally, should start from that distinction.
- **Exit:** scenarios 24 and 37 pass under a real restart - kill the Bridge mid-turn with a permission
  prompt open, restart it, and the system converges to a correct state with no dead buttons.
  **Done (0.36.0), live.** Killed the dev Bridge alone with a real Bash-commit permission prompt
  outstanding on a live session; zero survivors (reconfirms 2026-08-03's scenario-37 measurement,
  now with a prompt pending); on restart, reconciliation posted "the pending question was lost -
  please re-ask" then "resumed", set the row back to `working`, and re-added routing; tapping the
  stale permission button afterward answered the callback with no new message and no error - a
  silent no-op, not a hang. Phase 6a is now fully closed.

**6b, the migration (§7.6),** triggered by wanting unattended overnight runs, by prompts-per-hour
showing an uncomfortably broad allowlist, or by adding a repo other than this one.

**Deliberately deferred to the far future (0.56.0) - not skipped, not lost track of.** None of the
three trigger conditions above has occurred as of this sitting. The operator made this call
explicitly rather than it falling out by silence; re-read this section when one of the triggers
actually fires, not on a calendar. Phase 6a's own exit and its §13 manual checks (1-6, 8) do not
depend on this and remain the nearer-term work.

- WSL2 install and the reboot; sandbox dependencies; the AppArmor profile if the sysctl says so.
- For SeoWrite specifically: `guard-git-write.sh` at parity, pinned by its own `test_claude_hook_guards`
  (the old P-3) - that repo's work, not aibridge's; a different target repo would need its own
  equivalent only if it has an analogous PowerShell hook to begin with.
- The ext4 clone; systemd unit plus the logon task that boots the distro; `ssh-agent` under systemd.
- The §6.7.2 sandbox configuration, including an assessment of the five later settings listed there.
- Swap the named pipe for a unix socket (one line, §2.5). `node-pty` is unchanged (§2.3).
- **Exit:** §13 check 7 passes, which it cannot on Windows.

---

## 13. Verification

Manual checks that automated tests cannot cover, run at the end of Phase 6a, and check 7 again after
6b:

1. ~~**Cold boot.** Reboot Windows, log in, touch nothing. Within two minutes the bot answers `/ls`.
   Note that "log in" is load-bearing on this host and is the §7.2 gap being measured, not an
   incidental step: record how long after the desktop appears the bot becomes responsive.~~ **Done**
   (0.58.0): real reboot, autologon, logon-trigger task fired unattended, `/ls` answered under a
   minute after desktop login - process-level cross-check confirmed the Bridge PID's start time matched
   the task's own `Last Run Time`, not a manually-started process.
2. **Sleep and resume.** Close the lid for 30 minutes with a session mid-turn. On resume, the topic
   shows an accurate state and no phantom pending prompts.
3. **Stale command.** Send "push it" while the machine is asleep. On resume it is confirmed, not
   executed.
4. ~~**Terminal race.** Trigger a permission prompt, answer it at the terminal, confirm the Telegram
   buttons resolve rather than hanging.~~ **Done (0.71.0), automated rather than manual** - see that
   changelog entry. Automating this found the §6.5 resolution heuristic itself had never been built
   (only the TTL-expiry path existed) and, once built, found a second real bug (a fast-path Telegram
   edit race) on the very first live run - the check earning its keep twice over in one sitting.
5. **Guard rails hold, all four paths - run against SeoWrite, the pilot project.** From the phone:
   (a) ask a session on `main` to commit - SeoWrite's PowerShell guard hard-blocks it and the block is
   visible in the topic; (b) ask it to `git commit --no-verify` on a feature branch - blocked; (c) ask
   it to commit normally on a feature branch - a button appears rather than the commit just happening,
   driven by the `ask` rule and not by the guard's return value (§6.1.1); (d) ask it to
   `git push origin main` from a feature branch - the guard lets it through by design and SeoWrite's
   own `.githooks/pre-push` catches it. (c) and (d) are the ones most likely to regress silently. A
   registered repo with no equivalent guard hook has no (a)/(b)/(d) to verify - only (c), the `ask`
   rule, applies universally.
6. ~~**Rate storm.** Four sessions on tool-heavy tasks simultaneously. Permission prompts still arrive
   promptly on the control bot; only feed frames degrade.~~ **Done (0.69.0), automated rather than
   manual** - see that changelog entry. `/ls` held a consistent ~2.5s across five rounds while three
   fresh sessions were genuinely mid-turn; the run also incidentally found and led to fixing a real
   bug (every Telegram call lacked a client-side timeout, letting one stalled connection wedge the
   whole outbound pool silently) - a good example of what this check is for.
7. **Sandbox holds.** Ask a session to read the fleet SSH private key two ways: with `cat`, which the
   permission layer refuses, and with a throwaway Python script, which only the sandbox refuses.
   **On Windows this check is expected to FAIL on the second path and that is not a bug** - it is
   §10.4.1 made visible, and running it is how the operator sees the size of what the migration buys.
   Record the failure explicitly rather than skipping the check; it becomes the acceptance test for
   Phase 6b, where both paths must fail.
8. **Compromise drill.** Revoke the control bot token and confirm the fleet fails closed: sessions keep
   running locally, no Telegram control, no silent auto-approvals, and the feed bot alone cannot
   approve anything.
