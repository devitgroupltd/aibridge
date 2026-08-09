---
version: 0.4.0
status: draft
last_modified_utc: 2026-08-09T11:08:44Z
changelog:
  - "0.4.0 (2026-08-09): Fixed a CRITICAL bug in the plan itself — handleNewCommand calls newSessionContent(cmd) twice (topic-creation confirmation, then PTY send); setting cmd.sourceText as soon as slug was known would have leaked the attachment's raw file path into the topic-creation confirmation. Corrected the timing to set sourceText only between those two calls. Added a new Module Ownership & Wiring section covering the LateBound DI pattern needed (inboundMedia is constructed before sessionLifecycle exists), that handleNewCommand takes positional args not an options bag, and that repo-resolution stays inside handleNewCommand rather than being duplicated. Added a kill switch (AIBRIDGE_DISABLE_CAPTION_NEW), an observability log line, a new failure-mode catch for the inbox write, a Documentation section (renderHelp/about), corrected the test-mock-convention claim (the two existing fakeControlBot doubles are disjoint), and added inbox-write-failure and kill-switch test cases"
  - "0.3.0 (2026-08-09): Fixed the plan's central gap — handleNewCommand cannot stay unchanged; specified the sourceText/newSessionContent mechanism to reuse instead of inventing a prompt-override path, and corrected the topic-before-worktree ordering. Added a new Concurrency section (slug race, git worktree collisions). Added album/media-group scoping (v1: single-attachment only), a caption length caveat, inherited-risk notes (crash-resume, stale replayed messages, ask-list parity), fuzzy-repo-match notice parity, rate-governor and fire-and-forget-try/catch notes, corrected orphaned-inbox-file cleanup, cited session-lifecycle-commands.test.ts, and fixed the CI-gate phrasing to match the no-CI-yet reality"
  - "0.2.0 (2026-08-09): Corrected /new parser citation to parseNew in fleet-commands.ts (was wrongly attributed to session-lifecycle-commands.ts and a hand-rolled regex); fixed grammar to require a non-empty prompt and support the --opus/--haiku/--fable/--sonnet flag; removed the invented '/new usage' error in favor of the real generic fallback; cited actual test files/mock conventions (inbound-media.test.ts, command-dispatch.test.ts); tightened the guard description to the real nested !route/isControl shape"
  - "0.1.0 (2026-08-09): Initial plan created"
v040_touched_sections:
  - section: "§3 Module Ownership & Wiring"
    type: added
    summary: "New section: LateBound DI pattern needed for inbound-media.ts to reach handleNewCommand; positional-args correction; repo-resolution stays inside handleNewCommand"
  - section: "§4 Attachment-to-Session Handoff"
    type: modified
    summary: "Fixed CRITICAL double-newSessionContent timing bug; added kill switch, observability log line, new inbox-write failure catch"
  - section: "§9 Testing"
    type: modified
    summary: "Corrected disjoint-mock-fake claim; added inbox-write-failure and kill-switch test cases"
  - section: "§11 Documentation"
    type: added
    summary: "New section: renderHelp/command-list and /about updates needed"
v030_touched_sections:
  - section: "§3 Attachment-to-Session Handoff"
    type: modified
    summary: "Specified the required handleNewCommand extension, the sourceText mechanism, corrected topic-before-worktree ordering, rate-governor and try/catch notes"
  - section: "§4 Concurrency"
    type: added
    summary: "New section: slug race widened by the download await; git worktree add branch-collision risk under concurrent triggers"
  - section: "§2 Trigger Grammar & Parsing"
    type: modified
    summary: "Scoped media-group/album handling out of v1; added caption length caveat"
  - section: "§1 Overview"
    type: modified
    summary: "Noted inherited ask-list rule parity (commit/push stays gated)"
  - section: "§6 Error Handling"
    type: modified
    summary: "Added fuzzy-repo-match notice parity, inherited crash-resume/stale-replay risk notes, corrected orphaned-inbox-file cleanup ordering"
  - section: "§7 Testing"
    type: modified
    summary: "Added session-lifecycle-commands.test.ts, album regression case, concurrency test case; corrected CI-gate phrasing to match no-CI-yet reality"
v020_touched_sections:
  - section: "§2 Trigger Grammar & Parsing"
    type: modified
    summary: "Corrected parser citation (parseNew in fleet-commands.ts, unexported), real grammar (required prompt, model flag), removed invented usage error"
  - section: "§1 Overview"
    type: modified
    summary: "Cited exact guard line numbers and nested if-shape"
  - section: "§4 Error Handling"
    type: modified
    summary: "Replaced invented missing-argument usage error with the real generic fallback; noted non-control silent-return case"
  - section: "§5 Testing"
    type: modified
    summary: "Replaced hypothetical regex test table with parseNew-based cases; cited real test files and mock conventions"
---

# Attachment-Triggered Session Creation (control-topic `/new` via caption)

> **Status: implemented and shipped**, including two follow-ups added after live use surfaced
> real gaps (both live-verified working):
> - **NL-router fallback** for a freeform caption (not literal `/new <repo> <prompt>` syntax) -
>   routes through the same `nl-router.ts`/`routeText` every other unmatched control-topic message
>   already uses, narrowly scoped to `kind: "new"` matches only. See
>   `inbound-media.ts`'s `routeCaptionToNewCommand`/`handleControlTopicAttachment`.
> - **Reply-to-retry** - replying (Telegram's native reply) to an earlier message with "retry"/
>   "try again" re-runs that earlier message's own text through today's dispatch logic, taking
>   priority over `retry-store.ts`'s narrower topic-keyed expired-confirmation stash. See
>   `command-dispatch.ts`'s `isRetryPhrase` branch and `inbound-media.ts`'s `reply_to_message`
>   threading. Extended once more (2026-08-09): the first cut only threaded the replied-to
>   message's *text/caption* through - retrying a captioned photo/document silently dropped the
>   attachment itself, leaving Claude with only the caption on the second attempt.
>   `inbound-media.ts`'s `attachmentFromReplyTarget` now detects when the reply target carried
>   media and re-downloads/re-announces it via `handleAttachmentMessage`, same as a live attachment
>   message would; `TelegramReplyTarget` (`telegram.ts`) was extended with the same media fields
>   `TelegramMessage` already carries so this has something to read.
>

## Overview

**Audience:** aibridge maintainer (solo operator/developer of this Bridge).

Today, sending a photo/document/video/audio message into the Telegram **General/control topic**
(topic 1, or no `message_thread_id`) is rejected outright: `handleAttachmentMessage` in
[`packages/bridge/src/inbound-media.ts:228-231`](../packages/bridge/src/inbound-media.ts) runs
`if (!route) { if (isControl) confirmSessionCommand(...); return; }` and (for the control topic)
replies with a fixed guidance string ("Send an image in a session topic - the control topic has no
session to hand it to."), per §5.6 of
[`plans/telegram-claude-session-control-plan.md`](telegram-claude-session-control-plan.md). This is
correct as designed: the control topic never hosts a session, and there is no repo name embedded in
a bare image to resolve a worktree from.

This plan adds a **caption-driven session-creation path**: if an attachment lands in the control
topic *and* its caption begins with `/new <repo> [prompt...]` (the same grammar as the existing
text-only `/new` command), the Bridge creates a new session exactly as `/new` does today — worktree,
forum topic, session launch — and seeds that session's first turn with the downloaded attachment
plus the remainder of the caption as the prompt, using the same inbox/announcement plumbing already
used for attachments sent into an *existing* session topic. Attachments with no caption, or a caption
that isn't a `/new` invocation, keep today's rejection behavior unchanged.

This plan inherits, unmodified, every safety/permission property the main plan already establishes
for a `/new`-created session — most importantly, the generated per-session `ask`-list rule (main
plan §6.2) still puts `git commit`/`git push` in `permissions.ask`, never `allow`, exactly as it does
for a text-typed `/new`. An attachment-triggered session is not a "lighter-weight" or less-gated
session in any respect; only how the session was *invoked* differs.

## Trigger Grammar & Parsing

- Only `message.caption` (Telegram's attachment-caption field) is consulted — not the message body,
  which attachments don't have.
- **Media groups (albums) are out of scope for v1 — OPEN Q, resolved.** Telegram attaches a caption
  to only *one* message of a multi-photo/video album (`media_group_id`); the other messages in the
  group arrive as separate updates with no caption, no guaranteed delivery order, and no "album
  complete" signal. `TelegramMessage` (`packages/bridge/src/telegram.ts`) has no `media_group_id`
  field today, and `handleAttachmentMessage` processes every message independently — there is no
  buffering to correctly fold a captioned album into one multi-attachment session.
  **Recommendation (applied): explicitly scope this plan to single-attachment messages only.** An
  album send with a `/new` caption on one photo will create a session from that one photo and its
  caption; the sibling photos (no caption, same control topic) fall through to the existing §5.6
  rejection reply, each producing a separate "send it in a session topic" message. This is a known,
  accepted v1 limitation, not a silent gap — see the Testing section for the explicit regression case
  that pins this behavior. Buffering by `media_group_id` with a debounce window is the natural
  follow-up if this proves to matter in practice, but is not built here (YAGNI until an operator
  actually hits it).
- Telegram caps captions at 1024 characters; a caption at or near that limit may have been silently
  truncated by the *sender's own client* before the Bridge ever sees it. This is not a Bridge bug and
  not distinguishable from an intentionally short prompt — no special handling is added, but this is
  worth knowing when debugging a session that starts with what looks like a truncated instruction.
- This plan does **not** invent a new parsing grammar: it feeds the caption through the exact same
  parser the text-only command already uses — `parseNew(rest: string)` in
  [`fleet-commands.ts:99-111`](../packages/bridge/src/fleet-commands.ts), reached today only via
  `parseFleetCommand(text)`'s internal switch (`fleet-commands.ts:422-423`). `parseNew` is currently
  **unexported**; this plan requires either (a) exporting it directly, or (b) building the synthetic
  string `` `/new ${caption}` `` and calling `parseFleetCommand`, then narrowing on
  `result?.kind === "new"`. Option (a) is simpler and avoids constructing throwaway strings — take
  that unless `parseFleetCommand`'s switch does something else load-bearing for `kind: "new"` that
  would be skipped by calling `parseNew` directly (verify at implementation time; from current
  reading, it does not).
- `parseNew`'s real grammar: an optional leading `--opus|--haiku|--fable|--sonnet` model-flag token,
  then a repo slug, then a **required** prompt remainder — `if (!repo || !prompt) return null`
  (`fleet-commands.ts:109`). A caption with no prompt text (e.g. caption is exactly `/new myrepo`) is
  therefore **not** a valid invocation under the real grammar, same as it isn't for the text-only
  command today.
- If `parseNew` returns `null` (missing prompt, missing repo, or any other grammar mismatch),
  **or** the caption doesn't start with `/new`, **or** there is no caption at all — fall back to
  today's unchanged control-topic rejection reply (§5.6). This plan does not add a new "/new usage"
  error message: a text-only `/new myrepo` (no prompt) falls through to the existing generic
  "Unrecognised control-topic command. Try /new, /ls or /help." fallback today
  (`command-dispatch.ts:494-496`), and an attachment with that same malformed caption gets the
  existing attachment-rejection reply — not a new bespoke error. Do not guess intent beyond what
  `parseNew` already accepts.

## Module Ownership & Wiring

- **This is not a same-file change — it spans a real dependency-injection boundary that must be
  resolved before implementation.** The caption/download logic naturally lives in
  `handleAttachmentMessage` (`inbound-media.ts:214-251`), but the thing it needs to call,
  `handleNewCommand`, lives in `session-lifecycle-commands.ts` and today is only ever called from
  `dispatchFleetCommand` in `command-dispatch.ts:161-166` (itself wrapped in `fireAndForget`).
  `inbound-media.ts` has **no static import** of either `session-lifecycle-commands.ts` or
  `command-dispatch.ts` today — every cross-module call it makes goes through an injected callback in
  `InboundMediaOptions` (e.g. `dispatchInboundMessage`), specifically to avoid a circular import
  (`inbound-media.ts:26-28`). Compounding this, in `index.ts`, `inboundMedia` is constructed
  (`index.ts:324`) **before** `sessionLifecycle` exists (`index.ts:574`) — a direct import would not
  just violate the existing convention, it would be a forward reference to something not yet built.
  **Resolution:** add a new injected option to `InboundMediaOptions` (e.g.
  `createSessionFromAttachment`), following the exact same `LateBound<T>` pattern already used for
  `commandDispatch` (`index.ts:319`) and `fleetConfirmFlow` (`index.ts:570`), wired in `index.ts` once
  `sessionLifecycle` is constructed. Do not add a static import in either direction.
- **`handleNewCommand` takes two positional arguments, not an options bag** —
  `handleNewCommand(cmd: Extract<FleetCommand, {kind:"new"}>, controlTopicId: number | undefined)`
  (`session-lifecycle-commands.ts:242`). The "pending attachment" payload belongs on the `FleetCommand`
  `"new"` variant itself (a new optional field, e.g. `pendingAttachment?: {kind, tempPath, name}`),
  the same way `sourceText` already rides on that type (`fleet-commands.ts:25`) — not as a third
  function parameter or an "options" object that doesn't exist today.
- **The repo-resolution/fuzzy-match logic is inlined inside `handleNewCommand`
  (`session-lifecycle-commands.ts:248-261`), not separately callable.** Since this plan's step 1
  validates the repo *before* downloading the attachment (to avoid downloading for a doomed request),
  either that resolution logic needs extracting into a small callable helper `handleNewCommand` also
  uses (single source of truth — do not duplicate the lookup/fuzzy-match at the new call site; a
  duplicated copy is exactly the kind of drift Testing item 3's byte-for-byte check exists to catch),
  or the plan accepts downloading before resolution and relies on `handleNewCommand`'s own existing
  resolution failure path (simpler, at the cost of one wasted download on an unresolvable repo). Given
  Telegram attachments are typically small (photos/screenshots), the simpler option is acceptable;
  this plan chooses **not to extract a helper** — validate the caption grammar (`parseNew`) before
  downloading, but defer repo resolution to `handleNewCommand` itself, and accept the download-before-
  final-resolution ordering as a minor, low-cost inefficiency rather than adding a second call site
  for that logic.

## Attachment-to-Session Handoff

- Reuse `handleAttachmentMessage`'s existing download step (the part that runs *after* the
  `!route` guard today) to fetch the file via Telegram's file API — do not write a second download
  path.
- **Use the existing `sourceText` mechanism instead of inventing a prompt-override path — but timing
  matters, and getting it wrong ships a bug.** `FleetCommand`'s `"new"` variant already has an
  optional `sourceText` field, and `newSessionContent(cmd)` (`fleet-commands.ts:113-121`) already
  resolves to `cmd.sourceText ?? cmd.prompt` — the same mechanism the NL-router path uses
  (`nl-dispatch.ts:221`) to send the operator's verbatim text as the first turn while keeping
  `cmd.prompt` clean for slug/title derivation. **`handleNewCommand` calls `newSessionContent(cmd)`
  twice, not once** — first at line 291, to post "the visible record of what was actually asked for"
  into the brand-new topic immediately after topic creation (before worktree/launch even start), and
  again at line 367, the actual first-turn PTY delivery after a successful launch. If `cmd.sourceText`
  were set as soon as `slug` is known (right after line 275-276, before topic creation), the line-291
  confirmation would *also* render the announcement string — leaking a raw absolute file path into the
  topic's own "what was asked for" record, exactly the corruption this plan otherwise takes care to
  avoid for `cmd.prompt`. **Correct timing: leave `cmd.sourceText` unset through line 291 (so that
  confirmation shows the clean caption remainder, same as any other `/new`), and set it only after
  line 291, before line 367** — i.e. set it once inside `handleNewCommand`, in the window after the
  topic-creation confirmation post and before the PTY send, once the attachment has been moved into
  the session's inbox and `absPath` is known. `cmd.prompt` itself is never touched — it's always the
  clean caption remainder, used for `slugFromPrompt`/the topic title throughout.
- Order of operations (corrected — the real code creates the topic *before* the worktree, not
  after: `createForumTopic` at `session-lifecycle-commands.ts:280`, then `ensureWorktree` inside the
  non-async `launchSession` at `session-launcher.ts:315,324` — everything inside `launchSession` runs
  synchronously in the same tick as the call, so the only await point between slug computation
  (`:275-276`) and `sessionStore.insert` (`:321`) is `createForumTopic` itself):
  1. Parse and validate the caption's `/new` grammar (`parseNew`) only — do not duplicate repo
     resolution here (see Module Ownership & Wiring). On grammar failure (missing prompt, not a
     `/new` invocation, etc.), reply with today's unchanged control-topic rejection reply (§5.6) and
     do **not** download the file or call `handleNewCommand`.
  2. Download the attachment to a temp path (reuse the existing per-kind download helper). A repo
     that turns out to be unresolvable is only caught inside `handleNewCommand` in step 3, after this
     download — an accepted, low-cost inefficiency (see Module Ownership & Wiring).
  3. Call `handleNewCommand` (via the new injected option) with `cmd.prompt` = caption remainder and
     `cmd.pendingAttachment` = the temp-path payload from step 2. On repo-resolution failure, reply
     with the same error text `/new` already produces — no new copy — with no worktree/topic created.
  4. Inside `handleNewCommand`, after the line-291 topic-creation confirmation (which renders
     `cmd.prompt`, unaffected by this change) and before the line-367 PTY send: move the downloaded
     file into the new session's inbox via `writeAttachmentToInbox(stateDir, slug, name, bytes)` (same
     function used for the existing-session attachment path — no new inbox convention), then set
     `cmd.sourceText` to `buildAttachmentAnnouncement(kind, absPath, captionRemainder)` so line 367's
     `newSessionContent(cmd)` picks it up.
  - **New failure mode step 4 introduces, not covered by any existing catch:** the inbox write in
    step 4 happens *after* topic creation succeeds (line 284) but is not inside the launch-failure
    catch (`:304-316`), which only wraps `launchSession`. If `writeAttachmentToInbox` itself throws
    (disk full, permission error), the topic is left orphaned with no cleanup path today. This plan
    adds a dedicated `try/catch` around the step-4 inbox write that mirrors the existing orphaned-
    topic cleanup (`deleteForumTopic` inside a nested try/catch, per `:304-316`) rather than assuming
    the existing launch-failure catch already covers it.
  - If topic/worktree/launch creation fails after a successful step-4 inbox write, extend the
    existing orphaned-topic cleanup (`session-lifecycle-commands.ts:305-313`) to also delete the
    inbox file it just wrote — `slug`/`absPath` are both in scope by closure at that catch site.
  - `checkConcurrencyCap` (`session-lifecycle-commands.ts:266-273`) can reject the request before any
    of the above runs (fleet at capacity) — this is a pre-existing `handleNewCommand` failure mode
    this plan inherits unmodified; reply with whatever text `handleNewCommand` already produces for
    it, no new copy needed.
- `createForumTopic`/`deleteForumTopic` calls in `handleNewCommand` bypass the feed rate governor
  (`feedGovernor`) entirely today — pre-existing, not introduced by this plan, but worth noting since
  an attachment-triggered flow is plausibly higher-frequency (e.g. forwarded/scripted sends) than a
  human typing `/new`; a burst could 429 with only the existing generic catch-and-report, no backoff.
  No new mitigation is in scope for this plan; call out as a known limitation.
- Implementation note: any new fire-and-forget (`void asyncFn()`) work added in this path must carry
  its own internal `try/catch` — `inbound-media.ts` is already named in
  [`plans/codebase-hardening-plan.md`](codebase-hardening-plan.md) (P0-2) as relying on this
  unenforced convention, backed by a fatal `unhandledRejection → process.exit(1)` handler; one missed
  catch here takes down the whole fleet, not just this feature.
- **Kill switch:** given this plan itself documents several risks it explicitly declines to fully
  close (the widened slug race and worktree-collision risk below, the rate-governor bypass above),
  and the trigger surface is a destructive, unconfirmed control-topic command, add an environment-
  variable toggle following the existing precedent (`AIBRIDGE_SKIP_LAUNCH`, `AIBRIDGE_DEV_MIRROR_PTY`,
  `AIBRIDGE_DEBUG_PTY_LOG` — `index.ts`, `session-launcher.ts:397`), e.g.
  `AIBRIDGE_DISABLE_CAPTION_NEW=1`, checked in `handleAttachmentMessage` before the new caption-check
  branch runs. If set, fall back to today's unchanged §5.6 rejection reply — a cheap, reversible way
  to disable this specific path in production without a redeploy of unrelated fixes.
- **Observability:** log an `INFO`-level line when a session is created via this path — repo, slug,
  and `from.id` — distinct from a text-typed `/new`, so a caption-triggered session is identifiable
  after the fact (the existing convention in `inbound-media.ts` only logs on `WARN`/failure today;
  this plan adds one success-path log line for exactly this trigger, not a broader logging change).

## Concurrency

- **Slug race (inherited, widened by this plan):** `handleNewCommand` computes
  `uniqueSlug(base, sessionStore.slugs())` (line 276) synchronously, but its first `await` isn't
  until `createForumTopic` (line 280) — well before `sessionStore.insert(...)` (line 321). Two
  back-to-back `/new` invocations can interleave in that window today (pre-existing, undocumented
  race). This plan adds a *new* async hop — the Telegram file download — **before** session creation
  even starts, widening that window further for the attachment-triggered path specifically. No fix is
  proposed here (the underlying race is pre-existing and out of this plan's scope to close), but it
  must be named as a known risk this plan measurably increases, and the Testing section below adds a
  case for it.
- **Git worktree collisions:** `git worktree add` refuses to check out a branch already checked out
  in another worktree, and worktrees share the parent repo's `.git` metadata — concurrent
  `git worktree add` calls against the same target repo risk a `.git/config.lock` collision, not
  silent corruption (a hard, visible error). Attachment-triggered `/new` removes the "one human
  typing sequentially" natural throttle that has implicitly protected text-only `/new` from this so
  far, making concurrent triggers against the same repo more plausible. No serialization is proposed
  in this plan (would require a per-repo-slug queue/mutex, a larger change); this section exists to
  make the risk explicit and to require the concurrency test case below rather than let it surface
  as a confusing production failure.

## Confirm-mode (`/voiceconfirm`) Interaction

- `/voiceconfirm` gates *voice-transcribed* commands behind a review step before they're sent as if
  typed (per the existing voice-command flow) — it has no defined interaction with attachment
  captions today because captions were never a command source before this plan.
- Decision: attachment-caption `/new` invocations are **not** routed through the voice-confirm review
  step, regardless of the operator's current `/voiceconfirm` setting. Rationale: `/voiceconfirm`
  exists specifically to let the operator review a *speech-to-text transcription* for
  mis-transcription risk before it's treated as a typed command; a caption is operator-typed text
  Telegram delivers verbatim, with no transcription step in between, so there is nothing for that
  review to catch. Applying it here would just add a redundant confirmation tap to every
  attachment-triggered session with no accuracy benefit.
- This does not change `/voiceconfirm`'s behavior for anything else — voice messages sent to the
  control topic continue through the existing confirm/auto-send flow exactly as today.

## Error Handling

- **Unknown/misspelled repo slug:** reply with the exact error text the text-only `/new` command
  already produces for an unresolvable slug (looked up via the same registry call) — do not create
  any worktree, topic, or download.
- **Missing repo or missing prompt** (caption is exactly `/new`, `/new <repo>` with no prompt
  remainder, or otherwise fails `parseNew`'s grammar): there is no dedicated `/new`-usage error
  today — a text-only `/new myrepo` with no prompt falls through to the existing generic
  "Unrecognised control-topic command. Try /new, /ls or /help." fallback (`command-dispatch.ts:
  494-496`), not a `/new`-specific message. This plan keeps parity with that: any caption that fails
  `parseNew` falls back to the existing attachment-rejection reply (§5.6) rather than a new bespoke
  error. (Note also that `handleAttachmentMessage`'s guard is nested — a non-control topic with no
  route hits the same `!route` branch but returns silently with **no** reply at all; this plan's
  caption check only applies inside the `isControl` inner branch and must not change that silent
  no-route/non-control behavior.)
- **Attachment download failure** (Telegram file API error, oversized file, etc.): reply with the
  attachment-kind-specific error text `handleAttachmentMessage` already uses for a download failure
  on an existing-session attachment. This plan's step ordering runs caption/repo validation first,
  then the download, then the `handleNewCommand` call — a download failure happens before any
  worktree, topic, or session state exists, so there is nothing to clean up.
- **Topic/worktree/launch failure after a successful download:** `slug` is computed early inside
  `handleNewCommand` (before topic creation), so the inbox move (step 4) can happen before topic
  creation, worktree creation, or launch — meaning a later failure in that sequence can leave an
  orphaned inbox file even though no topic/worktree/session row exists. Reply with the same failure
  text `/new` already produces for that failure, and delete the moved inbox file as part of the same
  cleanup path (`session-lifecycle-commands.ts:305-313`) that already removes an orphaned topic on a
  launch failure — extend that cleanup to also remove the inbox file it just wrote.
- **Caption present but not a `/new` invocation:** unchanged — today's fixed rejection reply per
  §5.6, verbatim.
- **Unregistered-but-fuzzy-matched repo name:** `handleNewCommand`'s existing fuzzy-match fallback
  (for voice-mangled repo names) silently posts an "Unknown repo X - using closest match Y" notice
  via `confirmSessionCommand` when it substitutes a close match. This plan's caption path must
  trigger the same notice for the same reason — an operator whose caption has a typo'd repo slug
  should see that a different repo was actually used, not be left to discover it later.
- **Inherited, accepted risks — not addressed by this plan:**
  - *Crash-resume race* (main plan §4.5): if the Bridge crashes/restarts between session launch and
    Claude Code persisting its first exchange, the only recovery path is `claude --resume
    <session_id>` on a fresh PTY, which can itself fail ("Claude reported no matching session") if
    the first exchange never landed. An attachment-triggered session's first turn (the announcement)
    is exactly as exposed to this as any text-triggered `/new`'s first turn — no new mitigation is
    added here; this plan does not make the race worse, it just doesn't fix it.
  - *Stale replayed messages on restart* (main plan §11, "Deliberately not building"): a Bridge
    restart replays queued Telegram updates with no staleness check, so a stale destructive
    control-topic command can re-fire on boot. Attachment-caption `/new` is a destructive,
    session-creating control-topic command — the same class this already-accepted risk describes.
    This plan does not close that gap; it adds one more command shape subject to it.

## Testing

Per CLAUDE.md's `Commands` convention (unit-test any silent-wrong failure mode plus every
exit-code/protocol contract another component branches on):

1. **Unit — caption grammar parsing** (reusing `parseNew` from `fleet-commands.ts` directly, per
   the Trigger Grammar section — no new regex to test in isolation, but the call-site glue needs
   coverage in `packages/bridge/test/inbound-media.test.ts`, following that file's existing
   `fakeControlBot()`/`message(overrides)` builder conventions):
   - `/new myrepo fix the login bug` → `parseNew` returns `{repo: "myrepo", prompt: "fix the login
     bug"}`; call-site proceeds to session creation.
   - `/new myrepo` (no prompt remainder) → `parseNew` returns `null` (real grammar requires a
     prompt); call-site falls back to the existing §5.6 rejection reply, not a new usage error.
   - `/new --opus myrepo fix the login bug` → `parseNew` consumes the model flag; call-site proceeds
     with the requested model, same as text-only `/new`.
   - `/new` alone, or `/new   ` (whitespace only) → `parseNew` returns `null`; existing rejection
     reply.
   - `Here's the bug` (no leading `/new`) → not recognized as a `/new` invocation; falls through to
     existing rejection path.
   - `/newx myrepo do a thing` (prefix collision, not the `/new` token) → not recognized.
   - Empty caption (`undefined`/`""`) → falls through to existing rejection path.
   Test type: unit/integration, `packages/bridge` test suite (`bun test`), extending
   `inbound-media.test.ts`. Maps to acceptance: "caption call-site defers entirely to the real
   `parseNew` grammar, with no divergent regex."

2. **Integration — happy path, image + valid repo caption:**
   - Simulate an inbound photo message to the control topic with caption `/new demo-repo add a
     README`. Assert: a forum topic is created, a worktree is created, a routing-table row exists
     mapping the new topic to the new session, the session's inbox contains the downloaded file, and
     `cmd.sourceText` (hence the session's first-turn prompt) equals `buildAttachmentAnnouncement(
     "image", <path>, "add a README")` while `cmd.prompt`/the topic title stay derived from the
     clean caption remainder ("add a README"), not the announcement string.
   Test type: integration, `packages/bridge`, extending `test/inbound-media.test.ts`,
   `test/command-dispatch.test.ts`, **and `test/session-lifecycle-commands.test.ts`** — that file
   currently has zero coverage of `handleNewCommand` despite covering all its siblings
   (`handleKillCommand`, `handleRmCommand`, etc.), and it's the file that needs the new
   pending-attachment-payload coverage most directly. **Note: the two files' existing
   `fakeControlBot()` doubles are disjoint, not directly reusable "as-is" for this test** —
   `inbound-media.test.ts`'s has `{sendMessage, editMessageText, getFile, downloadFile, sent}` (no
   forum-topic methods), while `session-lifecycle-commands.test.ts`'s has `{sendMessage,
   createForumTopic, editForumTopic, closeForumTopic, deleteForumTopic, sent, forumTopicCalls}` (no
   download methods) — this end-to-end test needs both capabilities at once, so extend one fake (or
   write a small merged one for this test) rather than assuming either suffices unchanged. Follow the
   same hand-rolled-closures-pushing-to-plain-arrays style either way — no mocking library. Maps to
   acceptance: "attachment-triggered `/new` produces the same session shape as text-only `/new`, with
   the announcement as sourceText, and the topic-creation confirmation still shows the clean prompt."

3. **Integration — unknown repo slug:** caption `/new not-a-real-repo hello` → assert no worktree/
   topic/routing-row is created, and the reply text equals the text-only `/new` unknown-repo error
   string (byte-for-byte, to catch drift between the two call sites). Maps to acceptance: "error
   text/behavior parity with text-only `/new`."

4. **Integration — caption not a `/new` invocation:** caption `check this out` on a photo → assert
   the existing fixed rejection reply is sent unchanged, and no session state is created. Regression
   guard for §5.6's existing behavior (this plan must not change it).

5. **Integration — download failure after valid caption:** force the file-download mock to reject →
   assert the attachment-kind download-failure error text is sent, and no worktree/topic/routing-row
   exists. Maps to acceptance: "no partial session state on download failure."

6. **Integration — worktree/session-launch failure after successful download:** force the
   worktree-creation (or topic-creation) mock to reject after a successful download → assert the
   `/new`-parity failure text is sent, no routing-row exists, and no file was written under any
   session's inbox directory (only the temp download path, which is then discarded).

7. **Unit — `/voiceconfirm` bypass:** with the operator's `/voiceconfirm` setting toggled on,
   simulate a caption-triggered `/new` → assert it is dispatched immediately (not queued into the
   voice-confirm review flow). Maps to acceptance: "attachment-caption `/new` never enters
   voice-confirm review, regardless of setting."

8. **Integration — media-group (album) regression:** simulate three photo messages sharing one
   `media_group_id` in the control topic, with the `/new demo-repo add a README` caption on only the
   first. Assert: exactly one session is created (from the captioned message), and the two uncaptioned
   siblings each receive the existing §5.6 rejection reply — pins the documented v1 scope decision
   (Trigger Grammar section) rather than leaving album behavior unspecified. If `media_group_id` isn't
   modeled on `TelegramMessage` yet, this test also covers adding that field.

9. **Integration — concurrent attachment-triggered `/new` for the same repo:** fire two
   attachment+`/new demo-repo ...` messages back to back (before the first's `sessionStore.insert`
   resolves) → assert both either succeed with distinct slugs/branches, or the second fails with a
   clear, surfaced error (not a silent slug collision or an unhandled rejection). Maps to acceptance:
   "the pre-existing slug race is not worsened into a silent failure by this plan's added download
   await" (see Concurrency section).

10. **Integration — inbox-write failure after topic creation:** force `writeAttachmentToInbox` to
    throw after a successful `createForumTopic` → assert the orphaned topic is cleaned up (the new
    try/catch added per the Attachment-to-Session Handoff section) and a failure reply is sent — this
    is the one failure window with no existing cleanage path today.

11. **Unit — kill switch:** with `AIBRIDGE_DISABLE_CAPTION_NEW=1` set, simulate a valid
    attachment+`/new` caption → assert today's unchanged §5.6 rejection reply is sent and no session
    is created, regardless of an otherwise-valid caption.

Test gate: `bun test` and `bun run typecheck`, run locally before merge. Note: per
[`plans/codebase-hardening-plan.md`](codebase-hardening-plan.md) (P1-6), no CI workflow exists yet for
this repo — this is currently a manual/local gate, not an enforced automated one, despite the main
plan's §9 describing it aspirationally as a CI job.

## Documentation

- Update `renderHelp()`'s `/new` line and the Telegram native command-list text
  (`fleet-commands.ts:673,726-732`) to mention that a captioned attachment in the control topic does
  the same thing — this is the exact reference surface the plan's stated audience (the solo operator,
  from a phone) would consult, and it's silent on this capability today.
- `about.ts` (`/about` — "what this bot can do, with examples") has no mention of attachments/captions
  at all today, a pre-existing gap this feature makes more relevant; add a one-line example
  (`/new <repo> <prompt>` via a photo caption) if `/about` is touched as part of this work — not a
  blocker if it isn't, but don't leave the new capability undiscoverable from every reference surface
  at once.

## Verification

- Manual: send a photo with caption `/new <a real registered repo slug> say hello` into the General
  topic of the live Telegram group; confirm a new forum topic appears, the session starts, and its
  first reply reflects having seen the image + "say hello" prompt. Use
  `scripts/telegram-automation/send-command.js` (or a small one-off script per that folder's
  convention, since this exercises an attachment rather than plain text) plus
  `scripts/telegram-automation/list-topics.js` to confirm the new topic was created.
- Manual: repeat with an unregistered repo slug in the caption; confirm the control-topic reply
  matches the text-only `/new` unknown-repo error, and no new topic appears
  (`list-topics.js` before/after comparison).
- Manual: send a photo with a non-`/new` caption (or no caption) into the control topic; confirm the
  existing rejection reply is unchanged (regression check against §5.6's already-live-verified
  behavior, per the plan's `Status` note that this scenario was verified 2026-08-05).
- Remember to restart the Bridge (`bun run bridge:restart` / `scripts/dev-bridge.sh restart`) before
  any live check — per CLAUDE.md, the daemon only picks up new code on restart.
