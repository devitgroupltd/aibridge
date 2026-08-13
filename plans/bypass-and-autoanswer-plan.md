---
version: 0.25.1
status: implemented
last_modified_utc: 2026-08-12T20:05:00Z
changelog:
  - "0.25.1 (2026-08-12): stale-citation fix only, no design change, found by a \"what's left to implement\" sweep across every plan in this folder. §5's test-gate paragraph still said \"No CI yet (`codebase-hardening-plan.md`'s P1-6) — manual gate before merge\"; that finding was fixed in `a511834`, and `.github/workflows/ci.yml` now runs `bun test` and `bash scripts/typecheck.sh` on `windows-latest` for every push to `main` and every PR. The hardening plan's own v1.0.0 pass flagged this document as carrying the stale reference but could not fix it from its side; this closes that pointer."
  - "0.25.0 (2026-08-11): Follow-up audit ('check for similar issues, maybe something is not persisted but should be') found one sibling gap in the same restart-survival shape v0.24.0 just fixed, in a value this plan's own `RoutingPersistence` interface (née `AutoTogglePersistence`, renamed for this) now also covers: `routing.ts`'s `modeBySlug` (`/mode`). Unlike `effortBySlug` (audited and confirmed cosmetic - display-only, no fix needed), `modeBySlug` is read by `session-supervisor.ts`'s `resumeSession` to build the real `--permission-mode` relaunch flag - a Bridge restart silently relaunched every non-`manual` session back in `manual` mode, with no operator-visible signal, exactly the same failure shape as v0.24.0's toggles minus the safety angle (falling back to `manual` isn't dangerous the way falling back to bypass-on would be, so there was never a 'deliberate fail-closed' argument protecting this one - it was a plain oversight, confirmed by the absence of any plan-doc rationale for it). Fixed identically: a `mode` TEXT column (`session-store.ts`, `DEFAULT 'manual'`), `routing.ts`'s `setMode` writes through to it, and `hydrateAutoToggles` was generalized into `hydrateFromRow(slug, {mode, bypassPermission, autoAnswer})` - one call instead of two, since `mode` has a placement constraint the two toggles don't: it must run *before* `resumeSession`'s `launchSession` call (right after `current` is fetched), not after `routing.add()` like the toggles, or the relaunch reads the still-empty map. `hydrateFromRow` re-validates the stored string against `MODES`, falling back to `DEFAULT_MODE`, the same defensive re-validation `index.ts`'s own settingsStore-backed defaults already apply. A live regression test asserts `launchSession` receives the persisted mode against a deliberately fresh, empty `Routing()` (i.e. what a real restart looks like), not just that `routing.ts`'s own map round-trips in isolation."
  - "0.24.0 (2026-08-11): Operator-requested reversal of the fail-closed-on-restart design (§0.2's 'State' bullet, live-verified as working-as-specified in 0.23.0). Live incident: an operator who believed `/auto permission` was on for a session got the Allow/Deny card anyway (`analyze-the-codebase-for-improvements`) — root cause was exactly the documented behavior, a Bridge restart between turning the toggle on and this permission request silently put `bypassBySlug`/`autoAnswerBySlug` back to their construction-time default with no signal that had happened. The 'fail-closed, mirroring permission-registry.ts' argument doesn't actually transfer: a *lost pending prompt* (permission-registry.ts's case) has no safe default to fall back to and must be re-asked, but a *standing toggle* silently reverting to a more-prompting state is pure friction with no operator-visible cause, not a safety backstop — the operator's actual intent was 'stay on', and the old design guaranteed drift from it on every restart. Now persisted: two new `sessions` columns (`bypass_permission`, `auto_answer`, session-store.ts, both `DEFAULT 0` — an upgrade never grants a pre-2026-08-11 row a toggle it didn't already have live), `routing.ts`'s `setBypass`/`setAutoAnswer` write through to them via a new optional `AutoTogglePersistence` constructor param (`SessionStore` in production; omitted in every test and the self-check route, which keeps the pre-existing in-memory-only behavior there), and `session-supervisor.ts`'s `resumeSession` calls a new `hydrateAutoToggles(slug, bypass, autoAnswer)` — deliberately not `setBypass`/`setAutoAnswer` themselves, since a restore isn't an operator action and shouldn't re-fire a write-through of the value it just read. `routing.remove` is unchanged: `/rm` already deletes the whole `sessions` row, taking both columns with it, so the existing `bypassBySlug.delete`/`autoAnswerBySlug.delete` calls (§0.2 above) still fully cover slug reuse. Net effect: the toggle now means what the confirmation text always told the operator it meant, rather than quietly expiring at a time the operator has no way to predict."
  - "0.23.0 (2026-08-11): Steps 2 and 3 implemented — fleet-bulk `--all` and `/default permission|answer`. The whole feature (§0-§6) is now in the tree and live-verified; `status` moves draft → implemented. Both open MEDIUMs resolved *against* the plan's own suggestion, and the resolution is the same in both cases — narrow the type instead of widening it and adding a runtime arm. (1) `executeFleetActionDirect` is NOT widened past `\"kill\" | \"rm\"`: §0.3 argued its three unreachable ternaries should widen anyway because 'unreachable because of a parser two files away' isn't visible to a reader of the function. But a narrow signature makes it visible *and* compiler-enforced, where widening trades that for a WARN default arm nobody reads; the note there now says what to do if `--force` is ever added to `/auto` (widen it *and* give it the same `parseAutoConfirmKind` early return, since its loop carries the identical bare-else hazard). (2) `sendDefaultCategoryPicker` and `resolveDefaultCategoryCallback` take/return the new `DefaultPickerCategory` (`mode | effort`), not the widened `DefaultCategory` — so the two boolean categories cannot reach the drill-down path at all, rather than reaching it and hitting a `never` arm at runtime. Both keep an exhaustive switch on top for the next category. One §5 item is not unit-testable and was live-verified instead: `handleNewCommand`'s application point can't be reached in a test without a real `launchSession` (git worktree + PTY spawn), so 'a new session inherits the default' was checked end-to-end against the real Telegram client. Live-verified in full: bare `--all` fleet status, the `--all on` confirm card, the tap (fleet intact, card finalized 'Auto-permission ON for 1 session', status flipped for that category only), `--all off`, `/default`'s two toggle rows in both label/callback directions, the toggle tap, persistence across a Bridge restart, per-session flags still resetting on that same restart (the deliberate asymmetry), and a new session inheriting the default."
  - "0.22.0 (2026-08-11): Operator-requested investigate-first handling for `auto answer`, resolved against real data rather than intuition. The request was 'when there's a recommended option AND an option to investigate first, always pick investigate'. Extracting all 715 real AskUserQuestion calls from this machine's own Claude Code transcripts (44 sessions) showed why that specific shape can't ship: 212 carry exactly one '(Recommended)' and 0 carry more than one (independently confirming §2.2's rule; 207/212 also put it first, per the tool description), but option semantics live nowhere in the schema - `{label, description?}`, with '(Recommended)' the only instructed convention - so an investigate-detector is keyword-matching prose written without one. Measured ~13% precision, failing toward LESS rigor: it would have answered 'Auto-send immediately, no confirmation' over 'Always show a confirm card first (Recommended)' by matching `confirm` inside `no confirmation`, and 'Extract only, tests later' over 'add tests as each module is extracted (Recommended)'. Shipped as a veto instead - same detection, opposite role: a defer-shaped option among the non-recommended ones suppresses the auto-answer and posts the real card, which is also the only way the operator can pick investigate at all. False positive costs one tap; false negative behaves as before. Fires on ~11% of otherwise-answerable questions. Free-text answering ('investigate first' via the tool's own Other path) was also rejected: Claude asked because it needs a decision, so it would investigate, ask again, be auto-answered identically, and loop until the hook client's 59-minute timeout."
  - "0.21.0 (2026-08-11): Fills §0.2's hole — `handleAutoPermission`/`handleAutoAnswer` were dispatched to but never defined, from v0.13.0 through v0.20.0. Written out, but with the dispatch inverted: on *scope*, not category. All three scopes (bare-status, on/off, --all) are category-agnostic, so splitting by category first forces the whole scope tree to be written twice — contradicting §0.2's own 'described once instead of twice'. What actually differs between the categories is four values, so they resolve through one `autoCategorySpec(category)` descriptor {label, get, set, drainsOnEnable, confirmation} behind a single `never` arm. This supersedes v0.18.0's 'give `applyAutoToggle` its own exhaustive switch': that function now reads `spec.drainsOnEnable` and has no category dispatch left. Rationale recorded in the Overview, since it reverses a prior pass's fix on purpose — four runs found nine instances of the bare-else defect, and twice the fix was 'add another exhaustive switch', after which the next run found a site the enumeration had missed (v0.16.0's `DefaultCategory` ternary, v0.18.0's `applyAutoToggle`). A guarantee spread over N sites is only as strong as remembering all N; one site cannot be forgotten. Also closes §0.3's decomposition gap with `autoConfirmKind`/`parseAutoConfirmKind` in fleet-confirm.ts — a generic `split('-')` reads the existing `rm-topic` kind as category 'rm', so a `/rm --all` tap would enter the auto-toggle branch."
  - "0.20.0 (2026-08-11): /deep-check run 4, pass 3 — 1 HIGH, in §1.1's one-word ordering decision. The notice was `await`ed before `sendVerdict` so the operator's timeline reads correctly, but `p1` and `p0` share one control-bot bucket refilling at ~one token per 3 seconds (rate-governor.ts:32, capacity 20 — §5.4's Telegram per-chat limit), so awaiting it blocks every verdict on a rate-limiter token. Turn `auto permission` on, run the ordinary build-edit-test loop the feature exists to unblock, and after the standing bucket is spent each call stalls ~3s: a 20-tool-call turn freezes for about a minute waiting on Telegram to accept a courtesy notice, with Claude blocked on a verdict the Bridge decided instantly and locally — the feature sold as removing a Telegram round-trip replacing it with a rate-limiter one, and draining tokens other sessions' genuinely-blocking P0 cards need. The ordering §1.1 actually wants comes from enqueue order (the governor's per-lane queues are FIFO), not from awaiting the send, so the fix costs nothing it argued for: enqueue, then send the verdict. `postAutoApprovedNote` already never throws, so this makes the 'a failed notice must never strand a blocked session' contract structural rather than caller-dependent. §5 gains the regression test that catches it — a `sendMessage` fake whose promise never resolves, asserting the verdict still lands (a fake that resolves immediately passes either way)."
  - "0.19.0 (2026-08-11): /deep-check run 4, pass 2 — 1 CRITICAL + 1 HIGH, both in §0.3's fleet-bulk path, both found by reading `fleet-confirm-flow.ts` rather than the plan's summary of it. CRITICAL: `executeFleetConfirm`'s main loop (lines 163-169) is `if (pending.kind === \"kill\") killSessionRow(row); else removeSessionRow(row);` — a bare else that means 'rm' only because `kill|rm|rm-topic` minus the `rm-topic` early return leaves exactly one kind. §0.3 widens `FleetConfirmKind` by four literals and said only that the function 'gains a branch', never where. Placed anywhere after that loop, all four new kinds fall into the else: tapping '✅ Yes, proceed' on a card reading 'Turn auto-permission ON for every live session?' removes every live session, and line 170's second bare else finalizes the card 'Removed 4 sessions'. Both dispatches typecheck unchanged as the union grows. Ninth instance of this feature's recurring defect class and by far the worst blast radius — prior instances corrupted a setting or dead-ended a button. Fixed by requiring an early-return block ahead of the loop (mirroring `rm-topic`'s existing one), converting both dispatches, and a zero-call-count `removeSessionRow` assertion in §5; the same audit found three more `kind` ternaries in `executeFleetActionDirect`, unreachable today only because `parseAuto` has no `--force`. HIGH: §0.3 said to call `applyAutoToggle` 'for every row in `pending.slugs`', but that array is a stale snapshot — line 161 re-resolves rows by slug precisely because sessions die between posting and the tap. Iterating it raw writes `bypassBySlug[slug] = true` for a slug `routing.remove` already cleared, and `uniqueSlug` frees removed names for reuse, so the next session claiming that name starts fully auto-permitted with nothing announcing it — the exact hazard §0.2's `routing.remove` bullet exists to close, re-entered from the other end."
  - "0.18.0 (2026-08-11): /deep-check run 4, pass 1 — 3 HIGH, two of them in text this plan's own earlier passes wrote. (1) `applyAutoToggle` (introduced by v0.14.0 as the fix for the --all-skips-the-drain contradiction) dispatches on `category` — permission sets bypass and drains, answer sets auto-answer and deliberately doesn't — but its shape was never specified, so the natural `if (category === \"permission\") {…} else {…}` makes it the eighth instance of the bare-else defect this design claims to have closed at the type level: the Overview's own hinted `/auto ship on` would silently turn auto-answer on and report ship mode. Specified as an exhaustive switch; the Overview's enumeration of switch sites corrected from §0.2/§0.4 to §0.2/§0.3/§0.4, with a note that the enumeration itself is the weak point (v0.16.0 and this pass each found a site missing from it). (2) §2.2's `findAutoAnswer` sketch returns `[]`, not `null`, for a zero-question call — non-null, so the caller's `!== null` test passes, no card is posted, and an empty `answers` map is written to a blocked hook client. §4 requires the opposite in prose and §5 asserts the opposite in a test; the sketch an implementer actually copies was the one that was wrong. Guard added at the top of the function with the reason it is load-bearing. (3) §0.5 said `allowedKinds` \"gains `auto`\" — but `allowedKinds` is `ROUTER_KINDS.filter(...)` with two *exclusion* predicates and a `return true` tail (verified live, nl-router.ts:159-177), so the only edit matching that phrase is adding an exclusion, and the attractive one (joining `default` at line 161, given how hard this plan leans on the /default parallel) makes 'stop asking me for permission on this one' — typed in a session's own topic, the feature's most likely invocation — a command the router structurally cannot emit. Corrected to leave the function untouched, with both wrong edits named and a both-contexts test added."
  - "0.17.0 (2026-08-11): /deep-check run 3, pass 4 — 1 HIGH. `handleAutoCommand` was specified as synchronous `void` and §3 told the implementer to copy `handleVerboseCommand`'s dispatch shape, but the `--all` branch has to post a Yes/No card through the injected `postFleetConfirm` (Promise<void>) — the thing `handleKillCommand` is async *for*. As written the promise can only be dropped: no `fireAndForget` label to attribute a failed card post to, and §5's `--all` tests have nothing to await before asserting, against an interface declaring nothing to wait for. `handleVerboseCommand` remains the right precedent for the bare-reports-status branch and for module placement (the private `resolveSessionOrBail` closure); it is the wrong one for the call shape. Signature is now `Promise<void>`, dispatch is `fireAndForget` per line 198's `handleKillCommand`."
  - "0.16.0 (2026-08-11): /deep-check run 3, pass 3 — 2 HIGH, both in §0.4's /default extension. (1) The two boolean toggle rows derive *both* their label and their callback_data from the current value, but `buildDefaultCategoryKeyboard`'s signature (session-commands.ts:167, `(currentMode, currentEffort)`) was never widened and §3 gave voice-mode-commands.ts only the two setters, not the getters `sendDefaultStatusCard` needs — an implementer with no value to hand hardcodes `default:permission:on`, producing a button that turns the default on and can then never turn it off, under a label claiming otherwise. Signature, data source, and a both-directions keyboard test now specified. (2) A *third* site switches on the widening `DefaultCategory`: callback-query-router.ts's `\"default\"` rule handle-half ternary (~611-616), which the plan never named. Widening a union does not break a ternary — it compiles and silently routes both new categories into the effort arm, i.e. exactly the failure §0.2 spends two paragraphs claiming the exhaustive-switch discipline eliminates. Enumeration corrected to all three sites, with a note on why `resolveDefaultCategoryCallback` deliberately stays narrow."
  - "0.15.0 (2026-08-11): /deep-check run 3, pass 2 — 1 HIGH, in `auto answer`'s socket handling. §2.2 said the auto-answer path \"factors the socket-write half out of `finishAsk`\", but `finishAsk` resolves its socket from `askSocketsById` (pipe-server.ts:697), a map populated only on the same line as the `askRegistry.add` this path deliberately never reaches — so the natural extraction (lookup included, since it sits between the get and the write) finds `undefined`, returns false, and writes nothing: the operator sees \"🔓 auto-answered\" while the hook client stays blocked forever, with no registry entry left for any sweep to reach. Same permanent-wedge class as 0.8.0's drain finding, on the other category. Fixed by specifying `writeAnswer(socket, slug, payload)` taking the socket as a parameter, called with `handleAsk`'s own `socket` argument; placement pinned to after both existing guards (reconnect-rebind, unknown-slug) with the reason for each; and the pipe-server test upgraded from \"no card posted\" (which passes in the failure case) to asserting the `answer` message reached the fake socket."
  - "0.14.0 (2026-08-11): /deep-check run 3 (against the restructured 0.13.0 shape), pass 1 — 2 CRITICAL + 1 HIGH, all three introduced or newly exposed by the unification, exactly the risk 0.13.0's own note flagged. (1) `/auto` was never registered as a command name at all: §0.1 specified `parseAuto` in full but nothing added `auto` to `FLEET_COMMAND_NAME_RE` (fleet-commands.ts:440) or a `case \"auto\":` arm to `parseFleetCommand` — so every `/auto ...` message returns null from both that and `matchFleetCommandName`, and is silently swallowed into NL routing or forwarded into the session as chat text, the operator-reported failure that function's own doc comment exists to prevent. Fixed, with the `\\b`-backtracking note that keeps the new alternative from hijacking `/autostart`. (2) §4 claimed `/auto permission --all on` drains pending cards \"same handleAutoCommand path per slug\" while §0.3/§3 had `executeFleetConfirm` call `routing.setBypass` directly with \"no new injected dependency\" — flatly contradictory, and as specified the fleet-bulk path skips the drain and wedges every already-posted card, in the scope most likely to have one. Fixed by extracting `applyAutoToggle(slug, category, on)` as the single set+drain entry point both callers must use, with the one new injected dependency named. (3) nl-router's reused `all` field still described itself as 'For kill/rm', so \"turn off auto-approve on all my sessions\" structurally cannot produce `all: true` — a safety toggle applied to one session and reported as fleet-wide success. Both reused field descriptions now name 'auto'."
  - "0.13.0 (2026-08-11): Operator-requested restructuring, not a /deep-check pass. `/bypass` and `/autoanswer` are folded into a single `/auto <category> [<slug>] [on|off]` command, mirroring this codebase's own `/default [mode|effort] [<value>]` shape exactly — one verb to remember instead of two independently-named ones, and directly extensible to a hinted future `/auto ship [on|off]` category with zero new parsing/dispatch surface. This is a command-surface change, not a correctness rewrite: every mechanism v0.2.0-v0.12.0's five /deep-check passes verified (the sendVerdict boolean check before finalizing a drained card, the three-part default-persistence write-through, routing.remove clearing both new maps, isDestructive's on-gated/--all-excluded split, the --all-with-no-value fleet-status form, the drain's verdict-then-finalize ordering, the six-times-found bare-else category-dispatch defect) carries over in substance, restated against the new `{kind: \"auto\"; category: \"permission\" | \"answer\"}` shape. One correctness change falls directly out of the unification and is worth flagging on its own: nl-router.ts's isDestructive gate for the on-transition no longer needs to branch on category at all (`command.kind === \"auto\" && command.on === true` covers both what were separately `bypass on`/`autoanswer on` checks) - one line where there were two. Naming split stated once, explicitly: only the command surface (what the operator types, FleetCommand's shape, FleetConfirmKind's callback literals, /default's category tokens) reads permission/answer; routing.ts's internal bypassBySlug/getBypass/setBypass and autoAnswerBySlug/getAutoAnswer/setAutoAnswer, and the settings-store keys, keep their existing names unchanged since nothing outside the code ever sees them. A fresh /deep-check pass against this restructured shape is still recommended before implementation - consolidating six call sites into fewer, shared ones is itself a place a new bare-else could be introduced."
  - "0.12.0 (2026-08-11): /deep-check run 2, pass 5 — 1 CRITICAL, the sixth and worst instance of this feature's recurring bare-else defect. `handleDefaultCommand` guarded `status` and `mode`, then fell into an unconditional tail that treated everything else as effort — `/default bypass on` landed on `applyDefaultEffort(true)`, silently corrupting the persisted `default_session_effort` key while reporting success and never touching bypass. Fixed by making the effort branch explicit. Superseded in 0.13.0 by converting the whole dispatch to an exhaustive switch."
  - "0.11.0 (2026-08-11): /deep-check run 2, pass 4 — 1 HIGH. The drain (see 0.7.0) ignored `sendVerdict`'s boolean return; a disconnected channel (the crash-resume window 0.2.0 already documents) would edit a card to read \"auto-approved\" while delivering no verdict to anything, past `sweepExpiredPermissions`' reach. Fixed by branching on the return value with honest terminal text, verdict-then-finalize (the reverse of §1.1's own ordering, with the reason stated)."
  - "0.10.0 (2026-08-11): /deep-check run 2, pass 3 — 1 HIGH. `/bypass --all` with no value was undefined behavior landing on a confirm card that said ON and did OFF. Fixed as the bare-reports-status form for the fleet-bulk scope, which also gave the fleet its only bypass-state audit surface."
  - "0.9.0 (2026-08-11): /deep-check run 2, pass 2 — 1 HIGH. Default-scope persistence was specified as a single settings-store key; the real pattern needed is a three-part write-through (index.ts `let`, paired setter/settingsStore.set, live getter) or `/default bypass on` silently stops applying after the first restart while looking correct."
  - "0.8.0 (2026-08-11): /deep-check run 2, pass 1 — 2 CRITICAL + 2 HIGH. (1) The drain (0.7.0) cited `handleStopCommand` as its precedent, but that method deliberately sends no verdict and `sendVerdict` wasn't even injected into the module — copied verbatim, `/bypass on` would wedge the session permanently past any sweep's reach. (2) Session-scoped `/bypass on`/`/autoanswer on` were said to need no `isDestructive` gating \"matching /mode auto's precedent\" — backwards; `/mode auto` **is** gated, for exactly the reason `/bypass` needs it more. (3) `routing.remove` didn't clear the two new maps, and a `/rm`'d slug is reusable. (4) nl-router coverage missed the `defaultCategory` schema enum and the `case \"default\":` fallthrough."
  - "0.7.0 (2026-08-10): /deep-check pass 5 — 1 HIGH. `/bypass on` only affected *future* permission requests, leaving an already-posted card stuck. Added the drain: `permissionRegistry.removeForSlug` + verdict + `finalizePermissionMessage` per entry. `/autoanswer` deliberately does not get the equivalent, argued explicitly."
  - "0.6.0 (2026-08-10): /deep-check pass 4 — 1 HIGH. The auto-approval notice was told to reuse `renderPermissionCard`'s HTML-producing helpers for a plain-text send, which would print literal `<b>`/`<code>` tags. Fixed to plain-text-only."
  - "0.5.0 (2026-08-10): /deep-check pass 3 — 1 HIGH, against pass 1's own fix. The notice was said to use \"the same P1 lane the permission card itself would have used\" — the card actually uses P0. Rewritten as an argued P1 choice rather than a copied claim."
  - "0.4.0 (2026-08-10): /deep-check pass 2 — 2 HIGH, both bare-else-with-a-third-case: a bare `/default bypass` would post the effort picker; `default:bypass:on` matched no existing callback resolver and the button silently did nothing."
  - "0.3.0 (2026-08-10): /deep-check pass 1 — 1 CRITICAL + 6 HIGH. CRITICAL: an invented `postFeedNote()` had no real backing primitive; replaced with `postAutoApprovedNote`, a plain P1 sendMessage. HIGH: naming inconsistency (`isBypassEnabled` vs `getBypass`); `/bypass --all on` would silently parse as slug `--all`; bare `/bypass` had no defined behavior; wrong module for the session-scoped handlers; wrong empty-targets message; wrong types on `postFleetConfirm`'s targets."
  - "0.2.0 (2026-08-10): Pass 1 review (plan-craft) — 1 CRITICAL (nl-router's `isDestructive` claim was backwards for `kill --all`/`rm --all`) + 3 HIGH (wrong parsing analog; missing test/CI caveats; missing resume-nudge-plan interaction)."
  - "0.1.0 (2026-08-10): Initial plan created"
v0251_touched_sections:
  - section: "§5 Testing"
    type: modified
    summary: "Dropped the stale \"No CI yet (P1-6)\" claim — ci.yml enforces both gates on every push/PR."
v0230_touched_sections:
  - section: "§0.3 executeFleetActionDirect"
    type: modified
    summary: "Open MEDIUM resolved: stays narrow at kill|rm, so the compiler enforces what a WARN arm only documents"
  - section: "§0.4 sendDefaultCategoryPicker"
    type: modified
    summary: "Open MEDIUM resolved: takes DefaultPickerCategory, so a boolean category can't reach the drill-down at all"
v0220_touched_sections:
  - section: "§2.2 auto answer mechanism"
    type: modified
    summary: "Investigate-first veto, with the 715-question measurement behind veto-not-select"
  - section: "§0.2 confirmation text"
    type: modified
    summary: "/auto answer on states that investigate-shaped questions still show the buttons"
v0210_touched_sections:
  - section: "§0.2 handleAutoCommand"
    type: added
    summary: "The missing handler body: scope-first dispatch over one autoCategorySpec descriptor"
  - section: "§0.3 applyAutoToggle"
    type: modified
    summary: "Reads spec.drainsOnEnable; supersedes v0.18.0's second exhaustive switch"
  - section: "§0.3 executeFleetConfirm"
    type: modified
    summary: "autoConfirmKind/parseAutoConfirmKind replace an inline split('-') that misreads rm-topic"
  - section: "Overview"
    type: modified
    summary: "Why one descriptor beats N exhaustive switches — recorded because it reverses a prior fix"
v0200_touched_sections:
  - section: "§1.1 Mechanism"
    type: modified
    summary: "Notice is enqueued, not awaited — the await gated every verdict on a ~3s rate-limiter token"
  - section: "§5 Testing"
    type: modified
    summary: "Never-resolving sendMessage fake asserts the verdict still lands"
v0190_touched_sections:
  - section: "§0.3 executeFleetConfirm"
    type: modified
    summary: "Branch placement pinned ahead of the kill/rm loop; both bare-else kind dispatches named; live rows, not pending.slugs"
  - section: "§0.3 postFleetConfirm/executeFleetActionDirect"
    type: modified
    summary: "All five kind ternaries in the file enumerated, not just the empty-targets guard"
  - section: "§5 Testing"
    type: modified
    summary: "Zero-call-count removeSessionRow assertion; summary-verb and stale-slug cases"
v0180_touched_sections:
  - section: "Overview"
    type: modified
    summary: "Switch-site enumeration corrected to §0.2/§0.3/§0.4; the enumeration named as the fragile part of the type-level claim"
  - section: "§0.3 applyAutoToggle"
    type: modified
    summary: "Its category dispatch is a third exhaustive switch, not the bare else its signature invites"
  - section: "§0.5 nl-router wiring"
    type: modified
    summary: "allowedKinds must NOT gain 'auto' — it is a filter of exclusions; both wrong edits named"
  - section: "§2.2 findAutoAnswer"
    type: modified
    summary: "Zero-question guard — the sketch returned [] (non-null) against §4's and §5's stated requirement"
  - section: "§5 Testing"
    type: modified
    summary: "allowedKinds offers 'auto' in both contexts, not just the control topic"
v0170_touched_sections:
  - section: "§0.2 handleAutoCommand"
    type: modified
    summary: "Promise<void>, not void — the --all branch posts a confirm card; kill is the precedent, verbose is not"
  - section: "§3 Module Ownership"
    type: modified
    summary: "Dispatch via fireAndForget like kill/rm, not a bare synchronous call like verbose"
v0160_touched_sections:
  - section: "§0.4 Fleet-default"
    type: modified
    summary: "buildDefaultCategoryKeyboard signature/data source specified; third DefaultCategory ternary (callback-query-router) named"
  - section: "§3 Module Ownership"
    type: modified
    summary: "voice-mode-commands.ts gains the two live getters, not just the setters"
  - section: "§5 Testing"
    type: modified
    summary: "Both-directions keyboard assertion; callback-query-router handle-half case"
v0150_touched_sections:
  - section: "§2.2 auto answer mechanism"
    type: modified
    summary: "writeAnswer takes the socket as a parameter; exact placement in handleAsk pinned to after both guards"
  - section: "§5 Testing"
    type: modified
    summary: "pipe-server ask test asserts the answer message reached the socket, not just that no card was posted"
v0140_touched_sections:
  - section: "§0.1 parseAuto"
    type: modified
    summary: "Command-name registration (FLEET_COMMAND_NAME_RE + parseFleetCommand switch) specified; \\b/autostart ordering hazard called out"
  - section: "§0.3 / §3 / §4"
    type: modified
    summary: "applyAutoToggle introduced as the single set+drain entry point; the --all-skips-the-drain contradiction resolved"
  - section: "§0.5 nl-router wiring"
    type: modified
    summary: "Reused all/on schema field descriptions must name 'auto', or --all is unreachable from NL"
  - section: "§5 Testing"
    type: modified
    summary: "Registration pair (incl. /autostart regression) and the applyAutoToggle-vs-setBypass assertion added"
v0130_touched_sections:
  - section: "Overview"
    type: modified
    summary: "Restructured around one /auto <category> command; naming-split note added"
  - section: "§0 (new) Command parsing & dispatch"
    type: added
    summary: "Consolidates what was separately in §1.3/§1.4/§1.5/§2.3 - one parser, one FleetCommand shape, one nl-router kind, one /default extension, shared by both categories"
  - section: "§1 auto permission / §2 auto answer"
    type: modified
    summary: "Retitled and re-pointed at the shared §0 mechanism; category-specific mechanism (handlePermissionRequest / handleAsk changes, drain vs no-drain) unchanged in substance"
  - section: "§3 Module Ownership & Wiring"
    type: modified
    summary: "handleAutoCommand replaces handleBypassCommand/handleAutoAnswerCommand as one exhaustive-switch entry point"
  - section: "§4 Error Handling"
    type: modified
    summary: "Re-stated against category rather than command name; isDestructive's single-line consolidation noted"
  - section: "§5/§6"
    type: modified
    summary: "Test and doc lists updated to the new command/category names"
---

# Bridge-side auto-approve: the `/auto` command

## Overview

**Audience:** aibridge maintainers/operators implementing against
[`plans/telegram-claude-session-control-plan.md`](telegram-claude-session-control-plan.md) (the
canonical architecture plan — this document is additive to its §6 permission model, not a
replacement; where this plan is silent, that one governs).

This plan adds one operator-controlled Bridge-side command, **`/auto <category> ...`**, that
auto-resolves escalations Claude Code would otherwise post to Telegram for a Yes/No tap. It replaces
the two independently-named commands (`/bypass`, `/autoanswer`) every revision of this plan through
v0.12.0 specified, folded into a single verb with a `category` argument — the same shape this
codebase's own `/default [mode|effort] [<value>]` command already established, which the operator
asked to mirror directly (2026-08-11) rather than remembering two unrelated command names:

- **`/auto permission [on|off]`** — auto-allows tool/command permission prompts (the
  `claude/channel/permission` relay, §6.3/§6.5 of the main plan). Was `/bypass`.
- **`/auto answer [on|off]`** — auto-answers Claude's `AskUserQuestion` calls (§6.4 of the main plan)
  when Claude itself marked a recommended option, otherwise still posts the real question card. Was
  `/autoanswer`.

Both take the identical three scopes `/default` already established the pattern for:

| Scope | Command | Replaces (pre-0.13.0) |
|---|---|---|
| Session | `/auto permission [<slug>] [on\|off]` | `/bypass [<slug>] [on\|off]` |
| Fleet-bulk | `/auto permission --all [on\|off]` | `/bypass --all [on\|off]` |
| Fleet-default | `/default permission [on\|off]` | `/default bypass [on\|off]` |
| Session | `/auto answer [<slug>] [on\|off]` | `/autoanswer [<slug>] [on\|off]` |
| Fleet-bulk | `/auto answer --all [on\|off]` | `/autoanswer --all [on\|off]` |
| Fleet-default | `/default answer [on\|off]` | `/default autoanswer [on\|off]` |

**Extensibility is the point, not just tidiness.** `category` is a real discriminant
(`"permission" | "answer"` today), not a stringly-typed afterthought — a hinted future category
(e.g. `/auto ship [on|off]`, gating a checks-review-ship pipeline behind the same toggle shape) adds
one arm to `autoCategorySpec` (§0.2) plus one to `parseAutoConfirmKind` (§0.3), rather than a new
top-level command, a new `FleetConfirmKind` pair, and a new `/default` extension built from scratch.
This plan does not design that future category — it only confirms the dispatch shape doesn't have to
change to accommodate one.

**Why the category is resolved once, into a descriptor, rather than switched on at each site.** Four
review runs of this plan found nine instances of the same defect: a two-way `if`/`else` or ternary
that silently absorbs a third case. Twice (v0.16.0, v0.18.0) the *fix* was "add another exhaustive
switch," and twice the next run found a site the enumeration had missed — because a guarantee spread
across N sites is only as good as someone remembering all N, and nobody did. §0.2's `autoCategorySpec`
collapses those to one `never` arm that every consumer reads through. `/default`'s own
`DefaultCategory` sites (§0.4) stay separate: that union is not this one, and merging them would
couple two commands' extensibility together for no benefit.

**Naming split — stated once, so it isn't rediscovered mid-implementation.** Only the *command
surface* uses `"permission"`/`"answer"`: what the operator types, `FleetCommand`'s parsed shape,
`FleetConfirmKind`'s callback literals, and `/default`'s category tokens. The deeper implementation
layer this plan already specified and hardened keeps its existing names unchanged — `routing.ts`'s
`bypassBySlug`/`getBypass`/`setBypass`, `autoAnswerBySlug`/`getAutoAnswer`/`setAutoAnswer`, and the
`default_bypass_enabled`/`default_autoanswer_enabled` settings-store keys. Nobody outside the code
ever sees those, so renaming them would be pure churn with no user-facing benefit. Every citation
below says explicitly which layer it's describing.

Both categories were requested directly by the operator after two dead ends were investigated and
ruled out live on 2026-08-10 (recorded in §7 below): Claude Code's own local `auto` permission mode
doesn't actually eliminate the operator's problem (it still prompts for every `permissions.ask` match
and can silently fall back to full manual prompting), and separately, `/default mode auto`
(session-commands.ts/voice-mode-commands.ts, shipped earlier) turned out to be live-broken — new
sessions never actually reach `auto` mode at all. Both categories here are Bridge-relay-level
mechanisms instead: they intercept the escalation *after* Claude Code has already decided to raise
it, independent of whatever local permission mode the session happens to be in, so neither
pre-existing problem affects them.

**The one deliberate, non-negotiable safety floor:** `permissions.deny` (settings.ts's
`generateSettings` — `Bash(rm -rf /*)`, `Bash(git push --force *)`, secret-file reads, etc.) never
raises a `PermissionRequest` at all — Claude Code refuses those calls outright before the relay is
ever consulted (main plan §6.1.1's precedence chain: hooks → deny → ask → mode → allow → prompt).
Neither category can touch that path structurally, because there is nothing for either to intercept.
Everything else described below (most importantly: `permissions.ask` — git commit/push, PR merge, npm
publish) *is* reachable and *is* deliberately auto-allowed by `/auto permission on`. That is the
whole point of the feature, and every confirmation string below says so plainly rather than softening
it.

## §0 The `/auto` command: shared parsing and dispatch

This section covers what both categories share — one parser, one `FleetCommand` shape, one
`nl-router.ts` kind, one `/default` extension. §1 and §2 cover only what's genuinely different between
the two categories (the permission-relay mechanism vs. the ask mechanism, and the drain-on-`on`
behavior that applies to one but not the other).

### §0.1 `FleetCommand` shape and `parseAuto`

One new `FleetCommand` variant replaces the two (`bypass`, `autoanswer`) every earlier revision
specified:

```ts
{ kind: "auto"; category: "permission" | "answer"; slug?: string; all?: boolean; on?: boolean }
```

`parseAuto` mirrors `parseDefault` (`fleet-commands.ts:329-343`) for the category token, then
`parseKill`'s flag-first shape (`fleet-commands.ts:208-217`) combined with `parseSlugAndValue`
(line 164) + `isOnOff` (line 182) — the same two precedents §1.3/§2.3 already cited in every prior
revision, just consumed by one function instead of two:

```ts
function parseAuto(rest: string): FleetCommand | null {
  const tokens = rest.trim().split(/\s+/).filter((t) => t.length > 0);
  const [category, ...restTokens] = tokens;
  if (category !== "permission" && category !== "answer") return null;
  const all = restTokens.includes("--all");
  const withoutAll = restTokens.filter((t) => t !== "--all");
  if (all) {
    if (withoutAll.length === 0) return { kind: "auto", category, all: true }; // bare-status form, §0.3
    if (withoutAll.length === 1 && isOnOff(withoutAll[0]!)) return { kind: "auto", category, all: true, on: withoutAll[0] === "on" };
    return null; // matches parseKill's "--all must be the sole remaining token" strictness
  }
  const parsed = parseSlugAndValue(withoutAll.join(" "), isOnOff);
  if (!parsed) return null;
  return { kind: "auto", category, slug: parsed.slug, on: parsed.value === undefined ? undefined : parsed.value === "on" };
}
```

`--all` needs the same `KNOWN_FLAG_WORDS` (`fleet-commands.ts:86-120`) coverage every other
`--all`-taking command already has, so `-all` normalizes to `--all` here too.

**`parseAuto` is unreachable until `/auto` is registered as a command name — two edits, both
mandatory, both easy to miss because they live nowhere near the parser they gate:**

1. **`FLEET_COMMAND_NAME_RE` (`fleet-commands.ts:440`) gains `auto`.** This single regex is the
   *only* thing that decides whether a `/`-prefixed message is a fleet command at all — it backs both
   `parseFleetCommand` (line 461) and `matchFleetCommandName` (line 450).
2. **`parseFleetCommand`'s switch (lines 465-525) gains `case "auto": return parseAuto(rest);`**,
   alongside `case "default":` at line 502.

Without #1 the feature is not merely inert, it is **silently swallowed**: `/auto permission on`
returns `null` from *both* functions, so `command-dispatch.ts` reads it as "not a fleet command at
all" rather than "recognised command, bad argument", and the message falls through to NL routing or
straight into the session as literal chat text — the exact operator-reported failure
`matchFleetCommandName`'s own doc comment (lines 442-449) exists to describe and prevent. Every
other section of this plan (§0.2's dispatch, §3's wiring, §5's tests) presupposes a parsed
`{ kind: "auto" }` that can never be produced.

**Ordering note for #1, because getting it wrong breaks an unrelated shipped command:** the
alternation already contains `autostart`. Adding `auto` is safe *only* because the group is followed
by a shared `\b` — matching `auto` against `/autostart install` leaves the boundary assertion between
`o` and `s`, which fails, forcing the engine to backtrack into the `autostart` alternative. Add the
alternative to this existing regex rather than writing a new match; a hand-rolled `startsWith("/auto")`
or an alternation without the trailing `\b` silently re-routes every `/autostart` invocation into
`parseAuto`, which rejects `install`/`uninstall` as an unknown category and returns `null`. Test both
`/auto permission on` and `/autostart status` in the same `fleet-commands.test.ts` case (§5).

**Required parse cases, carried over from every prior revision's own hard-won findings (§5 restates
these as tests):**
- `/auto permission --all on` → `{ kind: "auto", category: "permission", all: true, on: true }` —
  **not** `slug: "--all"`, the exact silent-wrong outcome `parseSlugAndValue` falls into unless
  `--all` is stripped first (v0.3.0's finding).
- `/auto permission --all` (no value) → `{ kind: "auto", category: "permission", all: true }`, the
  bare-status form (§0.3) — **not** a confirm card, since the value-less form has no `on`/`off` to
  build one from and the naive fallback (a card whose fixed prompt says ON, a Yes button coercing
  `undefined` to falsy) turns bypass **off** fleet-wide on tap (v0.10.0's finding).
- `/auto permission --all extra on` → `null` — `--all` must be the sole token alongside it, matching
  `parseKill`'s strictness; a creative fallthrough would target a session literally named
  `"--all extra"`.
- Bare `/auto permission` (no slug, no value, from inside a session's own topic) →
  `{ kind: "auto", category: "permission", on: undefined }` — reports status, never toggles (§0.2).
- `/auto ship` or any other unrecognized category token → `null`, a parse error, not a silent
  fallthrough to one of the two known categories.

### §0.2 Session scope, one handler: `handleAutoCommand`

Lives in `session-lifecycle-commands.ts`, next to `handleVerboseCommand` — **not**
`voice-mode-commands.ts`. This is forced, not stylistic: it needs `resolveSessionOrBail`
(`session-lifecycle-commands.ts:199`) to turn an optional `<slug>` + current topic into a live row
(or post the resolution error and bail), and that function is a **private closure** inside
`createSessionLifecycleCommands` — not exported, not on the returned `SessionLifecycleCommands`
interface (verified: the returned object lists `handleNewCommand` … `handleVerboseCommand`, no
`resolveSessionOrBail`). A handler placed in `voice-mode-commands.ts` cannot call it at all, and
would have to either duplicate the resolve-or-bail logic (the exact repetition that function was
extracted to eliminate across six call sites) or widen the interface just to export an internal
helper.

**One handler, dispatching on *scope*, with category resolved once through a single exhaustive
`switch`.** Revisions 0.13.0–0.20.0 sketched this the other way round — `switch (cmd.category)`
delegating to `handleAutoPermission`/`handleAutoAnswer` — and never defined either function. That
shape is wrong on its own terms, not merely incomplete: all three scopes (bare reports status,
explicit `on`/`off` sets, `--all` posts a confirm card) are **category-agnostic**, so splitting by
category first forces the entire scope tree to be written twice, in direct contradiction of this
section's own "described once instead of twice" claim. What genuinely differs between the categories
is four values, not four code paths.

So: resolve the category to a descriptor through one exhaustive `switch`, then run one scope tree
over it.

```ts
/** The *only* place `/auto`'s categories are enumerated. Every other site in this feature —
 * `handleAutoCommand`'s scope tree, `applyAutoToggle` (§0.3), `executeFleetConfirm`'s branch (§0.3) —
 * consumes this descriptor instead of switching again, so "a new category fails to compile" is one
 * `never` arm rather than a discipline repeated across the codebase and eventually forgotten (which
 * is how this feature accumulated nine instances of that defect; see below). */
interface AutoCategorySpec {
  /** Operator-facing noun: "Auto-permission" / "Auto-answer". */
  readonly label: string;
  readonly get: (slug: string) => boolean;
  readonly set: (slug: string, on: boolean) => void;
  /** Whether turning this category ON drains that session's already-pending escalations.
   * `permission` does; `answer` deliberately does not (§4's stated asymmetry). */
  readonly drainsOnEnable: boolean;
  /** Full confirmation text for the on/off transitions, per the strings at the end of this section. */
  readonly confirmation: (slug: string, on: boolean) => string;
}

function autoCategorySpec(category: AutoCategory): AutoCategorySpec {
  switch (category) {
    case "permission":
      return {
        label: "Auto-permission",
        get: (slug) => routing.getBypass(slug),
        set: (slug, on) => routing.setBypass(slug, on),
        drainsOnEnable: true,
        confirmation: renderAutoPermissionConfirmation,
      };
    case "answer":
      return {
        label: "Auto-answer",
        get: (slug) => routing.getAutoAnswer(slug),
        set: (slug, on) => routing.setAutoAnswer(slug, on),
        drainsOnEnable: false,
        confirmation: renderAutoAnswerConfirmation,
      };
    default: {
      const _exhaustive: never = category;
      throw new Error(`unhandled /auto category: ${_exhaustive}`);
    }
  }
}
```

`AutoCategory` (`"permission" | "answer"`) is exported from `fleet-commands.ts` alongside the
`FleetCommand` variant, so `routing.ts`, `fleet-confirm.ts`, and this module all name the same type
rather than re-spelling the union.

The handler itself is then the scope tree, once:

```ts
async function handleAutoCommand(
  cmd: Extract<FleetCommand, { kind: "auto" }>,
  topicId: number | undefined,
  currentSlug: string | undefined,
): Promise<void> {
  const spec = autoCategorySpec(cmd.category);

  // Fleet-bulk (§0.3). Checked before `resolveSessionOrBail`: `--all` names no session, and
  // resolving one first would reject `/auto permission --all on` from the control topic outright.
  if (cmd.all) {
    const targets = sessionStore.all().filter((r) => isLive(r) && r.slug !== selfCheckSlug);
    if (cmd.on === undefined) {
      // Bare `--all` reports fleet status and must never reach the confirm card (§0.3).
      confirmSessionCommand(
        topicId,
        targets.length === 0
          ? "No live sessions."
          : targets.map((r) => `${r.slug}: permission ${routing.getBypass(r.slug) ? "on" : "off"}, answer ${routing.getAutoAnswer(r.slug) ? "on" : "off"}`).join("\n"),
      );
      return;
    }
    await postFleetConfirm(autoConfirmKind(cmd.category, cmd.on), topicId, targets, renderAutoFleetConfirmPrompt(spec, cmd.on));
    return;
  }

  // Session scope: optional <slug>, or bare from inside the session's own topic.
  const row = resolveSessionOrBail(cmd.slug, currentSlug, topicId);
  if (!row) return;

  if (cmd.on === undefined) {
    confirmSessionCommand(topicId, `"${row.slug}" ${spec.label.toLowerCase()}: ${spec.get(row.slug) ? "on" : "off"}.`);
    return;
  }

  applyAutoToggle(row.slug, cmd.category, cmd.on);   // set + drain, §0.3 — never `spec.set` directly
  confirmSessionCommand(topicId, spec.confirmation(row.slug, cmd.on));
}
```

Three details in there are load-bearing and each has already been a finding:

- **`cmd.all` is tested before `resolveSessionOrBail`.** `--all` carries no slug, and from the control
  topic there is no `currentSlug` either, so resolving first turns every fleet-bulk invocation into a
  "which session did you mean?" rejection.
- **The bare-`--all` status branch returns before `postFleetConfirm`** — v0.10.0's finding: a card
  built from `on: undefined` says ON and does OFF.
- **The set goes through `applyAutoToggle`, never `spec.set`.** `spec.set` exists for
  `applyAutoToggle`'s own use and for §0.4's new-session default (which has nothing to drain); calling
  it here skips the drain (§0.3, v0.14.0's finding). `applyAutoToggle` reads `drainsOnEnable` off the
  same descriptor, which is what lets it stop switching on category itself.

**It is `Promise<void>`, not `void` — the right precedent for this handler's shape is
`handleKillCommand`, not `handleVerboseCommand`.** `handleVerboseCommand` is the precedent for the
*bare-reports-status* branch and for living next to `resolveSessionOrBail`, and nothing more: it has
no `--all` form, so it is synchronous. `/auto <category> --all on` must post a Yes/No confirm card
through the injected `postFleetConfirm` (`SessionLifecycleCommandsOptions:62`, `Promise<void>`) —
exactly what `handleKillCommand` already does for its own `--all` branch, and exactly why that one is
`async`. A `void`-typed handler can only drop that promise on the floor: no `fireAndForget` label to
attribute a failure to, and §5's `--all` tests have nothing to await before asserting the card was
posted, against an interface that says there is nothing to wait for. Declare it `Promise<void>` on
`SessionLifecycleCommands` and dispatch it the way `kill`/`rm` are dispatched (§3).

**This exhaustive-switch shape is a deliberate, load-bearing choice, not a style preference — say why
explicitly wherever this pattern is copied.** Every prior revision of this plan (v0.4.0 through
v0.12.0) found the *same* defect in six different places across five files: a two-way branch written
as an `if`/`else` (or a ternary) that silently absorbed a third case into whichever branch happened
to be last, and every one of the six compiled cleanly under `tsc`. The worst of them
(`handleDefaultCommand`'s implicit-effort tail, v0.12.0) corrupted a persisted setting the operator
wasn't even editing. A `switch` with an explicit `never`-typed `default` arm turns "a new category
silently falls into the wrong branch" into "this doesn't compile" the moment a third category is
added — the exact failure class this feature has demonstrated six times, closed at the type level
instead of by author discipline. `handleDefaultCommand` (§0.4) and `sendDefaultCategoryPicker`'s
dispatch (§0.4) both get the identical treatment for the identical reason.

Bare-reports-status and `--all`-stripping are unchanged from every prior revision, just described once
instead of twice. The in-memory-only state convention below was reversed in v0.24.0 — kept here with
that history noted rather than silently rewritten, since the "why" of the reversal matters as much as
the "what":
- **Bare `/auto <category>` (no value) reports status, never toggles** — same precedent as
  `handleVerboseCommand`'s `if (cmd.on === undefined)` branch (`session-lifecycle-commands.ts:728-731`).
  A status read must never flip a safety gate; `FleetCommand.on` being optional (not a required
  boolean) is what makes this representable at all.
- **State** (revised v0.24.0): `bypassBySlug: Map<string, boolean>` / `autoAnswerBySlug: Map<string,
  boolean>` in `routing.ts`, alongside the existing `modeBySlug`/`effortBySlug` maps —
  `getBypass`/`setBypass`, `getAutoAnswer`/`setAutoAnswer`, defaulting to `false`. Through v0.23.0
  these were in-memory only, cleared on every **Bridge** process restart (a fresh `Routing` instance) —
  argued as a deliberate fail-closed choice mirroring `permission-registry.ts`'s "a restart declares a
  pending prompt lost, never silently reconstructed" stance one level up. v0.24.0's changelog entry
  explains why that argument doesn't actually hold for a *standing toggle* the way it holds for a
  *pending prompt*, and reverses it: `setBypass`/`setAutoAnswer` now write through to
  `session-store.ts`'s `bypass_permission`/`auto_answer` columns (via an injected
  `AutoTogglePersistence`, optional so tests and the self-check route keep the old in-memory-only
  shape), and `session-supervisor.ts`'s `resumeSession` restores both from the persisted row on every
  crash-resume via `hydrateAutoToggles` — a value-restore, deliberately not routed through
  `setBypass`/`setAutoAnswer` themselves. A session-level `claude --resume` (crash-resume, §12 Phase 5)
  already left this state untouched even before v0.24.0 (it only ever cleared on a full **Bridge**
  process restart) — see §4's note on what that means for the resume-nudge plan.
- **`routing.remove(slug)` must delete both maps too.** `remove` (`routing.ts:52-62`) already deletes
  `bySlug`, `slugByTopicId`, `ptyWriteBySlug`, `modeBySlug`, `effortBySlug`, `ringBufferBySlug`;
  `bypassBySlug.delete(slug)`/`autoAnswerBySlug.delete(slug)` join that list. This is safety-relevant,
  not just tidy bookkeeping: `uniqueSlug` (`slug.ts:39-45`) de-duplicates only against *live* slugs,
  so once `/rm fix-bug` deletes that row, the name `fix-bug` is free again — without this, a later
  session reusing that name would silently start fully auto-permitted, with no confirmation
  announcing it. The existing `routing.test.ts` case at line 59 ("remove forgets the slug, its topic
  mapping, pty write function, mode and effort") is the exact test to extend.

Confirmation text:
- `/auto permission on`: *"🔓 Auto-permission is now ON for \"\<slug\>\" — every permission prompt
  this session would raise, including git commit/push, PR merge/create, npm publish, and anything
  else on the ask list, is auto-allowed with no Telegram prompt. `permissions.deny` (force-push,
  secret reads, `rm -rf /`) still hard-blocks regardless — this cannot bypass that. This persists
  across a Bridge restart — `/auto permission off` to revert."* (revised v0.24.0 — see the state
  bullet above; this used to say "it also resets to off on every Bridge restart")
- `/auto permission off`: *"Auto-permission is now off for \"\<slug\>\" — permission prompts resume
  as normal."*
- `/auto answer on`: *"🔓 Auto-answer is now ON for \"\<slug\>\" — when Claude marks exactly one
  option as its recommendation, that question is answered automatically with no card posted. Any
  question without a clear recommendation still shows you the real buttons, unchanged. `/auto answer
  off` to revert."*

### §0.3 Fleet-bulk (`--all`)

`/auto <category> --all [on|off]` flips every currently-running session at once, through the exact
`/kill --all`/`/rm --all` Yes/No confirm-card mechanism (`fleet-confirm.ts`, `fleet-confirm-flow.ts`)
rather than executing immediately.

- `fleet-confirm.ts`'s `FleetConfirmKind` (currently `"kill" | "rm" | "rm-topic"`, line 4) gains four
  literals: `"permission-on" | "permission-off" | "answer-on" | "answer-off"` (renamed from the
  pre-0.13.0 `bypass-*`/`autoanswer-*` to match the command surface — `resolveFleetConfirmCallback`'s
  regex, line 54, gains the four alternatives).
- **`fleet-confirm-flow.ts`'s `executeFleetConfirm` (line 143) gains a branch for these four kinds,
  and *where* that branch goes is the single most dangerous detail in this plan.** The four new kinds
  must be handled by an **early-return block placed before the kill/rm loop**, structurally mirroring
  the `pending.kind === "rm-topic"` block that already sits at the top of this function (lines
  146-159) for exactly the same reason — it, too, is a kind the main loop cannot handle.

  The reason this is not a stylistic preference: the main loop at lines 163-169 reads

  ```ts
  for (const row of rows) {
    if (pending.kind === "kill") {
      await sessionLifecycle.killSessionRow(row);
    } else if (!(await sessionLifecycle.removeSessionRow(row))) {   // <-- the bare else
      allTopicsDeleted = false;
    }
  }
  ```

  That `else` means "rm" only because `kill | rm | rm-topic` minus the early return leaves exactly
  one kind. Widen `FleetConfirmKind` by four literals without placing the new branch ahead of this
  loop and the `else` silently absorbs all four — **the operator taps "✅ Yes, proceed" on a card
  reading *"Turn auto-permission ON for every live session?"* and the Bridge removes every one of
  them**, then finalizes the card *"Removed 4 sessions: a, b, c, d"* courtesy of line 170's second
  bare else (`const verb = pending.kind === "kill" ? "Killed" : "Removed"`). Nothing about this fails
  to compile: `pending.kind === "kill"` and the ternary both stay well-typed as the union grows. This
  is the ninth instance of the defect class §0.2 catalogues and by a wide margin the worst — every
  prior instance corrupted a setting or dead-ended a button; this one destroys the operator's entire
  running fleet from a tap that said the opposite. Convert **both** of this function's `kind`
  dispatches (the loop and the `verb`/`note` tail) along with adding the branch.

  The branch itself: no `killSessionRow`/`removeSessionRow` call at all — decompose `pending.kind`
  into `(category, on)`, call **`applyAutoToggle(slug, category, on)`** (below) per target, and
  finalize with a summary (`"Auto-permission ON for 3 sessions: a, b, c"`).

  **The decomposition is a named pair of helpers in `fleet-confirm.ts`, not an inline `split("-")`.**
  `FleetConfirmKind` already contains `"rm-topic"`, which a generic hyphen-split happily reads as
  category `"rm"`, value `"topic"` — so the stringly approach turns a `/rm --all` tap into an
  auto-toggle call on a category that doesn't exist. Colocate both directions with the type they
  encode, so the format can only be changed in one place:

  ```ts
  export type AutoConfirmKind = `${AutoCategory}-${"on" | "off"}`;
  export const autoConfirmKind = (category: AutoCategory, on: boolean): AutoConfirmKind => `${category}-${on ? "on" : "off"}`;
  /** Null for every non-auto kind (`kill`/`rm`/`rm-topic`), which is what makes this safe to call
   * as the branch predicate itself rather than after a separate membership test. */
  export function parseAutoConfirmKind(kind: FleetConfirmKind): { category: AutoCategory; on: boolean } | null {
    switch (kind) {
      case "permission-on":  return { category: "permission", on: true };
      case "permission-off": return { category: "permission", on: false };
      case "answer-on":      return { category: "answer", on: true };
      case "answer-off":     return { category: "answer", on: false };
      default:               return null;
    }
  }
  ```

  `executeFleetConfirm`'s new block is then `const auto = parseAutoConfirmKind(pending.kind); if (auto) { … return; }`,
  placed directly after the `rm-topic` block — one predicate, no membership list to keep in sync, and
  the four literals enumerated exactly once. (The `default: return null` arm is deliberate here where
  §0.2 uses `never`: this function is *asked about* kinds it doesn't own, so an unrecognised kind is
  the normal case, not a bug.)
- **Iterate the re-looked-up live rows, not `pending.slugs` — the raw slug array is a trap here in a
  way it is not for kill/rm.** This function already re-resolves rows by slug (line 161,
  `pending.slugs.map((s) => sessionStore.get(s)).filter(...)`) precisely because a session can die or
  be removed in the minutes between posting the card and the tap, and §4 states the new branch
  inherits that behavior. Calling `applyAutoToggle` over `pending.slugs` directly instead re-creates
  the exact hazard §0.2's `routing.remove` bullet exists to close, from the other end: post
  `/auto permission --all on` with `[a, b, c]` pending → `/rm b` (which runs `routing.remove("b")`,
  clearing `bypassBySlug`) → tap Yes → `applyAutoToggle("b", …)` writes `bypassBySlug["b"] = true` for
  a session that no longer exists. `uniqueSlug` (`slug.ts:39-45`) de-duplicates only against *live*
  slugs, so the name `b` is free again, and the next session to claim it starts fully auto-permitted
  with nothing announcing it. Skip slugs with no live row, exactly as the kill/rm path already does.
- **`applyAutoToggle` is the one place the toggle is actually applied, and both scopes must go
  through it.** A bare `routing.setBypass` call here would be wrong, not just non-DRY: §4 requires the
  `on` transition to *drain* that session's already-pending permission requests (verdict + card
  finalize), and `executeFleetConfirm` calling the setter directly skips that entirely — `/auto
  permission --all on` would flip every flag and leave every already-posted card wedged forever,
  which is the precise failure the drain exists to prevent and which an operator hitting `--all on`
  is *more* likely to be in the middle of than one toggling a single session. So:

  ```ts
  /** Set + drain, in that order. The only supported way to change either toggle for a live session.
   * `handleAutoCommand` (§0.2) and `executeFleetConfirm` (§0.3) are its two callers; §0.4's
   * new-session default calls `spec.set` directly instead, and only because a session that doesn't
   * exist yet has nothing pending to drain. */
  applyAutoToggle(slug: string, category: AutoCategory, on: boolean): void;
  ```

  **Its body must not switch on `category` — it reads §0.2's descriptor.** The two categories do
  genuinely diverge here: `permission` sets its flag *and*, on the `on` transition, runs §4's drain;
  `answer` sets its flag and deliberately runs no drain (§4's stated asymmetry). Written the obvious
  way — `if (category === "permission") { setBypass + drain } else { setAutoAnswer }` — that bare
  `else` is the eighth instance of the defect §0.2 catalogues: the Overview's own hinted `/auto ship
  on` would reach `applyAutoToggle(slug, "ship", true)`, land in the `else`, silently turn
  **auto-answer** on, and report *"ship mode is now ON"* — a safety toggle the operator never touched,
  flipped by a command about something else, under a confirmation saying otherwise.

  Resolving that with a second exhaustive `switch` here would work, and is what v0.18.0 specified.
  §0.2's descriptor is the better answer and supersedes it: this function becomes

  ```ts
  function applyAutoToggle(slug: string, category: AutoCategory, on: boolean): void {
    const spec = autoCategorySpec(category);
    spec.set(slug, on);
    if (on && spec.drainsOnEnable) drainPendingPermissions(slug);
  }
  ```

  which has no category dispatch left to get wrong. The type-level guarantee is unchanged in strength
  and improved in placement: a new category still fails to compile, but at *one* `never` arm
  (`autoCategorySpec`) instead of one per consumer. That matters because the enumeration of consumers
  is exactly what this feature has repeatedly gotten wrong — v0.16.0 missed a `DefaultCategory` site,
  v0.18.0 missed this one, and both were found only by re-deriving the list from the type. A guarantee
  that depends on remembering every site is the thing that keeps failing; one that depends on a single
  site cannot.

  It is exported on `SessionLifecycleCommands` (that module already owns `permissionRegistry`,
  `finalizePermissionMessage`, and — per §3 — the new `sendVerdict`), and `fleet-confirm-flow.ts`
  receives it as **one new injected dependency** on its existing `sessionLifecycle` option, the same
  way it already receives `killSessionRow`/`removeSessionRow`.
- **Resolved as implemented (v0.23.0): `executeFleetActionDirect` was left narrow at `"kill" | "rm"`,
  not widened.** The bullet below argued for widening it because "unreachable because of a parser two
  files away" is not a property a reader of that function can see. It is, though, if the signature
  says so — and unlike a widened type plus a WARN default arm, the compiler enforces it at every call
  site. Its doc comment now records what to do if `--force` is ever added to `/auto`: widen it *and*
  give it the same `parseAutoConfirmKind` early return `executeFleetConfirm` has, since its loop
  carries the identical bare-else hazard. `postFleetConfirm` *did* widen (to `FleetBulkKind`), and
  both of its and `executeFleetConfirm`'s empty-targets/verb ternaries became one `BULK_KIND_COPY`
  lookup with a `satisfies Record<FleetBulkKind, …>` exhaustiveness check.
- `postFleetConfirm`/`executeFleetActionDirect`'s `kind` parameter (`fleet-confirm-flow.ts:101/123`,
  and the identical option on `SessionLifecycleCommandsOptions` at lines 62-63) widen to accept the
  four new literals. **Every `kind` ternary they reach widens with them — there are five in this file
  and the bullet above covers only two.** `postFleetConfirm`'s empty-targets guard (line 125,
  `kind === "kill" ? "No live sessions to kill." : "No sessions to remove."`) would print a teardown
  message for a permission/answer command; `executeFleetActionDirect` carries a byte-identical guard
  (line 182) plus the same `killSessionRow`-or-`removeSessionRow` loop (187-191) and `verb` ternary
  (193) as `executeFleetConfirm`. Those three are unreachable *today* — `parseAuto` never produces
  `--force`, so nothing routes a new kind into `executeFleetActionDirect` (see the YAGNI note below on
  whether to widen it at all) — but "unreachable because of a parser two files away" is not a property
  a reader of this function can see, and it stops being true the moment anyone adds `--force` to
  `/auto`. Replace each with a per-kind lookup (`"No live sessions to change."`, `"Updated"`) rather
  than a third and fourth branch on the same ternary, and log at WARN in the unreachable default arm
  instead of silently picking a teardown verb — the same exhaustive-dispatch discipline §0.2 argues
  for, applied to all five sites rather than the one that happened to get noticed first.
- Targets are `readonly SessionRow[]`, built from `sessionStore.all()` (not `routing.all()`, which
  returns the narrower `SessionRoute[]`), filtered to live sessions, with the same
  `config.selfCheck.slug` exclusion `/kill --all`/`/rm --all` already apply.
- **`nl-router.ts`'s `isDestructive`**: the `--all` forms are excluded (same reason `kill --all`/
  `rm --all` are — they already post their own confirm card, and a second gate would be redundant);
  the session-scoped `on` forms are *included* (`nl-router.ts:90`'s `/mode auto` gating is the real
  precedent — its own comment names "stop asking me for permission on this one" as a very plausible
  fuzzy match, which describes `/auto permission` more exactly than it describes `/mode auto`).
  **The unification collapses this to one line**, since both categories need identical gating on
  identical conditions: `if (command.kind === "auto" && command.on === true) return !command.all;` —
  where the four separate `bypass`/`autoanswer` × on/off/--all checks earlier revisions specified
  would have needed two nearly-identical lines, one line now covers both categories because neither
  the gating condition nor its rationale differs between them.
- **`/auto <category> --all` with no value reports fleet status; it must never reach the confirm
  card.** Same bare-reports-status rule as §0.2, and not a nicety: `FleetConfirmKind` carries the
  *value* in the kind itself, and the confirm prompt is a fixed string that says ON. A command parsed
  with `on: undefined` has no valid kind to construct — the likely failure is a card reading "Turn
  auto-permission ON for every live session?" whose Yes button coerces `undefined` to falsy and turns
  it **off** everywhere, a button that says one thing and does the opposite fleet-wide. Printing one
  line per live session (`fix-bug: permission on, answer off`, …) instead also closes the only real
  observability gap this in-memory design otherwise has — there is no `/ls` column for either flag,
  and no other way to ask "which sessions currently have this on?"

Confirm-card prompt text (reached only by explicit `on`/`off`): *"⚠️ Turn auto-permission ON for every
live session? This auto-allows ALL permission prompts (including git commit/push) with no further
Telegram confirmation, for:\n\<slugs\>"* (and the `answer` equivalent).

### §0.4 Fleet-default, via the existing `/default` command

**Not** a standalone `/defaultpermission`/`/defaultanswer` command — the operator rejected that shape
for the pre-unification names too (tried `/defaultbypass`, got "Unknown command", pointed out
`/default` already owns per-command defaults). `/default permission [on|off]` and `/default answer
[on|off]` extend the existing `/default [mode|effort] [<value>]` command with two more single-token
categories, exactly parallel to `mode`/`effort`.

- `fleet-commands.ts`'s `FleetCommand` `default` kind (lines 72-74) gains
  `{ kind: "default"; category: "permission"; value?: boolean } | { kind: "default"; category:
  "answer"; value?: boolean }`.
- `parseDefault` (`fleet-commands.ts:329-343`) gains two more branches parsing `"on"`/`"off"` into a
  boolean, following the exact shape its own `mode`/`effort` branches already use (`rawValue ===
  undefined` → bare category; otherwise validate against the allowed set or return `null`).
- **Keyboard shape**: `mode`/`effort` are N-valued pickers (`buildDefaultCategoryKeyboard`,
  `session-commands.ts:167`, shows one row per category with the current value, drilling into
  `buildLevelKeyboard`-based value pickers, line 110). `permission`/`answer` are booleans, not
  one-of-N — no drill-down picker. `buildDefaultCategoryKeyboard` gains two more rows, each a direct
  toggle button (`"Permission: OFF (tap to turn ON)"` / `"Answer: ON (tap to turn OFF)"`) whose
  `callback_data` is `default:permission:on`/`default:permission:off` (the *inverse* of the current
  value) — tapping applies immediately, no intermediate screen, deliberately a different shape from
  mode/effort's two-step flow rather than forcing a boolean through the N-valued picker.
- **Both new rows are current-value-dependent in two places at once, so the value has to be plumbed
  in — the signature change is not incidental.** `buildDefaultCategoryKeyboard`
  (`session-commands.ts:167`) is `(currentMode: Mode, currentEffort: Effort)` today, matching
  mode/effort rows whose `callback_data` is a fixed `default:mode`/`default:effort` and whose label
  is the only value-dependent part. A toggle row is different: its label *and* its `callback_data`
  both derive from the current value. The signature becomes
  `(currentMode, currentEffort, currentBypass: boolean, currentAutoAnswer: boolean)`, and its sole
  caller `sendDefaultStatusCard` (`voice-mode-commands.ts:233-242`, which already reads
  `getDefaultSessionMode()`/`getDefaultSessionEffort()` into locals on line 234-235) reads the two
  new live getters the same way — which is why §3 gives `voice-mode-commands.ts` the two **getters**
  as well as the two setters. Leaving this unstated is not a cosmetic gap: an implementer with no
  current value to hand has to hardcode the `callback_data`, and a row that always emits
  `default:permission:on` is a button that turns the default on and then can never turn it off, on a
  card whose own label claims it will.
- **Resolved as implemented (v0.23.0): the picker path is typed narrowly rather than widened.**
  `session-commands.ts` now splits the type — `DefaultPickerCategory` (`mode | effort`),
  `DefaultToggleCategory` (`permission | answer`), `DefaultCategory` the union of both.
  `sendDefaultCategoryPicker` takes the *picker* type and `resolveDefaultCategoryCallback` returns it,
  so the two boolean categories cannot reach the drill-down path at all — a compile error instead of a
  runtime `never` arm. Both still carry an exhaustive switch for the next category added. The
  `callback-query-router.ts` ternary the bullet below names is correct for the same reason: its
  `action.category` is now the two-literal picker type, and the boolean categories arrive as a
  separate `kind: "toggle"` action.
- **`handleDefaultCommand`'s dispatch must be an exhaustive `switch` over `cmd.category`, not the
  current `if`/`if`/implicit-tail shape — this is the single most damaging finding either revision of
  this plan produced, and the fix is now stronger than what v0.12.0 specified.** The current code
  (`voice-mode-commands.ts:282-300`) reads: `if (cmd.category === "status") {…}`, `if (cmd.category
  === "mode") {…}`, then an unconditional tail that treats everything else as effort. Traced through
  `/default permission on`: both guards miss, the no-value picker escape misses (`cmd.value` is
  `true`), and control falls to `confirmSessionCommand(topicId, applyDefaultEffort(cmd.value))`.
  `applyDefaultEffort(true)` calls `setDefaultSessionEffort(true)` **and**
  `settingsStore.set("default_session_effort", true)` — writing a boolean into the effort key,
  reporting *"New sessions will now start at true effort,"* leaving `permission` untouched, and
  corrupting a persisted setting the operator never asked to change, one that `index.ts:191` reads
  back at every startup. v0.12.0's fix (add an explicit `if (cmd.category === "effort")` guard) works,
  but with four categories now instead of three, the root fix is to convert the whole function to an
  exhaustive `switch (cmd.category)` with a `never`-typed `default` arm, same as §0.2's
  `handleAutoCommand` — a fifth category added later fails to compile instead of silently landing in
  someone else's branch. `sendDefaultCategoryPicker`'s own two-way ternary
  (`voice-mode-commands.ts:250-258`, which would post the *effort* picker for a `permission`/`answer`
  category) gets the identical treatment.
- **There is a third site switching on `DefaultCategory`, and missing it falsifies §0.2's
  "fails to compile" claim.** `callback-query-router.ts`'s `"default"` rule has its own
  `action.category === "mode" ? [mode prompt + keyboard] : [effort prompt + keyboard]` ternary in the
  `handle` half (~lines 611-616), reading the same `DefaultCategory` this plan widens at
  `session-commands.ts:161`. Widening a union does **not** break a ternary — it compiles cleanly and
  silently routes both new categories into the effort arm, which is precisely the failure mode §0.2
  claims the exhaustive-switch discipline eliminates. Convert it too, and treat the enumeration as
  closed only after checking it: the three sites are `handleDefaultCommand`,
  `sendDefaultCategoryPicker`, and this one. A type-level guarantee that names two of three places is
  not a guarantee, it is a seventh instance of the defect wearing the fix's language.
  (`resolveDefaultCategoryCallback` (`session-commands.ts:178-182`) deliberately stays narrow — it
  resolves the two-segment `default:mode`/`default:effort` category-drill-down taps only; the boolean
  categories have no drill-down screen and are produced by `resolveDefaultToggleCallback`'s
  three-segment strings instead. Say so where the type widens, or the next reader extends it "for
  consistency" and hands the widened value straight to the ternary above.)
- **`default:permission:on`/`default:permission:off` need their own resolver** —
  `callback-query-router.ts`'s `"default"` rule (~lines 598-611) tries exactly four things in its own
  `match` (`resolveDefaultCategoryCallback`, three cancel checks, `resolveDefaultModeCallback`,
  `resolveDefaultEffortCallback`); none match a `default:permission:on` string, so `match` returns
  `null`, the rule declines, and the tap falls through to the catch-all — **a live-looking button that
  does nothing.** Add `resolveDefaultToggleCallback(data): { category: "permission" | "answer"; value:
  boolean } | null` to `session-commands.ts` (re-validating the string, same defensive discipline as
  every sibling resolver) and a fifth `match` branch returning a new `{ kind: "toggle" }` action.
  `session-commands.ts:161`'s `DefaultCategory` type (`"mode" | "effort"`) widens to include
  `"permission" | "answer"`.
- **Persistence is a three-part write-through — the settings-store key alone is not enough.** Every
  existing fleet default lives as an `index.ts` module-level `let`, hydrated from SQLite at startup
  and reassigned on change; `handleNewCommand` reads the `let`, never the table directly. All three
  parts, mirroring `defaultSessionMode`/`defaultSessionEffort` exactly:
  1. **Hydrate**: `let defaultBypassEnabled: boolean` / `let defaultAutoAnswerEnabled: boolean` beside
     `index.ts:184-192`, from `settingsStore.get("default_bypass_enabled", "false") === "true"` (and
     the `autoanswer` equivalent). Default `"false"` — fail-closed, unlike `voice_confirm_enabled`'s
     `"true"` fallback, because that one defaults a confirmation *on*.
  2. **Write through**: `handleDefaultCommand` calls an injected `setDefaultBypassEnabled(value)`
     **and** `settingsStore.set("default_bypass_enabled", String(value))`, the exact pairing
     `applyDefaultMode` already does at `voice-mode-commands.ts:271-272`.
  3. **Read via a live getter, never a snapshot**: `getDefaultBypassEnabled: () => boolean` /
     `getDefaultAutoAnswerEnabled: () => boolean` on `SessionLifecycleCommandsOptions`, same doc
     comment as the existing siblings at lines 75-78 warning against snapshotting. A construction-time
     `boolean` compiles, persists, confirms — and then every session for the rest of that Bridge's
     lifetime still starts without it, looking correct after the next restart. This is the specific
     silent-wrong failure this bullet exists to prevent.
- **Application to new sessions**: `handleNewCommand`, at the exact point
  `defaultSessionMode`/`defaultSessionEffort` are applied (right after `waitForChannelConnected`,
  before the initial prompt). **Not** a PTY keystroke/typed-command write — purely
  `if (getDefaultBypassEnabled()) autoCategorySpec("permission").set(slug, true);` (and the `answer`
  equivalent; `spec.set` rather than `applyAutoToggle` precisely because there is nothing to drain), since
  this state lives in `routing.ts`, not Claude Code's own CLI state. Do not copy the
  `writeModeKeystrokes` machinery here; there is no keystroke to send.

Confirmation text: *"New sessions will now start with auto-permission ON — every permission prompt
they'd otherwise raise, including git commit/push, is auto-allowed from their very first turn.
`/default permission off` to revert (only affects sessions created after that point — see `/auto
permission --all off` to also flip already-running ones)."*

### §0.5 `nl-router.ts` wiring

One new kind, `"auto"`, replaces what would otherwise have been two (`bypass`/`autoanswer`) —
structurally identical to how `"default"` already carries a `category` field rather than being two
kinds itself:

- **`ROUTER_KINDS` (`nl-router.ts:110-147`) gains `"auto"`. `allowedKinds` (lines 159-177) must
  *not* be touched — and this is the opposite of what "both gain `auto`" would suggest.**
  `allowedKinds` is not a list to append to: it is `ROUTER_KINDS.filter(...)` with two **exclusion**
  predicates and a `return true` tail, so a new kind is offered everywhere by default and the only
  edit that fits the phrase "gains `auto`" there is *adding an exclusion*. The attractive wrong one is
  line 161's `(kind === "new" || kind === "budget" || kind === "default") && !ctx.isControl` — `auto`
  reads like `default`, and this plan draws that parallel on nearly every page. Making that edit
  filters `"auto"` out of the schema's `kind` enum for every session topic, so *"stop asking me for
  permission on this one"* — typed in the session's own topic, the single most likely way this feature
  is ever invoked by voice or plain English — becomes a command the model is structurally unable to
  emit; it picks some other kind or nothing, and the message falls through to the session as literal
  chat text. The other exclusion (line 162's `hasSession` group) is wrong in the mirror direction: it
  would make `/auto permission --all` unreachable from the control topic. `auto` takes an optional
  slug and works from either place, exactly like `kill`/`rm`/`verbose`, all three of which appear in
  neither predicate. Leave the function alone; state that deliberately in the commit, or the next
  reader "completes" the wiring and breaks it.
- The JSON schema gains one new field, `autoCategory: { type: "string", enum: ["permission",
  "answer"], description: "For 'auto': which auto-approve toggle to check or change." }` — reusing
  the *already-generic* `slug`/`all`/`on` fields the schema carries for `kill`/`rm`/`verbose`. This
  needs one new field where the pre-unification design needed two full kinds' worth of schema
  surface.
- **Both reused fields' `description`s must name `'auto'` too — the description is the only thing
  telling the model a field applies at all.** `on` (line 195) currently reads *"For 'verbose'."* and
  `all` (line 191) reads *"For 'kill'/'rm': act on every session."*; they become *"For
  'verbose'/'auto'."* and *"For 'kill'/'rm'/'auto': act on every session."*. Omitting the `all` one
  is the same structural gap v0.8.0 found in `defaultCategory`'s enum, one layer softer and just as
  silently wrong: *"turn off auto-approve on all my sessions"* routes to `{ kind: "auto", category:
  "permission", on: false }` with `all` left unset, because the schema told the model that field
  belongs to `kill`/`rm`. The command then resolves against the current topic's session (or bails
  with a resolution error from the control topic), the operator is told one session changed, and
  every other session keeps auto-allowing `git push` — a safety toggle silently applied at the wrong
  scope, reported as success.
- Parse branch, mirroring `case "verbose":` (`nl-router.ts:418-419`, `{ kind: "verbose", slug: raw.slug,
  on: raw.on }`) plus `case "kill":` (line 387-388) for the `all` field:
  ```ts
  case "auto":
    return raw.autoCategory === "permission" || raw.autoCategory === "answer"
      ? { kind: "auto", category: raw.autoCategory, slug: raw.slug, all: raw.all === true, on: raw.on }
      : null;
  ```
- `defaultCategory`'s own schema enum (`nl-router.ts:206-208`, currently `["mode", "effort"]`) and its
  description gain `"permission"`/`"answer"`, or the router structurally cannot express `/default
  permission on` no matter what the operator types.
- The `case "default":` parse branch (`nl-router.ts:441-444`) is the same bare-else shape §0.4 already
  flags for `handleDefaultCommand` — two `if`s for `mode`/`effort`, then an unconditional
  `return { kind: "default", category: "status" }`. Add the two new branches before that tail.
- `isDestructive` — see §0.3's single-line consolidation.

## §1 `auto permission`: auto-allow tool/command permission prompts

### §1.1 Mechanism

`pipe-server.ts`'s `handlePermissionRequest` (~line 426) already contains the exact shortcut this
generalizes: when `isCompoundCommandFullyAllowed` (`compound-permission.ts`) determines every
sub-command of a compound Bash call is already covered by the session's own `allow` list, the
function calls `sendVerdict(msg.slug, msg.request_id, "allow")` (line 446) and returns *before* ever
calling `renderPermissionCard`/posting to Telegram/registering a `PendingPermissionRequest`.

`auto permission` adds a second, operator-controlled short-circuit ahead of that existing one
(checked first, since it's a coarser gate):

```ts
async function handlePermissionRequest(msg: PermissionRequestMessage): Promise<void> {
  const route = opts.routing.get(msg.slug);
  if (!route) { /* unchanged */ }

  if (opts.routing.getBypass(msg.slug)) {
    log("INFO", `auto-permission: auto-allowed ${msg.tool_name} for slug "${msg.slug}": ${msg.input_preview}`);
    // Enqueued, deliberately NOT awaited - see "Ordering and the missing await" below.
    void postAutoApprovedNote(route.topicId, `🔓 auto-approved (auto permission): ${describeCall(msg.tool_name, msg.input_preview)}`);
    sendVerdict(msg.slug, msg.request_id, "allow");
    return;
  }

  // existing isCompoundCommandFullyAllowed shortcut, unchanged, follows here
  ...
}
```

Note `opts.routing.getBypass`/`setBypass` are the internal names — see the Overview's naming-split
note. The command the operator types is `/auto permission on`; the code underneath still says
`bypass`.

`describeCall` is a small new helper (co-located in `permission-callback.ts`, next to
`renderPermissionCard`) turning `(tool_name, input_preview)` into a one-line summary, e.g.
`Bash(git push origin main)`.

**It must emit plain text, not Telegram HTML — do not reuse `renderPermissionCard`/
`renderInputPreview`.** Those render for a `sendMessage(..., "HTML")` call
(`permission-callback.ts:85-87`: `<b>`-wrapped fields, `escapeHtml`'d body, monospace block), while
`postAutoApprovedNote` sends with **no `parse_mode`** — feeding HTML-producing helpers into a
plain-text send would print literal `<b>`/`<code>` tags in every notice. Plain text is also simpler on
its own merits: one line, no markup needed, immune to a command containing `<`/`&`.

Two deliberate consistency notes:
- **No `scrubSecrets` pass**, matching `renderPermissionCard`, which doesn't scrub either (only
  escapes) — a tool-call preview is the operator's own session's command text, shown verbatim today.
  If a future pass decides previews should scrub, change both paths together.
- **Truncation**: reuse whatever bound `renderInputPreview` already applies to a long `input_preview`
  rather than inventing a second number.

**Included fix while touching this function:** the existing compound-Bash shortcut at line 446 gets
the same `postAutoApprovedNote` call added — today it only logs server-side, with zero
Telegram-visible trace.

**`postAutoApprovedNote`** is a plain, standalone message into the session's own topic, **not** a
feed-card line — there is no Bridge-side primitive for injecting a line into a feed card
(`feed-wiring.ts`'s `FeedWiring` interface exposes no append entry point, and `pipe-server.ts` has no
`feedWiring` reference at all), and adding one would be the wrong dependency edge:

```ts
/** P1, not P0 and not P2. The permission card this replaces sends on P0 (`await p0(...)` in
 * `handlePermissionRequest`), reserved for traffic a human is actively blocked on; promoting the
 * notice to P0 would let a burst of auto-approvals compete with other sessions' real permission
 * cards in the one lane that must never be delayed. P2 is wrong the other way — droppable under
 * pressure, and an "what did the Bridge do on my behalf" audit trail must not silently vanish when
 * the feed is busy.
 *
 * Never throws: an auto-approval whose notice fails to post must still send its verdict — the
 * session is blocked waiting for one, and a swallowed exception here would strand it exactly the way
 * an unanswered card does. */
async function postAutoApprovedNote(topicId: number, text: string): Promise<void> {
  try {
    await p1(() => opts.controlBot.sendMessage(opts.chatId, topicId, text));
  } catch (err) {
    log("WARN", `failed to post auto-approval notice: ${(err as Error).message}`);
  }
}
```

**Ordering and the missing `await`.** The operator's timeline must read "🔓 auto-approved: X" before
X's effects land — but that ordering comes from **enqueue order**, not from awaiting the send, and
awaiting it defeats the entire feature. `p1` and `p0` draw on one shared control-bot bucket that
refills at roughly **one token every 3 seconds** (`rate-governor.ts:32`, `capacity` 20 per
`refillIntervalMs` — §5.4's Telegram per-chat limit). `await`ing the notice therefore blocks
`sendVerdict` on a rate-limiter token: turn `auto permission` on, then run the ordinary build-edit-test
loop this feature exists to unblock, and the first few calls spend the standing bucket while every
one after it stalls ~3s waiting for a refill — a 20-tool-call turn spends about a minute frozen, with
Claude blocked on a verdict the Bridge decided instantly and locally the moment the request arrived.
The feature sold as "no more waiting for a Telegram round-trip" would have replaced a human
round-trip with a rate-limiter one, and — because the bucket is shared — an auto-approving session
would drain tokens other sessions' genuinely-blocking P0 permission cards need (P0 wins the dequeue
order, but it cannot conjure a token that isn't there).

So: **enqueue the notice, then send the verdict immediately, without awaiting the send.** The
governor's per-lane queues are FIFO, so the notice still reaches Telegram ahead of anything this
tool call subsequently enqueues — which is precisely the ordering guarantee the timeline needs.
`postAutoApprovedNote` is already documented as never throwing (it catches internally and logs at
WARN), so dropping the `await` is safe by construction rather than by a caller-side `try`; the
"a failed notice must never strand a blocked session" contract that comment describes is now
structural instead of dependent on the caller getting its error handling right. The same applies to
§2.2's auto-answer notice, which uses this identical primitive.

One trade-off worth stating: with `auto permission` on, a tool-heavy turn produces a visibly chattier
topic (one notice per auto-approved call, P1 throttled but not droppable). The fix if that bites is
coalescing consecutive notices (`feed-coalescer.ts` already implements this for the feed), **not**
dropping them.

### §1.2 What `auto permission` does and does not touch

| Escalation source | Reaches `PermissionRequest`? | Affected by `auto permission`? |
|---|---|---|
| `permissions.deny` match (`rm -rf /*`, `git push --force *`, secret reads, `~` writes) | No — Claude Code refuses outright, no hook fires | **No — hard floor, unconditional** |
| `permissions.ask` match (`git commit *`, `git push *`, `gh pr merge/close/create/edit/comment/ready/reopen *`,¹ `npm publish *`, `dotnet nuget push *`) | Yes | **Yes — auto-allowed** (the deliberate, headline behavior change) |
| No rule matched at all, mode says prompt | Yes | Yes — auto-allowed |
| `auto`-mode classifier block that falls through to a real prompt | Yes | Yes — auto-allowed |
| `isCompoundCommandFullyAllowed` compound-Bash shortcut | Never reaches a card either way | N/A (already auto-allowed today, unconditionally) |

¹ Cross-checked against the current `settings.ts` source directly: this per-subcommand enumeration is
what the generated settings actually contain today (added 2026-08-10, per that file's own doc
comment — a blanket `Bash(gh pr *)` ask rule over-gated read-only subcommands like `gh pr checks`,
narrowed to only the mutating ones). The canonical plan still shows the older, broader form in
several places.

## §2 `auto answer`: auto-answer `AskUserQuestion`

### §2.1 Why this is a genuinely separate mechanism

`AskUserQuestion` does not go through `handlePermissionRequest`/`permissionRegistry` at all — a
distinct hook path end-to-end: the hook client's synchronous `--ask`-matched `PreToolUse` entry
blocks Claude Code until the Bridge answers; the Bridge side is `pipe-server.ts`'s `handleAsk`
(line 489) and `ask-registry.ts`'s `AskRegistry` (keyed by `tool_use_id`, supporting multiple
`questions` per call).

**Decision: this belongs Bridge-side, in `handleAsk`, mirroring `auto permission`'s shape — not
hook-client-side.** The hook client is a thin, compiled, per-event binary whose entire job is
relaying the event and blocking on *the Bridge's* decision — it has no visibility into
operator-configured toggles (`routing.ts`'s in-memory state lives in the Bridge process) and no
reason to gain any.

### §2.2 Mechanism and the "only when Claude marked a recommendation" rule

`AskQuestionOption` (`packages/protocol/src/types.ts:139-142`) is `{ label: string; description?:
string }` — no structured "recommended" field, confirmed against both Anthropic's published schema
and this repo's own type. The only signal is a convention — **observed/reverse-engineered, not
Anthropic-documented** — that exactly one option's `label` ends with the literal suffix `"
(Recommended)"` when Claude Code has a preference. `findAutoAnswer` must be written defensively
(fails safe to "no auto-answer, post the real card" on any shape it doesn't recognize) precisely
because this convention is undocumented and could change without notice.

In `handleAsk`, before posting any card:

```ts
function findAutoAnswer(questions: HookAskMessage["questions"]): string[] | null {
  if (questions.length === 0) return null; // load-bearing, see below - NOT a defensive nicety
  const answers: string[] = [];
  for (const q of questions) {
    const recommended = q.options.filter((o) => o.label.endsWith(" (Recommended)"));
    if (recommended.length !== 1) return null; // any question without exactly one -> no auto-answer at all
    answers.push(recommended[0].label);
  }
  return answers;
}
```

**The zero-length guard is the whole reason this function's contract is `string[] | null` rather than
"empty means no".** Without it the loop body never executes and the function returns `[]` — which is
**non-null**, so the caller's `findAutoAnswer(msg.questions) !== null` test passes, the auto-answer
path is taken for a call with nothing to answer, no card is posted, and `writeAnswer` sends an empty
`answers` map to a hook client that then unblocks having answered nothing. That directly contradicts
§4's *"`findAutoAnswer` given a call with zero questions: treat as 'no auto-answer'"* and fails §5's
*"a zero-question ask posts the card"* assertion — three sections of this plan disagreeing, with the
code sketch (the thing an implementer actually copies) on the losing side. `[]` being truthy in the
sense that matters here (`!== null`) is the trap; a `length === 0` check on the *result* would be a
second, equally easy thing to get wrong at each call site, which is why the guard belongs at the top
of this function instead.

If `routing.getAutoAnswer(msg.slug)` and `findAutoAnswer(msg.questions)` returns non-null: build the
same `answers` map `AskRegistry.buildAnswers` (`ask-registry.ts:105-111`, `Record<string, string>`
keyed by question text — not an array, even for `multiSelect`, since the protocol's `answer` message
(`types.ts`'s `HookAnswerMessage`) only ever carries one label per question) would have produced from
a fully-answered `PendingAsk`, and send it back exactly the way a real "all questions answered" tap
does today. `pipe-server.ts`'s `finishAsk(id, buildPayload)` (line 693) is the shared primitive
behind `completeAsk`/`cancelAsk`, but it starts with `askRegistry.get(id)` and returns `false` when
there's no entry — so the auto-answer path factors the socket-write half out of `finishAsk` for both
callers to share, rather than registering an entry purely to delete it a microtask later (which would
invite a real race with the expiry sweep and `removeForSlug`).

**The extracted helper must take the socket as a parameter — it must not look it up.** `finishAsk`
resolves its socket via `askSocketsById.get(id)` (line 697), and that map is only ever populated by
`handleAsk`'s own `askSocketsById.set(msg.request_id, socket)`, on the same line as the
`askRegistry.add` this path deliberately never reaches. Extracting the write half *including* that
lookup — the reading an implementer lands on by default, since it sits between the `get` and the
`write` in the function being split — yields `socket === undefined`, an early `return false`, and no
`answer` message ever written: the operator sees "🔓 auto-answered …" in the topic while the hook
client stays blocked on the question forever, with no registry entry left for any sweep to expire.
The correct signature is therefore
`writeAnswer(socket: net.Socket, slug: string, payload: Pick<HookAnswerMessage, "answers" | "cancel">): void`,
called by `finishAsk` with its looked-up socket and by the auto-answer path with **`handleAsk`'s own
`socket` parameter**, which is already in scope and is the very connection the blocked hook client is
waiting on.

**Placement inside `handleAsk` is exact, not "somewhere before the card":** after *both* existing
guards — the `askRegistry.get(msg.request_id)` reconnect-rebind branch (line 490, so a re-sent `ask`
for an entry still pending from before the toggle went on keeps rebinding its socket instead of being
answered out from under a card the operator is already looking at) and the `opts.routing.get(msg.slug)`
lookup (line 496, since `postAutoApprovedNote` needs `route.topicId` and an unknown slug must keep
falling through to today's WARN-and-drop) — and immediately before the `try` block that posts the
first card.

**The investigate-first veto (operator-requested 2026-08-11).** When a question carries a
recommendation *and* an option that defers or investigates ("Verify against a real session first",
"Hold off, review the plan changes first", "Not yet"), `findAutoAnswer` returns `null` and the real
card is posted. The operator's standing preference is to investigate before committing, and posting
the buttons is the only way they can actually exercise it.

The obvious feature — *pick* the investigate option instead of the recommended one — was measured and
rejected. 715 real `AskUserQuestion` calls from this machine's own Claude Code transcripts (44
sessions) were extracted and scored: 212 carry exactly one `(Recommended)` option, **0 carry more
than one** (independently confirming §2.2's exactly-one rule), and 207/212 put the recommendation
first, matching the tool description's own instruction. But option *semantics* are not in the schema —
`AskQuestionOption` is `{label, description?}`, and `(Recommended)` is the only convention Claude is
instructed to emit — so any investigate-detector is keyword-matching free prose against a convention
its producer was never told to follow. A generous one ran at roughly **13% precision**, and its
failures inverted operator intent rather than merely missing it: it would have answered *"Auto-send
immediately, no confirmation"* over *"Always show a confirm card first (Recommended)"*, having matched
`confirm` inside `no confirmation` — silently disabling a safety confirmation. Others picked *"Extract
only, tests later"* over *"add tests as each module is extracted (Recommended)"*: consistently
**less** rigor, the opposite of the request.

As a veto the same imprecision is harmless and the risk profile inverts — a false positive costs one
button tap, a false negative auto-answers as before — so the pattern is deliberately generous
(`first|before|investigat*|research*|clarif*|explain*|hold off|hold on|wait|not yet|verify|
double-check|look into`), firing on ~11% of otherwise-answerable questions in that corpus. Two
details are load-bearing: it inspects only the **non-recommended** options (a well-written *"do the
safe thing first (Recommended)"* would otherwise veto itself), and it matches **labels only**
(`description` is prose that routinely says "before"/"first" while describing an option that commits).
`confirm` is deliberately absent from the vocabulary — too common outside defer contexts to be a
signal, and it is exactly the token that produced the measured inversion.

A third option was considered and rejected: answering with free text (the tool always offers "Other",
and `HookAnswerMessage.answers` is `Record<string, string>`) to say *"investigate first"* with no
detection at all. Claude asked because it needs a decision, so answering "go investigate" invites it
to investigate and ask again — auto-answered identically, in a loop bounded only by the hook client's
59-minute timeout. A worse failure than an extra tap.

Post the auto-answer notice via the same `postAutoApprovedNote` primitive from §1.1 (`🔓 auto-answered
(auto answer): "<question>" → "<picked label, "(Recommended)" suffix stripped>"`, one line per
question), and **never call `askRegistry.add`/post a card at all**. If *any* question lacks exactly
one recommended option, fall through to today's behavior unchanged — post the real card for the
whole call, no partial auto-answering.

### §2.3 What's category-specific vs. shared with §1

Everything in §0 (parsing, session scope, `--all`, `/default`, `nl-router` wiring) is identical
between the two categories by construction. What's genuinely different, covered in §4:
- **`auto permission on` drains already-pending permission requests for that session; `auto answer
  on` deliberately does not.** See §4 for the full argument and the two-part fix (`sendVerdict`
  wiring, and checking its return value) that drain requires.
- The `postAutoApprovedNote` text differs (`(auto permission)` vs `(auto answer)`), and the mechanism
  each intercepts is a different hook path entirely (§2.1).

## §3 Module Ownership & Wiring

**Cross-reference:** [`plans/index-ts-module-split-plan.md`](index-ts-module-split-plan.md) proposes
further extracting `voice-mode-commands.ts`, `fleet-confirm-flow.ts`, and `callback-query-router.ts`
out of `index.ts`. Citations below were verified live against current source; if that module-split
plan lands first, re-verify locations before implementing.

No new `LateBound`-style forward-reference is introduced. `routing.ts` already sits below
`pipe-server.ts`/`session-lifecycle-commands.ts`/`fleet-confirm-flow.ts` in construction order —
adding `bypassBySlug`/`autoAnswerBySlug` to that same class is a same-file, same-construction-order
change. `fleet-confirm-flow.ts`'s `createFleetConfirmFlow` already takes `routing`
(`fleet-confirm-flow.ts:88`), but that is **not** enough for the new `permission-*`/`answer-*`
branches in `executeFleetConfirm`: they must call `applyAutoToggle` (§0.3), not `routing.setBypass`,
or the `--all on` path silently skips §4's drain. `applyAutoToggle` is therefore **one new injected
dependency** on that module's existing `sessionLifecycle` option, joining `killSessionRow`/
`removeSessionRow`. No `LateBound` is needed — `session-lifecycle-commands.ts` is already constructed
before `fleet-confirm-flow.ts` for exactly those two.

**`handleAutoCommand` (§0.2) lives in `session-lifecycle-commands.ts`, next to
`handleVerboseCommand`** — see §0.2 for why (the private `resolveSessionOrBail` closure). Add it to
`command-dispatch.ts`'s existing `sessionLifecycle` `Pick<...>` union (`command-dispatch.ts:49-61`)
as a single `fleetCmd.kind === "auto"` branch. **Dispatch it like `kill`/`rm`, not like `verbose`:**
it is `Promise<void>` (§0.2 — the `--all` branch posts a confirm card), so the branch reads
`fireAndForget(sessionLifecycle.handleAutoCommand(fleetCmd, threadId, currentSlug), log,
"command-dispatch handleAutoCommand")`, matching line 198's `handleKillCommand`, **not** line 234's
bare synchronous `handleVerboseCommand(...)` call. Physical placement next to the `verbose` branch is
fine; copying its call shape is not.

**This module gains three new injected dependencies:**
- `sendVerdict: (slug: string, requestId: string, behavior: VerdictBehavior) => boolean` —
  `SessionLifecycleCommandsOptions` already carries `permissionRegistry` (line 42) and
  `finalizePermissionMessage` (line 50), both needed by §4's drain, but **not** `sendVerdict`, because
  `handleStopCommand` (the only existing consumer of that pair) deliberately never sends one. §4
  explains at length why `auto permission on` is different and why omitting this wedges the session
  permanently. Wire the identical lambda shape `index.ts:517`/`754` already use for `feed-wiring.ts`
  and `sweepExpiredPermissions`: `(slug, requestId, behavior) =>
  pipeHandle.sendVerdict(slug, requestId, behavior)`. No `LateBound` needed — `finalizePermissionMessage`
  is already injected from `pipeHandle` at this same construction point.
- `getDefaultBypassEnabled`/`getDefaultAutoAnswerEnabled: () => boolean` — same shape and doc comment
  as the existing `getDefaultSessionMode`/`getDefaultSessionEffort` (lines 75-78).

`voice-mode-commands.ts` separately gains the two paired setters (`setDefaultBypassEnabled`/
`setDefaultAutoAnswerEnabled`) per §0.4's write-through requirement **and the two matching live
getters** (`getDefaultBypassEnabled`/`getDefaultAutoAnswerEnabled`), exactly as it already carries
both halves for mode/effort (`setDefaultSessionMode` line 46 / `getDefaultSessionMode` used at line
234) — the getters are not optional here: `sendDefaultStatusCard` needs both current values to render
the two toggle rows' labels and their inverse-valued `callback_data` (§0.4). It owns the two new
`/default` categories end-to-end — that module already owns `/default`, and these categories are fleet-wide with
no slug to resolve. Factory: `createVoiceModeCommands` (`voice-mode-commands.ts:74`).

## §4 Error Handling

Mirrors the existing `/kill --all`/`/rm --all` edge cases (`fleet-confirm-flow.ts`,
`confirm-cards.ts`) since `--all` reuses that exact mechanism:

- **Bridge restart between posting an `/auto <category> --all` confirm card and the tap:**
  `fleetConfirmRegistry` is in-memory only — a restart loses the pending confirm.
  `wasRecentlyAnswered` (`confirm-registry.ts`) plus `notifyConfirmGone` (`confirm-cards.ts`) apply
  unchanged: the tap edits the card to say the confirm is gone and to resend the command.
- **A session's toggle state surviving a crash-resume, and its interaction with
  [`plans/resume-nudge-on-lost-permission-plan.md`](resume-nudge-on-lost-permission-plan.md):**
  `bypassBySlug`/`autoAnswerBySlug` survive both a session-level `claude --resume` (always true — they
  were never tied to the PTY) and, as of v0.24.0, a full Bridge process restart too, via
  `session-store.ts`'s persisted columns and `session-supervisor.ts`'s `hydrateAutoToggles` call. Both
  are intentional — the toggle reflects standing operator intent neither a process crash nor a session
  resume should discard — but it means: if `auto permission` was already on for a session before a
  crash, the resume-nudge plan's own re-triggered `PermissionRequest` is auto-allowed the same as any
  other, and no card appears from that plan's point of view. Not a bug in either plan — the operator
  who turned it on already asked for exactly that outcome, resumed, restarted, or neither.
- **Turning `auto permission` on while that session already has a pending permission card — the case
  an operator will hit constantly.** The common way to discover you want this is to be looking at a
  card you don't want to tap. `auto permission on`, on the `on` transition, therefore drains that
  session's already-pending permission requests: for each entry `permissionRegistry.removeForSlug(slug)`
  returns, send an `"allow"` verdict and finalize the card via `finalizePermissionMessage` (`🔓
  auto-approved (auto permission was turned on)`).
  - **`handleStopCommand` (`session-lifecycle-commands.ts:636-663`) is the precedent for the
    *iteration* half only, not the verdict half — copying it wholesale is a permanent-wedge bug.**
    `handleStopCommand` deliberately sends no verdict at all (its own doc comment,
    `session-lifecycle-commands.ts:629-634`, explains why: `/stop` sends `ESCAPE` first, so Claude's
    own interrupt handling has already unblocked the waiting hook client). `auto permission on` sends
    no Escape and interrupts nothing — the hook client is still blocked on a verdict only
    `sendVerdict` can deliver. Popping the entry, editing the card to say "auto-approved", and never
    sending the verdict leaves **no recovery path**: `sweepExpiredPermissions`
    (`permission-registry.ts:214-225`) iterates `registry.expired()`, and `removeForSlug` has already
    removed the entry — the session hangs forever on a card that claims it was approved. This is why
    §3 specifies `sendVerdict` as a genuinely new injected dependency for this module.
  - **`sendVerdict`'s return value must be checked, and the card text must follow it.** `sendVerdict`
    (`pipe-server.ts:647-656`) looks the slug up in `connectionsBySlug` and returns `false` if there's
    no live channel server — exactly the situation a stale pending card is likely to be in (the
    crash-resume window named above). Ignoring the return value produces the worst combination: entry
    gone from `permissionRegistry`, card edited to claim approval, verdict delivered to nothing. On
    `false`, finalize with an honest terminal message instead — *"⚠️ auto-permission is on, but this
    request couldn't be auto-approved: the session's channel is disconnected. Re-send the tool call
    once it's back."* — and log at WARN.
  - **Ordering here is the reverse of §1.1's**: verdict first, then finalize. §1.1's note is a
    heads-up that must precede its effects; the drain's card edit is a terminal marker whose text
    depends on whether the verdict actually went anywhere, so it can't be written first without
    guessing.
  - **`auto answer on` deliberately does not get the equivalent behavior.** Draining a pending
    `AskUserQuestion` would mean answering a real question on the operator's behalf with an option
    they never saw — unlike a permission prompt, there's no verdict here that's obviously the one
    they'd have chosen. A pending ask stays posted; only asks arriving *after* the toggle are
    auto-answered.
  - The `--all` and `/default` scopes differ, and the difference is structural: `/auto permission
    --all on` drains every affected session **only because `executeFleetConfirm` routes through
    `applyAutoToggle` (§0.3) rather than calling `routing.setBypass` itself** — that indirection is
    the whole reason it exists, not a style choice. `/default permission on` gets no drain and needs
    none: it only affects sessions created later, which by definition have nothing pending, which is
    also why §0.4's new-session application is allowed to call `routing.setBypass` directly.
- **A session named in `/auto permission <slug> on` doesn't exist / isn't live:** same "unknown slug"
  rejection every other slug-taking command gives.
- **`/auto permission --all on` with zero live sessions:** `postFleetConfirm` already short-circuits
  without posting an empty confirm card — keep the behavior, use the per-kind message (§0.3).
- **A session dies between the `--all` confirm tap and `executeFleetConfirm` running:**
  `executeFleetConfirm`'s existing re-lookup-by-slug pattern applies the same way — a slug with no
  live `routing` entry by the time the loop reaches it is skipped, not an error.
- **`/auto permission on` sent to a session that's already on:** a no-op — `setBypass` is idempotent,
  confirmation text is sent again rather than suppressed (matches `/voiceconfirm on` sent twice
  today).
- **`findAutoAnswer` given a call with zero questions:** treat as "no auto-answer" — the function must
  not divide-by-zero-style misbehave on a shape that shouldn't occur in practice.

## §5 Testing

Test gate, same as every sibling plan: `bun test` (full suite, `packages/bridge`) and `bun run
typecheck` (`tsc --noEmit`) must both pass — locally before merge, and automatically via
`.github/workflows/ci.yml` (both steps, `windows-latest`, on every push to `main` and every PR).
*(Corrected 2026-08-12: this said "No CI yet (`codebase-hardening-plan.md`'s P1-6) — manual gate
before merge", which stopped being true when `a511834` added the workflow and the `typecheck`
script.)*

- **`routing.test.ts`**: `getBypass`/`setBypass`/`getAutoAnswer`/`setAutoAnswer` — default-false,
  round-trip, independent per slug, reset by a fresh `Routing`. Extend the existing `remove()` case
  (line 59) to also assert `getBypass`/`getAutoAnswer` reset after `remove`.
- **`fleet-commands.test.ts`**: `parseAuto` — bare category → status form; `on`/`off` with/without a
  slug; `--all on|off`; `--all` with no value → `{ all: true, on: undefined }` (**not** a confirm
  card); `--all extra on` → `null`; an unrecognized category (`/auto ship on`) → `null`. `parseDefault`
  gains `permission`/`answer` cases mirroring `mode`/`effort`'s existing ones. **Plus the registration
  pair (§0.1), which no `parseAuto`-only test can catch:** `parseFleetCommand("/auto permission on")`
  returns a `{ kind: "auto" }` command (not `null`), `matchFleetCommandName("/auto")` returns
  `"auto"`, and — in the same case, guarding the `FLEET_COMMAND_NAME_RE` alternation —
  `parseFleetCommand("/autostart status")` still returns `{ kind: "autostart", action: "status" }`.
- **`pipe-server.test.ts`**: `handlePermissionRequest` — bypass-on auto-allows with **no permission
  card** posted (`sendVerdict("allow")`, `permissionRegistry.add` never called), still posts the plain
  notice; **`sendVerdict` is called without waiting on the notice's `sendMessage` to settle** — hand
  `handlePermissionRequest` a `sendMessage` fake returning a promise that never resolves and assert
  the verdict was still delivered, which is the regression test for §1.1's rate-limiter stall (a fake
  that resolves immediately passes whether the `await` is there or not); a *rejecting* notice
  `sendMessage` likewise still results in `sendVerdict` being called and no unhandled rejection; the
  compound-Bash shortcut's own new notice. `handleAsk` —
  autoanswer-on with every question carrying exactly one recommendation auto-answers with no card and
  no `askRegistry.add`; one question missing a recommendation posts the full card; autoanswer-off
  posts regardless; a zero-question ask posts the card. **Assert the auto-answer actually reaches the
  wire** — that the fake socket handed to `handleAsk` received an `answer` message with the expected
  `answers` map, not merely that no card was posted. A no-card assertion alone passes in the exact
  failure §2.2 describes (helper looks the socket up by id, finds nothing, writes nothing, hook client
  wedged). Plus the two placement guards: an `ask` whose `request_id` is already registered rebinds
  its socket and is *not* auto-answered even with the toggle on; an `ask` for an unknown slug is still
  WARN-and-dropped rather than auto-answered.
- **`fleet-confirm.test.ts`**: the four new `FleetConfirmKind` values (`permission-on`/`permission-off`/
  `answer-on`/`answer-off`) round-trip through the callback regex.
- **`session-lifecycle-commands.test.ts`**: `handleNewCommand` applies `routing.setBypass`/
  `setAutoAnswer` when the default is enabled, calls no PTY-write function, and reads the default
  through the injected getter **on every call** (flip the fake getter's return value between two
  `handleNewCommand` calls and assert the second session gets the new value — a test creating only one
  session can't distinguish a live getter from a snapshot). `handleAutoCommand`: unknown slug bails via
  `resolveSessionOrBail`; bare `/auto permission` reports status without toggling; explicit on/off sets
  and confirms; `auto permission on` with a pending permission request drains it (`sendVerdict("allow")`
  + `finalizePermissionMessage` per entry, registry empty afterwards); a drain whose `sendVerdict`
  returns `false` finalizes with the honest "couldn't be auto-approved" text, not "auto-approved"
  (assert the actual string); `auto answer on` with a pending ask leaves it posted and unanswered
  (the deliberate asymmetry).
- **`voice-mode-commands.test.ts`**: `handleDefaultCommand` with a `permission`/`answer` category must
  not call `applyDefaultEffort` and must not write `default_session_effort` (assert on the settings
  key specifically); the two new categories' confirmation text; `buildDefaultCategoryKeyboard`
  includes the two new toggle rows with correct current-value labels and inverse-of-current
  `callback_data` — **assert both directions** (build it once with the default off, once with it on,
  and check the emitted `callback_data` flips), since a hardcoded `default:permission:on` passes any
  single-direction test; a bare `/default permission` reports status, not the effort picker.
- **`callback-query-router.test.ts`**: the `"default"` rule's `handle` half sends the *permission*
  response for a `permission` category, not the effort picker (§0.4's third ternary — the one that
  keeps compiling after the union widens).
- **`session-commands.test.ts`**: `resolveDefaultToggleCallback` round-trips
  `default:permission:on|off`/`default:answer:on|off`, returns `null` for malformed/unknown input.
  **Paired assertion in `callback-query-router.test.ts`**: a `default:permission:on` tap is actually
  claimed by the `"default"` rule (a resolver-only test can't catch a dead button).
- **`fleet-confirm-flow.test.ts`**: `postFleetConfirm` with zero targets for a `permission`/`answer`
  kind posts "No live sessions to change." (not the kill/rm text); `executeFleetConfirm` for the four
  new kinds calls **`applyAutoToggle` (not `routing.setBypass` directly)**, never `killSessionRow`/
  `removeSessionRow`; the self-check slug is excluded. Assert on the injected `applyAutoToggle` fake
  specifically — a test that only checks the resulting `getBypass(slug)` value passes either way and
  cannot tell the drain-preserving path from the drain-skipping one (§0.3). **Assert
  `removeSessionRow` was never called, by name, with an explicit call-count of zero** — that is the
  regression test for §0.3's misplaced-branch case, where a card saying "turn auto-permission on"
  removes the whole fleet, and it is the one assertion a passing `applyAutoToggle` check does *not*
  imply. Also: the finalized summary says "Auto-permission ON for N sessions", not "Removed N
  sessions" (line 170's second bare `else`, which survives a correctly-placed branch); and a
  `pending.slugs` entry whose row is gone by tap time is skipped, with `applyAutoToggle` never called
  for that slug (§0.3's stale-slug hazard — assert on the slug *argument*, since a call-count check
  alone passes when the wrong set of slugs is toggled).
- **`nl-router.ts`'s completeness check** (also touched by
  [`plans/control-topic-nl-dialogue-plan.md`](control-topic-nl-dialogue-plan.md)): `"auto"` added to
  `ROUTER_KINDS`; **`allowedKinds` offers `"auto"` in *both* contexts** — assert it appears for
  `{ isControl: true }` and for `{ isControl: false, hasSession: true }`, the regression test for
  §0.5's "don't group it with `default`" warning (a control-topic-only test passes either way);
  `isDestructive` — `--all` forms excluded, `on` forms included
  (§0.3's single-line consolidation — one test can cover both categories at once, since the gate no
  longer branches on category); the `autoCategory`/`defaultCategory` schema enums include the new
  values; the `case "default":` fallthrough is covered for `permission`/`answer`.

## §6 Documentation

- `about.ts`: add an `/auto` bullet alongside the existing `/mode` entry (line 65 — there is no
  `/voiceconfirm` bullet in this file to sit alongside, correcting an earlier revision's citation),
  covering both categories and all three scopes briefly. Update the `/default` bullet
  (`fleet-commands.ts:770`) to mention the two new categories.
- `fleet-commands.ts`'s `botCommandList()` (line 815): add one `auto` entry (Telegram's own
  command-autocomplete list), matching the existing `{ command: "kill", description: "..." }` shape.

## §7 Related known issues — explicitly out of scope for this plan

1. **`/default mode auto` / `/mode auto` does not actually reach Claude Code's real `auto` permission
   mode.** Live-reproduced 2026-08-10: every freshly-spawned session's status bar goes `⏸ manual mode
   on` → `⏵⏵ accept edits on` and stops — only 1 of 3 Shift+Tab presses lands, even though
   `default_session_mode` persists correctly as `"auto"`. A real, separate defect in
   `session-commands.ts`/`voice-mode-commands.ts`. **Not fixed here** — `auto permission` supersedes
   it for the operator's actual goal.
2. **`renderDefaultModeConfirmation`'s existing overclaim** (`"no permission prompts at all... including
   git commit/push"` — now known false). **Not corrected here** — describes Claude Code's own `auto`
   mode, which this plan doesn't touch.
3. **Anthropic's Aug 14, 2026 auto-mode-becomes-default rollout.** Background context, not something
   this plan reacts to — both categories operate at the Bridge relay layer regardless.
4. **Changing Claude Code's own local `--permission-mode` machinery in any way.** Out of scope by
   construction — both categories intercept *after* Claude Code has already decided to escalate.
