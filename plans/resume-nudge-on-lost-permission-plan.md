---
version: 1.0.0
status: solid
last_modified_utc: 2026-08-10T11:19:00Z
changelog:
  - "1.0.0 (2026-08-10): Live-verified end-to-end: real pending permission -> real /restart -> zero operator input -> automatic follow-up nudge -> retried commit -> fresh permission card -> approved -> confirmed at the git level. This is the first of four live trials where the operator never had to type anything, closing the original gap this plan set out to fix. Marking solid - implementation, tests (1431/1431 + typecheck), and live behavior all confirmed"
  - "0.6.0 (2026-08-10): Implemented §7's follow-up nudge: resumeSession now schedules a single automatic second nudge (RESUME_NUDGE_FOLLOWUP_DELAY_MS = 20s) if the session is still idle after the first, reusing the same injected delay primitive handleUnexpectedExit's backoff already uses. Only fires for idle - skips awaiting_input (worked), working (still in flight), and dead/gone (kill or rm raced the wait). Added 4 new unit tests covering all four outcomes. bun test (1431/1431) and typecheck clean. Not yet live-verified with this specific change - next step"
  - "0.5.0 (2026-08-10): Live-tested the CLAUDE_CODE_RESUME_INTERRUPTED_TURN hypothesis (§6) and ruled it out - explicitly threading the flag past ptyEnv()'s CLAUDE_CODE_* strip and disabling it produced the identical idle-no-retry outcome as both prior trials (third fresh disposable session, same $0.09 token spend). Reverted the experimental env change (no benefit). This leaves 'send a second automatic nudge if still idle' as the only one of §6's three options with direct live evidence behind it - recorded as the recommended next implementation step, not yet built"
  - "0.4.0 (2026-08-10): CRITICAL live finding, reproduced twice: the single automatic nudge does NOT reliably cause a retry, regardless of wording - trial 2 (reworded to explicitly say 'check what you were in the middle of') produced the exact same idle-no-retry outcome as trial 1's plainer wording. Both trials only got a retry once the operator sent a second, ordinary follow-up message. Added §6 (Open Question) documenting three follow-up options (delay the nudge, send a second automatic nudge if still idle, investigate CLAUDE_CODE_RESUME_INTERRUPTED_TURN directly) without picking one, since none has live evidence yet. The implementation itself (LateBound wiring, sendChannelText delivery, PreToolUse/PermissionRequest hook re-firing once a real turn lands) is confirmed working correctly - what's unconfirmed is that a single first-turn-after-resume nudge is sufficient, which was this plan's central premise"
  - "0.3.0 (2026-08-10): Live-verified the implementation against a real Telegram session/Bridge restart. Implemented resumeSession's nudge branch (session-supervisor.ts) with the planned LateBound wiring (index.ts), retired reconciliation.ts's dead lost_prompt action, added the planned unit tests - all pass (bun test + typecheck clean). First live trial with the v0.2.0 wording ('...it never ran. Please retry it.') did NOT work: the resumed session went idle for several minutes with no retry, and only retried after the operator manually asked it to check what happened. Fixed by folding that check-first instruction into the nudge wording itself ('Check what you were in the middle of ... and retry it.') and re-verifying live"
  - "0.2.0 (2026-08-10): Reviewed by 3 parallel agents (codebase/cross-plan/web). Fixed HIGH: the sendResumeNudge wiring is now a LateBound (session-supervisor.ts is constructed before pty-io.ts in index.ts, so a plain closure over ptyIo would capture an unassigned const), matching the existing LateBound precedent instead of the unrelated hoisted-function-declaration precedent it was compared to. Added a cross-reference noting this plan builds on codebase-hardening-plan.md's already-shipped P0-1/P0-3 fixes. Cited session-lifecycle-commands.ts's existing synthetic-from precedent instead of overclaiming. Cited the Messages API tool_use/tool_result constraint as the web-verified root cause, and flagged the undocumented CLAUDE_CODE_RESUME_INTERRUPTED_TURN env var as a cheap follow-up check. Fixed test file paths to packages/bridge/test/. Reframed the reconciliation.test.ts deletion as relocating design-doc §9 scenario 24's coverage rather than just removing dead coverage. Clarified the Verification section is not part of the bun test/typecheck gate"
  - "0.1.0 (2026-08-10): Initial plan created"
v020_touched_sections:
  - section: "§1 The Reusable Mechanism (DRY)"
    type: modified
    summary: "Replaced the plain-closure wiring with LateBound<PtyIo['sendChannelText']>, addressing the createSessionSupervisor-before-createPtyIo construction-order gap; cited session-lifecycle-commands.ts:485 precedent"
  - section: "§3 Retire the Dead lost_prompt Reconciliation Action (DRY cleanup)"
    type: modified
    summary: "Reframed as relocating §9 scenario 24 coverage, not just deleting dead coverage"
  - section: "§4 Nudge Message Wording"
    type: modified
    summary: "Added the Messages API tool_use/tool_result root-cause citation and the CLAUDE_CODE_RESUME_INTERRUPTED_TURN follow-up note"
  - section: "Overview"
    type: modified
    summary: "Added cross-reference to codebase-hardening-plan.md's already-shipped P0-1/P0-3 fixes"
  - section: "Testing"
    type: modified
    summary: "Fixed test file paths to packages/bridge/test/; cited design doc §9 gate policy and scenario 24 explicitly"
  - section: "Verification"
    type: modified
    summary: "Clarified this section is not part of the bun test/typecheck gate"
---

# Resume Nudge on Lost Permission Prompt

## Overview

**Audience:** aibridge maintainer (solo operator/developer of this Bridge).

**Confirmed live, this session (real Telegram + a real Bridge restart, not simulated):** when the
Bridge restarts while a session has a pending permission prompt open (`awaiting_input` state),
`resumeSession()` in
[`packages/bridge/src/session-supervisor.ts:377-380`](../packages/bridge/src/session-supervisor.ts)
posts *"The pending question was lost - please re-ask."*, flips the row to `working`, and relaunches
via `claude --resume <session_id>`. The resumed Claude process then sits **idle** — it does not retry
the interrupted tool call on its own. Verified by driving a disposable session
(`restart-permission-probe`) to a real pending `git commit --allow-empty` ask, restarting the Bridge
for real via `/restart`, and confirming at the git level afterward that no commit was ever created.

This plan closes that gap: instead of only telling the operator to retype their request by hand,
`resumeSession()` sends a **synthetic nudge** into the freshly-resumed session, prompting Claude to
re-attempt whatever it was about to do — which re-triggers the same `PreToolUse` hook and produces a
fresh permission button in Telegram, automatically.

**Scope boundary (KISS):** this is a nudge, not a replay. The Bridge does not capture, store, or
reconstruct the specific interrupted tool call — it relies entirely on Claude's own transcript memory
of what it was doing when the PTY died. `claude --resume` already restores that transcript (§4.5 of
[`plans/telegram-claude-session-control-plan.md`](telegram-claude-session-control-plan.md)); this plan
only adds one more inbound turn asking Claude to act on it.

## Current Behavior (verified)

- `resumeSession(row)` (`session-supervisor.ts:366-440`) is the single shared relaunch path for both
  a Bridge restart (`runStartupReconciliation`, line 189) and a live mid-run crash
  (`handleUnexpectedExit`, line 302).
- Its `awaiting_input` branch (lines 377-380) does exactly two things: `sessionStore.setState(slug,
  "working", now())` and `confirmSessionCommand(topicId, "The pending question was lost - please
  re-ask.")`. Nothing else. It is a **blanket per-row state check** — it fires for any row whose DB
  `state` column happens to be `awaiting_input`, regardless of whether the underlying tool call is
  still meaningfully "pending" in Claude's transcript.
- `reconciliation.ts`'s `reconcile()` independently emits a `lost_prompt` action
  (`packages/bridge/src/reconciliation.ts:21-40`) for the same condition — a second, parallel
  encoding of the identical "row is `awaiting_input`" check. **This action is never consumed.**
  `runStartupReconciliation` only switches on `action.kind === "readopt"` for its own logging; grepping
  `session-supervisor.ts` for `lost_prompt` returns nothing. It is confirmed dead code, covered only by
  a test that asserts the action is *emitted* (`reconciliation.test.ts:43-49`), never that anything
  *acts on it*.
- There is no unit test anywhere for the "please re-ask" message path itself
  (`session-supervisor.test.ts` has zero matches for `awaiting_input`/`lost_prompt`/`re-ask`) — its
  only confirmation before this plan was the live-verified manual scenario in
  `telegram-claude-session-control-plan.md` (lines 3963-3970), which checked the Bridge's own
  UI/state convergence (notice posted, row back to `working`, stale button becomes a no-op) but never
  checked whether Claude itself resumes the interrupted work.

**Builds on already-shipped hardening, doesn't duplicate it.** `resumeSession`'s re-read-from-store
(the `if (!current) ... if (current.state === "dead") ...` guards this plan's §2 leaves untouched) is
`plans/codebase-hardening-plan.md`'s **P0-1** fix, and the delete-then-kill ordering in
`killAndUntrack` is its **P0-3** fix — both already landed in the code as of this writing, even though
that plan's own header still says "nothing here has been applied yet" (a staleness in that document,
not something this plan needs to fix, but worth naming so a reader doesn't think this plan is
reinventing that safety net). This plan's nudge sits entirely inside the already-hardened success
path and does not touch either guard.

**Two independent DRY violations already exist here** (documented in the design doc as an unused
`ReconciliationAction` variant): the same "is this row's pending prompt lost" fact is computed twice
(`reconciliation.ts` and `session-supervisor.ts`), and only one of the two computations is ever acted
on. §3 below removes the dead one rather than adding a third.

## §1 The Reusable Mechanism (DRY)

`packages/bridge/src/pty-io.ts`'s `createPtyIo()` already owns every primitive needed to push a
synthetic inbound turn into a session safely:

- `sendChannelText(slug, topicId, content, msgId, from)` (lines 154-167) wraps `content` in the same
  `<channel source="aibridge" ...>` tag Claude Code would render for a real Telegram message
  (`renderChannelTag`, `packages/protocol/src/meta.ts:43`), writes it plus a separate `\r` (a single
  combined write is confirmed live to leave text sitting unsubmitted — bracketed-paste swallows the
  embedded Enter), starts the typing indicator and thinking placeholder, and calls `confirmSubmitted`
  — the lost-Enter detector that retries the `\r` once and self-heals a wedged PTY
  (`autoRecoverWedgedSession`) if the session still produces no output.
- The write itself goes through `routing.getPtyWrite(slug)`, which `wireSession()`
  (`session-supervisor.ts:268-274`) already wraps in `gateWriteUntilReady` — writes queue safely until
  the channel is confirmed connected, so there is no extra "is the PTY ready yet" logic to write here.

**Decision: reuse `sendChannelText` verbatim, do not write a second raw-`ptyProcess.write` path.**
This is the same mechanism every real operator message already goes through, so the nudge gets lost-
Enter retry, wedged-session self-heal, and the typing/thinking indicators for free, and behaves
identically to a real inbound message from Claude's point of view — no new failure mode to reason
about.

**Wiring (Dependency Inversion, matching the existing style) — and the construction-order problem
this needs to actually confront.** `session-supervisor.ts` does not currently import `pty-io.ts`, and
there's no circular-import risk (`pty-io.ts` only imports `@aibridge/protocol`, `wedged-recovery.ts`,
`routing.ts`, `thinking-placeholder.ts`, `typing-indicator.ts` — never `session-supervisor.ts`). But
the composition root builds these in a fixed, and inconvenient, order:
`createSessionSupervisor(...)` runs at `index.ts:445`, and `createPtyIo(...)` runs *after* it at
`index.ts:474` — specifically *because* `createPtyIo` needs `sessionSupervisor.lastActivityAt` and a
`ptyLookup` built from `sessionSupervisor.getPtyProcess` (index.ts:478-479). So at the moment
`createSessionSupervisor`'s options object is being built, `ptyIo` does not exist yet — a naive
`sendResumeNudge: (slug, topicId, content) => ptyIo.sendChannelText(...)` closure would be capturing a
`const` that hasn't been assigned. This is the same *shape* of forward-reference index.ts already
has a named, tested answer for: `LateBound<T>` (`late-bound.ts`), used today for `commandDispatch`/
`fleetConfirmFlow`'s two-way module dependency. `confirmSessionCommand`'s existing injection (line
443's doc comment) is *not* the same case, despite looking similar at a glance — it's a hoisted
function *declaration*, safe by JS hoisting semantics alone, not a `const` assigned later at runtime.
Reusing that precedent here without the distinction would be quietly wrong.

**Decision: use `LateBound<PtyIo['sendChannelText']>`, not a bare closure over `ptyIo`.** Add one new
field to `SessionSupervisorOptions`:

```ts
/** Sends a nudge into a resumed session whose pending permission prompt was lost - see
 * resume-nudge-on-lost-permission-plan.md. Same shape as PtyIo['sendChannelText'] deliberately -
 * Interface Segregation: resumeSession needs exactly this one function, not the whole PtyIo surface.
 * LateBound, not a plain closure: pty-io.ts (and therefore the real sendChannelText) isn't
 * constructed until after createSessionSupervisor returns (index.ts:474 runs after index.ts:445) -
 * see late-bound.ts's own doc comment for why an unchecked forward-reference closure was rejected. */
sendResumeNudge: LateBound<(slug: string, topicId: number, content: string) => void>;
```

The composition root passes `new LateBound()` into `createSessionSupervisor`'s options, then — right
after `createPtyIo(...)` returns (`index.ts:474-483`) — calls
`sendResumeNudge.set((slug, topicId, content) => ptyIo.sendChannelText(slug, topicId, content,
"resume-nudge", "aibridge"))`. `resumeSession` calls `.get()` on it only inside the nudge branch
(§2), which never runs until a real resume happens — well after this `set()` call, so `LateBound`'s
"read too early" guard can never actually fire in practice; it exists to turn a hypothetical future
refactor mistake into a named, immediate error instead of a silent `undefined` crash deep in
`pty-io.ts`, exactly as `late-bound.ts`'s own doc comment describes for its existing two consumers.
The fixed `msgId`/`from` pair (`"resume-nudge"`/`"aibridge"`) identifies this as Bridge-generated, not
a real Telegram message — the same convention `session-lifecycle-commands.ts:485` already uses for
`/new`'s own synthetic first-turn injection (`sendChannelText(slug, topicId, newSessionContent(cmd),
"new-1", "telegram")` — a fixed `msgId`/non-display-name `from`, not a new pattern this plan invents).
This mirrors how `confirmSessionCommand` is already injected into `SessionSupervisorOptions` today
(line 41) in spirit — session-supervisor depends on a narrow function type, not a concrete module —
so its own tests keep injecting a fake `LateBound` (`const nudge = new LateBound(); nudge.set(fakeFn);
... sendResumeNudge: nudge`) exactly as they do for `confirmSessionCommand` and `launchSession` now
(Interface Segregation + testability, no new mocking pattern introduced).

## §2 Where the Nudge Fires

Inside `resumeSession()`, **after** the resume is confirmed successful — not in the `awaiting_input`
branch itself (line 377-380), which runs before the PTY even exists yet. The nudge must fire from the
success branch (currently `confirmSessionCommand(topicId, \`Session "${slug}" resumed.\`)` at line
434), guarded by whether this particular resume started from `awaiting_input`:

```ts
async function resumeSession(row: SessionRow): Promise<void> {
  const { slug, topicId } = row;
  const current = sessionStore.get(slug);
  if (!current) { /* unchanged */ }
  if (current.state === "dead") { /* unchanged */ }
  const hadLostPrompt = current.state === "awaiting_input";
  if (hadLostPrompt) {
    sessionStore.setState(slug, "working", now());
    confirmSessionCommand(topicId, "The pending question was lost - please re-ask.");
  }
  if (!current.sessionId) { /* unchanged */ }
  // awaiting_input -> working is an already-allowed transition (ALLOWED_TRANSITIONS,
  // session-store.ts:125) - line 159's setState call is untouched by this plan.
  try {
    // ...launchSession, wireSession, routing.add, await session.ready... (all unchanged)
    if (resumeFailed) {
      // ...unchanged - no nudge makes sense into a conversation Claude never actually resumed
    } else {
      confirmSessionCommand(topicId, `Session "${slug}" resumed.`);
      if (hadLostPrompt) {
        sendResumeNudge(
          slug,
          topicId,
          "A Bridge restart interrupted you before your last action could complete or be approved - " +
            "it never ran. Please retry it.",
        );
      }
    }
  } catch (err) { /* unchanged - a caught launch failure means there's no PTY to nudge */ }
}
```

**Why gate on `hadLostPrompt` specifically, not "always nudge on resume":** a normal resume (row was
`working`, mid-turn, no pending question) already has Claude mid-reply when the crash/restart hit —
`claude --resume` picks that transcript back up and Claude's own turn continues or re-evaluates
naturally; there is no "lost prompt" to recover in that case, and nudging it too would risk injecting
an unsolicited turn into work that was already proceeding correctly. Scoping the nudge to exactly the
case that is provably broken today (confirmed live: idle, no retry, nothing happens) keeps this change
minimal and its blast radius easy to reason about (KISS, YAGNI — don't build a general "resume
announcement" feature when only one specific state transition is broken).

**Shared by both callers, no new duplication:** `handleUnexpectedExit` (the live-crash path) already
calls this same `resumeSession`, so it gets the identical nudge behavior for free — a live crash mid-
permission-prompt is exactly as broken today as a Bridge restart, for the same reason, and the fix
belongs in the one shared function both paths already use.

## §3 Retire the Dead `lost_prompt` Reconciliation Action (DRY cleanup)

`reconciliation.ts`'s `lost_prompt` action is redundant with `resumeSession`'s own `hadLostPrompt`
check and has never been consumed. Two ways to resolve the duplication; this plan takes the simpler
one:

- **Chosen: delete `lost_prompt` from `reconcile()` and the `ReconciliationAction` union.**
  `resumeSession` re-reads the row fresh from the store anyway (its own doc comment explains why —
  a `/rm`/`/kill` race during the resume-backoff wait), so it is already the single source of truth
  for this check at the moment it matters. `reconcile()`'s copy exists a full async gap earlier and is
  provably never acted on. Removing it **relocates** coverage rather than just deleting it: the
  design doc's §9 scenario 24 ("Reconciliation matrix — each of the five §4.5 rows — Unit") is
  currently satisfied for the `awaiting_input` row only by `reconciliation.test.ts:43-49`'s inert
  "the action is emitted" assertion — real coverage of the actual behavior (state flip + notice +
  nudge) has never existed. This plan's Testing items 1-4 below give that row real coverage in
  `session-supervisor.test.ts` for the first time; deleting the old assertion here is retargeting
  scenario 24's intent, not weakening it.
- **Rejected: wire `lost_prompt` into `runStartupReconciliation` and have `resumeSession` trust it
  instead of re-deriving `hadLostPrompt` itself.** This would still leave two copies of the same
  computation (reconcile's action list, passed alongside `row` to `resumeSession`) and doesn't remove
  the re-read-from-store requirement `resumeSession` has for the unrelated `/rm`/`/kill` race — it
  just relocates the duplication instead of removing it. Not taken (KISS: fewer moving parts, not a
  reshuffled version of the same count).

## §4 Nudge Message Wording

The message needs to tell Claude three things without assuming any detail about what it was doing:
(1) something it attempted did not actually happen, (2) why — not an error, an interruption — so it
doesn't report a spurious failure back to the operator, (3) an explicit instruction to retry, since an
idle Claude with a merely-informative message has no obligation to act on it.

> "A Bridge restart interrupted you before your last action could complete or be approved - it never
> ran. Check what you were in the middle of (e.g. git status/log, or whatever else is relevant) and
> retry it."

**Confirmed live 2026-08-10, reproduced twice: wording alone does not fix this - the first
post-resume turn itself appears to be the problem, not the phrasing.** Two independent trials against
real pending `git commit` asks, each on a fresh disposable session:

- **Trial 1** (wording: "...it never ran. Please retry it."): the nudge was delivered and submitted
  correctly (`Thinking...` placeholder fired, confirming §1's write/submit mechanism works), settled
  at **idle** with no retry and no reply for several minutes ($0.10 spent - some processing happened,
  just not a visible tool call or `reply()` call). Only an operator follow-up message ("what happened
  right after you were resumed?") got Claude to check `git log`/`git status` and retry.
- **Trial 2**, after rewording to "...Check what you were in the middle of (e.g. git status/log...)
  and retry it.": **identical outcome** - `Thinking...`/brief token spend, then idle, no retry, no
  reply ($0.09). The stronger instruction made no observable difference. Again, only an operator
  follow-up reproduced the check-and-retry.

**Working hypothesis (not yet confirmed against Claude Code's own internals):** the nudge is written
as the very first inbound turn after `claude --resume`. The web-research pass's
`CLAUDE_CODE_RESUME_INTERRUPTED_TURN` lead (§4 above) is consistent with this turn being partially
consumed by Claude Code's own internal interrupted-turn handling before it reaches normal per-turn
processing - the operator's *second* message (a completely ordinary turn, not the first one after a
resume) reliably works, in both trials. This plan's mechanism (§1's `sendChannelText` delivery, §2's
gating on `hadLostPrompt`, the `PreToolUse`/`PermissionRequest` hook re-firing once a real turn does
land) is confirmed working end-to-end - what's unconfirmed is that a *single* nudge, sent as that
specific first turn, is enough on its own. **This is a real, load-bearing open question this plan
does not yet resolve** - see §6 below for the options it leaves for a follow-up decision rather than
guessing at another wording change with no more live evidence than the last one had.

## §6 Open Question: The Nudge May Need a Second Beat

Given both trials above, shipping only §2's single nudge would very likely reproduce the exact bug
this plan set out to fix (operator sees "resumed", nothing happens, has to type something by hand) -
just with different wording than today's "please re-ask" notice. Options for a follow-up pass,
deliberately left undecided here rather than picking one without more live evidence:

- **Delay the nudge slightly** (e.g. a few seconds after `session.ready` resolves, past whatever
  Claude Code's own post-resume handling does) rather than sending it the instant the success branch
  runs. Cheapest to try; unconfirmed whether the "first turn" effect is about timing at all rather
  than being literally about turn-ordering.
- **Send a second, automatic follow-up nudge** if the session is still idle (or hasn't produced a new
  tool call) some seconds after the first - mechanically the same shape as this plan's existing nudge,
  fired a second time from a short timer rather than by the operator's hand. Directly reproduces what
  worked live in both trials, at the cost of a second injected turn (and its own cost) on every
  lost-prompt resume, not just the ones that need it.
- **Investigate Claude Code's resume/interrupted-turn handling directly** - **done, live-tested
  2026-08-10, ruled out as the cause.** Confirmed `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` was never
  reaching a spawned session at all: `session-launcher.ts`'s `ptyEnv()` unconditionally strips every
  `CLAUDE_CODE_*` var from the inherited environment (its own doc comment: a leaked `CLAUDE_CODE_*`
  var from an outer session disables transcript persistence, confirmed live during Stage 7). Installed
  Claude Code is 2.1.226 (past the 2.1.216 fix that made this flag's falsy values honored), so it
  runs with interrupted-turn auto-resume on its documented default. Explicitly re-added
  `CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "0"` to the resume-path env (temporarily, for this experiment
  only) and re-ran the exact same live trial on a third fresh disposable session: **identical
  outcome** - `Thinking...`, brief token spend ($0.09, same as both prior trials), idle, no retry, no
  reply. Reverted the env change (no benefit, and it would otherwise leave an undocumented flag
  permanently threaded into every resumed session for no gain). This rules out "Claude Code's own
  interrupted-turn auto-resume is consuming the nudge" as the mechanism - whatever is actually
  happening on that first post-resume turn is something else, still unconfirmed.

**Given all three trials now agree (plain wording, stronger wording, and with the auto-resume flag
disabled all produced the identical idle-no-retry-then-token-spend pattern), the remaining live
option with actual evidence behind it is the second one: send a second, automatic nudge if the
session is still idle after the first.** That is the only approach of the three that has been
directly observed to work in this investigation (an operator's second, ordinary message reliably
triggered the check-and-retry in both of the first two trials) - it doesn't depend on a root-cause
hypothesis that's now 0-for-1.

## §7 The Follow-Up Nudge (implemented)

`resumeSession`'s success branch now schedules a **single** automatic follow-up, `RESUME_NUDGE_
FOLLOWUP_DELAY_MS` (20s - generous headroom past the few-seconds turn length observed in all three
trials, not a guess at how long a real retry takes) after the first nudge, via the same injected
`delay` primitive `handleUnexpectedExit`'s backoff already uses (fire-and-forgotten, same pattern as
every other supervisor background action). It re-reads the row after the wait and sends a second,
more direct nudge ("Nothing happened after my last message...") **only** if the state is still
exactly `idle` - the confirmed failure signature. Every other outcome is a deliberate no-op:
`awaiting_input` means the first nudge worked (a fresh card is already up); `working` means a turn
is still genuinely in flight and nudging into that would inject an unsolicited second turn (same
reasoning §2 already applies to the first nudge); the row being `dead` or gone entirely means
`/kill`/`/rm` raced the wait, the same defensive check `resumeSession` itself already relies on.
Not a retry loop - exactly one follow-up, since every live trial that got a reply needed exactly one
second message, never more; looping further has no evidence behind it.

**Live-verified end-to-end, 2026-08-10 (trial 4, disposable session `nudge-verify4`):** real pending
`git commit --allow-empty` ask → real `/restart` → watched without sending anything into the topic.
Sequence observed: "the pending question was lost" notice → "resumed" → (first nudge, no visible
action, matching all three prior trials) → **~20s later, automatically:** `git status && git log`,
then a retried `git commit --allow-empty`, producing a **fresh permission card** with zero operator
input. Approved it via the Telegram "Allow" button and confirmed at the git level -
`git log --oneline` in the worktree shows the real commit (`972a368 "nudge verify4 test"`) landed.
This is the first trial, of four, where the operator never had to type anything for the loop to
close.

This is deliberately generic rather than naming the specific tool/command — the Bridge does not
capture that detail (see Scope boundary above), and Claude's own transcript already has it. Rendered
through `renderChannelTag`, this arrives exactly like a real operator message with `from="aibridge"`,
distinguishing it from the operator's own voice without inventing new `<channel>` tag semantics (the
`from` attribute is already free-form per `packages/protocol/src/meta.ts:43-48`; a synthetic
Bridge-authored `from` is an established convention, not a new one — see `session-lifecycle-
commands.ts:485`'s identical `"telegram"`/`"new-1"` pair for `/new`'s own injected first turn).

**Why a nudge is needed at all, not just automatic on resume (root cause, web-verified):** the
Messages API hard-requires a `tool_result` to immediately follow its `tool_use` block before the
conversation can continue (platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls —
"Tool result blocks must immediately follow their corresponding tool use blocks in the message
history"; violating it is the exact `400 invalid_request_error` — "tool_use ids were found without
tool_result blocks immediately after" — reported against Claude Code for this class of interrupted-
session bug). A PTY killed mid-`PreToolUse` never got that far: the tool was never approved, so
there is nothing to synthesize a `tool_result` for cleanly, and no public Claude Code documentation
describes what the resumed session does with that dangling state beyond what this plan already
confirmed live (idle, no retry, no error). One undocumented lead worth a cheap follow-up check before
or alongside the live-verification below: Claude Code has an internal, changelog-only env var
`CLAUDE_CODE_RESUME_INTERRUPTED_TURN` governing an "interrupted-turn auto-resume" behavior (fixed in
2.1.216) — if it's already enabled in the Bridge's generated session environment and only repairs the
transcript without re-invoking the tool, that's consistent with (and would explain) the exact idle-
but-not-erroring behavior observed live, and is worth confirming isn't itself a cheaper knob than
this nudge. Not blocking — this plan's nudge works regardless of that variable's state, since it acts
one turn later, after Claude Code's own resume logic (whatever it does) has already settled.

## §5 Accepted Limitations (explicit, not silent)

- **Claude may not retry the *exact* same action.** It might ask a clarifying question, decide the
  action is no longer relevant, or do something adjacent instead. The nudge wakes Claude up to
  reconsider its interrupted turn; it cannot force a literal replay, because the Bridge never captured
  the original tool call to replay in the first place. This is a wake-up call, not a resend.
  Live-verification (§Verification) checks the common case (a single straightforward pending Bash ask)
  actually re-asks — it cannot exhaustively prove every possible interrupted action retries cleanly.
- **Still a blanket per-row check**, same limitation the current "please re-ask" message already has:
  any row that happens to be `awaiting_input` gets nudged, with no way to distinguish "this pending
  question is still relevant" from a hypothetical stale one. Scoping this further isn't possible
  without capturing the original request (out of scope, §Scope boundary).
- **No new bound needed against a retry storm.** The nudge fires exactly once per successful
  `resumeSession` call (not a loop of its own). If the nudge's own re-triggered permission ask itself
  later times out unanswered, that is the pre-existing pending-permission-expiry path (already
  observed live this session — "expired: Bash (no answer in time)") and is unrelated to this change.
  `RESUME_BACKOFF_MS`/`MAX_CONSECUTIVE_RESUME_ATTEMPTS` govern repeated *crashes*, which this feature
  does not add to — a nudge that produces no reply is just a normal idle session, not a crash.

## Testing

1. **Unit — `resumeSession` sends the nudge exactly when `hadLostPrompt` and resume succeeds.**
   Mock `sendResumeNudge`; assert it is called once, with the correct `slug`/`topicId`, when the row's
   prior state was `awaiting_input` and `session.ready` resolves with `resumeFailed: false`.
2. **Unit — no nudge when the row was not `awaiting_input`.** A `working` row resumes normally with
   zero calls to `sendResumeNudge`.
3. **Unit — no nudge when `resumeFailed` is true.** The "couldn't resume its prior conversation"
   branch must not nudge a conversation Claude never actually resumed.
4. **Unit — no nudge when the row has no `sessionId`** or when `launchSession`/`session.ready` throws
   (the existing `catch` branch) — no live PTY exists to nudge in either case.
5. **Unit — `packages/bridge/test/reconciliation.test.ts`:** remove the now-deleted `lost_prompt`
   assertion; add/keep coverage confirming `reconcile()` no longer emits it (or, if the type is
   deleted outright, this is enforced by the type system and needs no runtime test).
6. **Regression — `packages/bridge/test/session-supervisor.test.ts`'s existing `handleUnexpectedExit`
   tests** continue to pass unmodified for the non-`awaiting_input` crash-resume cases already covered
   (they don't need new assertions; they confirm the shared `resumeSession` path wasn't broken by this
   change).

Tests 1-4 above add to `packages/bridge/test/session-supervisor.test.ts`, using the same plain-closure
test-double convention already there (e.g. `fakeConfirm()` recording calls into an array, inline
`launchSession: () => ({...})` fakes) — no mocking library, no new pattern.

**Gate (CLAUDE.md / design doc §9):** `bun test` (whole suite, all packages) and `bun run typecheck`
(`tsc --noEmit` per package) — every scenario above is part of that gate; none is exempt. This
directly extends §9 scenario 24 ("Reconciliation matrix — each of the five §4.5 rows — Unit"), whose
`awaiting_input` row previously had only the inert `reconcile()`-level assertion this plan retires
(see §3).

## Verification

**Not part of the `bun test`/`typecheck` gate above** — a separate, manually-run confirmation against
the real Telegram client and real Bridge, per this repo's existing convention of keeping unit-test
gating and live Telegram verification as two distinct steps (see `plans/codebase-hardening-plan.md`'s
"Verification per stage": tests + typecheck first, *then* a separate restart-and-live-verify pass via
`scripts/telegram-automation/`). Repeats the exact live experiment already run manually this session:

1. `/new aibridge <slug>` a disposable session via `scripts/telegram-automation/send-command.js`.
2. Prompt it with a message that requires an ask-listed action (e.g. `git commit --allow-empty`).
3. Confirm the pending "wants to run Bash" permission card appears in the session's own topic.
4. `/restart` the Bridge for real.
5. Without sending anything into that topic, confirm a **new** "wants to run Bash" permission card
   appears automatically (this is the behavior this plan adds — before the fix, the topic goes idle
   with only the "please re-ask" notice, confirmed live in this session's investigation).
6. Approve the new prompt; confirm at the git level (`git log`) that the commit now actually happens —
   proof the retried action, not just a resent message, went through.
7. `/rm` the disposable session afterward (cleanup, matches this plan's own dev process).
