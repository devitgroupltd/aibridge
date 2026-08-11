---
version: 0.2.3
status: solid
last_modified_utc: 2026-08-11T20:05:00Z
changelog:
  - "0.1.0 (2026-08-10): Frontmatter added — plan previously lacked valid frontmatter"
  - "0.2.0 (2026-08-10): plan-craft pass 1 — fixed file-attribution error (card-senders.ts, not fleet-commands.ts), reconciled cost framing with §10.5's non-interactive credit pool, resolved both open questions (answer-path shape, grounding-text builder location) with concrete decisions, added explicit nlRouterConfig wiring gap and routeOrFallback insertion point, pinned the new CLI call's operational details (cwd/timeout/--strict-mcp-config/log level), added dedicated Testing and Verification sections, reworded two imprecise claims (kind='forward' framing, misattributed CLAUDE.md quote)"
  - "0.2.1 (2026-08-10): Implemented per §3/§8/§9 and live-verified against the real Telegram client - added a Known Limitation section documenting a real gap the live check surfaced: the unchanged classifier sometimes reads a question that names real commands (e.g. \"does /ship duplicate /deploy?\") as kind='help', so it never reaches this plan's Q&A path for that exact message"
  - "0.2.2 (2026-08-10): Resolved the Known Limitation's deferred follow-up - narrowed SYSTEM_INSTRUCTIONS_BASE's kind='help'/'about' trigger so a question naming a specific command is excluded and falls through to kind='forward' instead"
  - "0.2.3 (2026-08-11): Resolved a second, narrower instance of the same gap, live-observed on a control-topic message naming no exact command ('branch' vs 'session' synonym question) - widened SYSTEM_INSTRUCTIONS_BASE's carve-out to also exclude hypothetical/meta questions about the classifier's own interpretation of alternate wording"
v020_touched_sections:
  - section: "§1 Problem"
    type: modified
    summary: "Reworded kind='forward' framing — it always resolves to matched:false, not a competing wrong classification"
  - section: "§3 Chosen design"
    type: modified
    summary: "Fixed card-senders.ts/about.ts/commands.ts attribution, added CLI-only-regardless-of-/router note, pinned execFile operational details and log level, reconciled cost claim with §10.5"
  - section: "§4 Scope / non-goals"
    type: modified
    summary: "Reworded misattributed CLAUDE.md quote; cited §11 precedent (control-topic /browse//find non-goal) for the no-repo-access decision"
  - section: "§5 Open items before implementation"
    type: modified
    summary: "Resolved both open questions with concrete decisions; added nlRouterConfig wiring gap and routeOrFallback insertion-point note"
  - section: "§8 Testing"
    type: added
    summary: "New dedicated Testing section with numbered scenarios per Test Coverage convention"
  - section: "§9 Verification"
    type: added
    summary: "New manual/operational verification section using scripts/telegram-automation"
v021_touched_sections:
  - section: "§10 Known limitation (live-verified 2026-08-10)"
    type: added
    summary: "Documents the classifier-intercepts-as-help gap found during live Telegram verification"
v022_touched_sections:
  - section: "§10 Known limitation (live-verified 2026-08-10)"
    type: modified
    summary: "Added a Resolved note - implemented the deferred classifier-narrowing follow-up in nl-router.ts's SYSTEM_INSTRUCTIONS_BASE"
---

# Control-topic free-form NL dialogue — design plan

## Overview

**Audience:** aibridge maintainer (single operator/developer).

Design for adding a grounded, context-aware free-text Q&A path to the Telegram control topic's
natural-language router, without weakening the existing forced-schema command classifier that
`kill`/`rm`/`restart`/`deploy` rely on. Companion doc to
[`plans/telegram-claude-session-control-plan.md`](telegram-claude-session-control-plan.md) §3.5 (NL
command routing) — that doc remains the source of truth for the classifier itself; this plan only adds
a second, isolated call plus a small history buffer, both scoped to the control topic.

## Problem

Free text in the control topic that doesn't match an exact `/command` goes through `nl-router.ts`'s
`routeText`, which does exactly one thing: classify the message into one of a fixed set of
`RouterAction`/`FleetCommand`/`SessionCommand` `kind`s, via a forced-structured-output LLM call
(`tool_choice: {type:"tool", name:"route"}` on the API backend, `--json-schema` on the CLI backend).
There is no "answer the question" outcome — a genuine meta-question about the bot ("does /ship call
merge or duplicate it?") has no `kind` that fits it, so the classifier reports `matched: false`
(`kind='forward'` always maps to `null`/unmatched by design — see `nl-router.ts:448` — it is not a
distinct "wrong classification" outcome competing with a correct one, just the same fallthrough any
unclassifiable text gets). In a session's own topic, unmatched text then forwards into the live PTY;
in the control topic there is no session to forward to, so it lands on the static help card instead.
Live-observed 2026-08-09: a Russian meta-question got the full static command-list card, not an answer.

## Decision: do NOT merge classification and dialogue into one call

Considered and rejected: relax the forced-schema constraint on the existing classifier call itself
(let it choose between emitting a fenced ```json block or plain prose in the same call). Verified live
that a `claude -p` call without `--json-schema` reliably picks the right mode when told to — but that
call is the *same one* that classifies `kill`/`rm`/`restart`/`deploy`, the four kinds `isDestructive`
gates. The whole point of forcing structured output on that call (`mapRouterOutput`'s doc comment:
"a `kind`... is a no-match rather than a best-effort guess") is that it can never return something
that isn't a real, schema-valid kind. Loosening that constraint to also allow free text weakens the
one call responsible for deciding whether to wake up a destructive fleet command, for a narrow win
(answering rare meta-questions). Not worth it.

## Chosen design: a second, isolated call, only on today's existing no-match path

1. `routeText`'s existing behavior is **unchanged** — same forced-schema call, same
   `RouterResult`/`mapRouterOutput` contract, zero risk to command classification.
2. `nl-dispatch.ts`'s `routeOrFallback` (`packages/bridge/src/nl-dispatch.ts:178-186`), in its existing
   no-match branch (currently lines 232-235, an unconditional `onNoMatch()`): when `!result.matched`
   **and** `ctx.isControl` is true (a value `routeOrFallback` already receives as a parameter — no
   caller-signature change needed), call a new function — before falling through to `onNoMatch()` —
   whose only job is to answer the question using a fixed grounding text: no command schema, no
   `kind`, no tool at all. This call cannot execute anything; its only output is a string sent back via
   `controlBot.sendMessage`. Inside a session's own topic (`ctx.isControl === false`), unmatched text
   already forwards to a real Claude turn with actual repo access, which answers better — this new path
   never fires there.
3. **Grounding-text source (resolved — see §5 for the alternatives considered):** a new exported
   function, `buildDialogueGroundingText()`, concatenates the existing `renderHelp()`
   (`packages/bridge/src/fleet-commands.ts:723`) and `renderAbout()`
   (`packages/bridge/src/about.ts:116`) output plus a short new architecture-blurb constant (Bridge/
   Channel-server/Hook-client split, why the control topic specifically has no session to forward to —
   this plan's own paraphrase of that behavior, not a verbatim quote of any existing doc). Lives in
   `about.ts`, the existing home for "friendly overview" text. `sendHelpCard`/`sendAboutCard`/
   `sendCommandsListCard` themselves (the Telegram-sending wrappers) live in `card-senders.ts`, not
   `fleet-commands.ts` — this plan reuses their underlying renderers, not the send-wrappers.
4. Explicit instruction in the new call's system prompt: answer only from the grounding text given;
   if the question is outside it, say so plainly and suggest asking inside a session (which has real
   repo access) — no invitation to speculate about undocumented internals.
5. **Backend: CLI only, unconditionally** (`claude -p`, no `--json-schema`) — this call always uses the
   CLI/subscription path regardless of the operator's current `/router api|cli` selection for the
   *classifier*; it is not "whichever backend `/router` is set to today," it is hardcoded, since the
   whole point is staying off the metered API backend for this specific call. Mirrors the existing
   classifier's `execFile` invocation shape (`nl-router.ts:516-535`) exactly: `cwd: os.tmpdir()`, the
   same `EXEC_TIMEOUT_MS` (45s) constant, and `--strict-mcp-config` (avoids the stray MCP
   channel-server auto-connect, same reason the classifier call needs it). On failure/error/timeout,
   logs `WARN` (matching `routeText`'s own convention on backend failures) and falls back to
   `onNoMatch()` exactly as today (same "fail open" contract every other router call already has) —
   never blocks or crashes on it.
6. **Cost, precisely stated:** confirmed live (2026-08-09) this reliably returns plain prose for a
   genuine question. Per `telegram-claude-session-control-plan.md` §10.5, `claude -p` (both the
   existing classifier call and this new one) bills against the shared non-interactive credit pool
   ($100/mo), not the interactive subscription seat — so this is **not** literally free, and it is
   **additive**, not a swap: an unmatched control-topic message today costs one classifier call
   (~3.5-5.4s, ~20-30k fixed tokens per §3.5); with this feature it costs that same classifier call
   *plus* this new call, each now also carrying the history-buffer context (§7), so per-unmatched-
   message cost/latency roughly doubles versus today's baseline. What this design does avoid is a
   *separately provisioned* Anthropic API key/metered spend — it stays inside the pool the classifier
   already draws from, just draws more from it on the (relatively rare) no-match path.

## Scope / non-goals

- Session topics: unchanged. Unmatched text there already forwards to a live Claude session, which
  already has its own full context (including every tool call it ran) natively - this history buffer
  is a control-topic-only concept and never applies there.
- The history buffer stores only plain text exchanges (operator message text -> the bot's own
  `sendMessage` reply text: help/about answers, command-result confirmations, NL-confirm outcomes,
  Q&A answers) - never feed-bot tool-activity narration (`om-aibridge-feed`'s "Grep/Read/Edit/Bash"
  step lines) and never permission-ask cards (`om-aibridge-control`'s "wants to run Bash" Allow/Deny
  prompts). Both of those are session-topic-only concepts anyway (only a PTY/session runs tools or
  needs permission), so they're structurally excluded, not just filtered - live-checked against real
  screenshots 2026-08-10 to confirm this distinction before implementation, not assumed.
- Destructive-command classification: unchanged, not touched by this plan at all.
- API backend: unchanged (still forced tool_choice, no dialogue mode).
- This is a Q&A/FAQ layer over fixed grounding text, not a general-purpose chatbot with repo access —
  deliberately, to avoid hallucinated answers about code the control topic has no access to. This
  mirrors an existing precedent in the main plan: `telegram-claude-session-control-plan.md` §11
  ("Deliberately not building") already rules out a control-topic or cross-repo variant of
  `/browse`/`/find` for the same reason — every other Bridge-native file access stays
  session-worktree-scoped, and this plan's Q&A layer keeps that boundary rather than reopening it.

## Open items before implementation

**Resolved this pass:**

- ~~Exact shape of the new return type carrying an optional answer back to `routeOrFallback`~~ —
  **decided: a separate function, `answerControlTopicQuestion(text, history, cfg, log): Promise<string
  | null>`**, called directly from `routeOrFallback`'s no-match branch (§3.2 above), not folded into
  `nl-router.ts`'s `RouterResult`/`RouterAction` union. Folding it in would break the existing invariant
  that `RouterResult`'s `matched: true` branch always yields a concrete, executable command — every
  current `RouterAction` variant is schema-derived; a free-prose answer string is structurally unlike
  all of them.
- ~~Where exactly the grounding-text builder lives~~ — **decided: `buildDialogueGroundingText()` in
  `about.ts`** (see §3.3 above).

**Still open at implementation time:**

- `NlDispatchOptions.nlRouterConfig` (`nl-dispatch.ts:33`) currently forwards only `{enabled, apiKey,
  model}` — a subset of the full `RouterConfig`. Adding `historyTurns` to `config.ts`'s `nlRouter` block
  does **not** automatically reach `routeOrFallback`; that pick-list in `nl-dispatch.ts` must be
  extended too, or the new setting silently never takes effect on this path. Flagging explicitly so
  implementation doesn't miss this second wiring point.
- Test plan: unit-test `buildDialogueGroundingText()` and the new CLI-output parsing (prose vs.
  accidental JSON-looking text) with a scripted/injected `claude -p` call, same pattern as
  `nl-router.test.ts`'s existing pure-function tests (`buildRouteViaCliArgs`) and `nl-dispatch.test.ts`'s
  fake-`routeText`-injection pattern — never mock `execFile` directly, matching existing practice
  (neither `routeViaCli` nor `routeViaApi` themselves have test coverage today, by design). See §8.

## Follow-up decision (same day): "make it feel like talking here" — considered and scoped down

The operator asked for the control topic to feel like a real back-and-forth conversation (remembering
prior turns, follow-ups landing naturally), and initially wanted commands themselves invokable through
that same conversational flow via tool-calling, the way this very chat works — not just a one-shot
FAQ answer.

**Why full agentic tool-calling was rejected for this:** a real host-controlled tool loop (model
requests a tool call → host executes/validates/confirms → feeds the result back → model continues)
is what `routeViaApi`'s `tool_choice` gives via the Anthropic Messages API - it is not something
`claude -p`'s one-shot headless invocation can do; there is no host-intercepted iterative loop there,
only a single prompt-in/text-out round trip per call. Faking a loop by re-issuing `claude -p --resume
<id>` calls with a textual description of "the result of restart was: ..." is possible but is
conversational simulation, not schema-validated tool-calling - it reintroduces exactly the
best-effort-guess risk on `kill`/`rm`/`restart`/`deploy` that the forced-schema classifier exists to
avoid. Real tool-calling fidelity requires the API backend, i.e. a separate Anthropic API key/metered
spend. Asked the operator directly: CLI-subscription-only (no new spend) vs. API-backend fidelity.
**Decision: CLI-subscription-only, no new spend.** Full agentic tool-calling over fleet commands is
therefore out of scope for now - revisit only if the operator later decides the API-backend cost is
worth it.

**What "natural conversation" means instead, within that constraint:**

- The forced-schema classifier call (`routeViaCli`) stays exactly as-is - unchanged, still the only
  thing that can produce a `kill`/`rm`/`restart`/`deploy`/etc. `kind`, still schema-validated per
  message. No tool-calling loop; each message is still classified independently.
- What changes is *context*: both the classifier call and the new free-text-answer call (previous
  section) get a short window of the control topic's recent message history (operator messages +
  bot replies, bounded - see §7) appended to the prompt as prior conversation, not just
  the single latest message in isolation. This is what makes follow-ups ("а что если...", "и как
  тогда...") read naturally without requiring the model to actually retain state itself between
  separate `claude -p` processes - the history is re-sent as plain context text each call, the same
  way `--resume` isn't used but the effect (continuity) is approximated.
- Net effect: commands still execute through the same safe, unchanged classifier path (just now
  aware of recent context, which can *disambiguate* a follow-up like "yes, do it" into the right
  `kind` - itself a plausible independent improvement); genuine questions get a grounded,
  context-aware prose answer via the second call. Neither call gains the ability to *chain* actions
  in one turn the way a real agent loop would (e.g. "list sessions, then kill the dead ones" still
  needs two round trips, one per command) - that limitation is the explicit price of staying off the
  API backend.
- Needs a small new piece of state: a bounded per-control-topic message history buffer (in-memory or
  SQLite-backed alongside the existing routing table) that both call sites read from - not designed
  yet, flagged here as a real open item, not hand-waved.

## Follow-up refinement (same day): history size, brevity, configurability

- **Default history window: last 4 operator/bot exchange pairs (8 messages)** - revised once more
  after web research (2026-08-10) into what window size dialogue systems actually use:
  - General chatbot "sweet spot" for cost/context balance lands at 6-10 messages, i.e. ~3-5 pairs
    (Vellum's LLM-memory guide); some production agents cap even tighter, ~4 exchanges/~800 tokens
    (dev.to "AI agents that actually remember").
  - Specific to *intent classification with context* (closer to what this router actually does than
    general chat is): a couple of preceding utterances is the useful signal, not a long transcript -
    arXiv 2411.06022's windows-based intent classification work observes people themselves resolve
    intent from "one or a few previous utterances," not a deep history.
  - Cost/accuracy tradeoff write-ups agree window size is a balancing act in both directions - too
    small loses context, too large both costs linearly more per call (no real caching benefit here,
    since this history is re-sent as plain text on every fresh `claude -p` invocation, not true
    session memory) and can dilute relevance with unrelated older exchanges (control-topic traffic is
    bursty and multi-session - "ls", "kill x", "restart", "ship y" in quick succession - so a wide
    window is more likely to drag in noise from an unrelated command than useful context for a
    follow-up).
  - Net: 2 (first proposed) is defensible but on the low edge for multi-step clarification; 10-20
    (an earlier, unresearched guess) sits past where research supports it for this specific
    terse/command-oriented use case. 3-4 pairs is the middle ground the general "sweet spot" and the
    intent-classification-specific finding both point to.
- Both prompts (classifier and the free-text-answer call) get an explicit brevity instruction - answer
  only what's asked, no restating the question, no preamble, no repeating the full command list unless
  actually asked for it. This cuts both output tokens and how much the *next* call's history costs,
  since the buffer stores the bot's own replies too.
- **Configurable history length** - a new setting (same place as `nlRouter.backend`/model in `config.ts`,
  e.g. `nlRouter.historyTurns`, default 3-4) so the operator can widen or shut off (`0`) the window
  without a code change. Exposed the same way other NL-router knobs already are (`/router` fleet
  command area, or a `settings.ts` field - exact surface TBD at implementation time, not designed
  here).
- Net effect on the buffer design above: bounded not just by "recent N turns" abstractly, but concretely
  by this configurable count, read fresh each call (no caching staleness concern - it's just the last N
  rows for that topic).

## Testing

TODO at implementation time (scenarios below are the required set; exact test file names follow
existing convention — `nl-router.test.ts`, `nl-dispatch.test.ts`, plus a new test file for any new
standalone module such as `about.test.ts` additions or a dedicated history-buffer test file):

1. **`buildDialogueGroundingText()` — happy path.** Returns a non-empty string containing both
   `renderHelp()`'s and `renderAbout()`'s content plus the architecture blurb. Unit test, pure function,
   `about.test.ts` (or wherever the new function lives) — no CLI/network involved. Proves §3.3.
2. **New CLI-call arg-builder — happy path.** Mirroring `buildRouteViaCliArgs`'s existing test
   (`nl-router.test.ts`), a pure function assembling the new call's `execFile` args must NOT include
   `--json-schema` and MUST include `--strict-mcp-config`. Unit test, `nl-router.test.ts`. Proves §3.5.
3. **`answerControlTopicQuestion` — CLI output parsing, prose case.** Given a stubbed `execFile`-shaped
   response whose `result` is plain prose, returns that prose unchanged. Unit test with an injected fake
   (same injection pattern as `nl-dispatch.test.ts`'s fake `routeText`) — never mock `execFile` itself.
   Proves the second-call contract in §3.2.
4. **`answerControlTopicQuestion` — malformed/empty output (edge case).** Given a stubbed response that
   is empty, whitespace-only, or accidentally JSON-shaped prose, returns `null` (not a garbled or
   half-parsed string) so the caller falls back to `onNoMatch()` cleanly. Unit test. Proves §3.5's
   fail-open contract.
5. **`answerControlTopicQuestion` — backend failure (error path).** Given a stubbed CLI failure/timeout
   (mirrors `routeViaCli`'s own `err` branch), logs `WARN` and returns `null`, never throws. Unit test.
   Proves §3.5's WARN-and-fail-open behavior.
6. **`routeOrFallback` — control-topic no-match invokes the new call.** With `ctx.isControl = true` and
   a `routeText` fake resolving `{matched: false}`, the injected `answerControlTopicQuestion` fake is
   called and its resolved string is sent via the fake `controlBot.sendMessage`, and `onNoMatch` is NOT
   called. Unit test, `nl-dispatch.test.ts`, same `setup()` pattern as existing tests. Proves §3.2.
7. **`routeOrFallback` — session-topic no-match is unaffected (edge case / regression guard).** With
   `ctx.isControl = false` (a session topic) and `routeText` resolving `{matched: false}`, the new
   Q&A function is NOT called and `onNoMatch()` fires exactly as today. Unit test. Proves the "session
   topics unchanged" non-goal in §4.
8. **History buffer — topic isolation (edge case).** Two different control-topic-adjacent contexts (in
   practice there is only one control topic per Bridge instance, but the buffer's read/write must still
   be keyed correctly) never mix entries from an unrelated read. Unit test on the buffer module directly.
9. **History buffer — `historyTurns = 0` disables the window (edge case).** With the configured count at
   `0`, both the classifier call and the Q&A call receive no history context appended. Unit test. Proves
   the "shut off without a code change" claim in §7.
10. **History buffer — bounded size (edge case).** Writing more than `historyTurns` pairs keeps only the
    most recent N pairs; older entries are dropped, not accumulated unbounded. Unit test.
11. **Config — `nlRouter.historyTurns` default and env override.** `config.ts`'s loader parses
    `NL_ROUTER_HISTORY_TURNS` with a default of 3-4 (final default TBD at implementation, see §5)
    matching the existing `NL_ROUTER_*` env-var pattern. Unit test, `config.test.ts` if it exists (or
    added if not). Proves §7's configurability claim.
12. **`NlDispatchOptions` wiring — `historyTurns` reaches `routeOrFallback` (regression guard for the
    §5 gap this pass found).** A test asserting `nlRouterConfig` as received inside `nl-dispatch.ts`
    actually carries `historyTurns` (not just `{enabled, apiKey, model}`) — this is the exact silent-
    wrong failure mode §5 flagged (config added but never threaded through).

**Test gate:** `bun test` (full suite) and `bun run typecheck` in `packages/bridge`, per CLAUDE.md's
`Commands` section — both must pass; no new gate introduced.

## Verification

Manual/operational checks once implemented, before considering this feature done (per CLAUDE.md's
"Live-verifying against the real Telegram client" — use `scripts/telegram-automation/`, do not assume
something "can't be checked without a real bot"):

1. Restart the Bridge (`bun run bridge:restart` / `scripts/dev-bridge.sh restart`) so the new code is
   live — per CLAUDE.md, the daemon only picks up changes on restart.
2. `scripts/telegram-automation/send-command.js "<a genuine meta-question, e.g. 'does /ship duplicate
   /deploy?'>"` in the control topic — confirm a real, grounded prose answer comes back, not the static
   help card.
3. `scripts/telegram-automation/send-command.js` a follow-up referencing the prior answer without
   repeating context (e.g. "а если конфликт?") — confirm the reply stays on-topic, proving the history
   buffer is actually being read.
4. `scripts/telegram-automation/send-command.js` a genuine destructive command (e.g. "restart the
   bridge") in the same control topic right after the above exchange — confirm it still produces the
   normal `/restart` NL-confirm card, unaffected by the Q&A path (regression check for §2's core
   safety decision).
5. `scripts/telegram-automation/send-to-topic.js` (a session's own topic, not control) with an
   unrecognized/off-topic message — confirm it still forwards into the session's PTY as before, and the
   new Q&A path never fires there (regression check for the §4 non-goal).
6. Set `NL_ROUTER_HISTORY_TURNS=0`, restart, repeat step 3 — confirm the follow-up no longer has context
   (falls back to a generic/clarifying answer), proving the disable switch works end-to-end.

## Known limitation (live-verified 2026-08-10)

Implemented per §3/§8, then live-verified against the real Telegram client (`scripts/telegram-
automation/`) rather than assumed. Both core safety properties held: a genuine meta-question
("does /ship duplicate /deploy?") that fell through to the classifier's no-match path got a real,
grounded prose answer via the new Q&A call, and a destructive NL command ("restart the bridge
please") still produced the ordinary unchanged confirm card — the new path never touched that gate.

**But** the live check also surfaced a real, pre-existing gap this plan doesn't fix: the *classifier*
itself (`nl-router.ts`'s `routeText`, completely unchanged by this plan) sometimes reads a question
that merely *names* real commands as a request to *see* those commands, i.e. `kind='help'` — per its
own system prompt (`SYSTEM_INSTRUCTIONS_BASE`: "A request to see what commands exist... is
kind='help'"). Live-observed: "does /ship duplicate /deploy?" was classified `matched: true,
kind='help'` and got the static command-list card immediately — it never reached this plan's Q&A
path at all, because that path only ever runs on `!result.matched`. The correct grounded answer to
that exact question only appeared because a *later*, unrelated message (a garbled `/ls` invocation
that genuinely had no command match) fell through to the Q&A call, which then answered from the
*history buffer's* record of the earlier question rather than the current message's own text —
functionally useful in this instance, but a coincidence of timing, not a property this plan
guarantees.

**Net effect:** this plan's Q&A path is real and works exactly as designed on the no-match path it
owns — it does not, and cannot, override how the classifier decides `matched`/`kind='help'` upstream
of it. How often a genuine meta-question actually reaches this new path depends on classifier
phrasing-sensitivity that predates this plan and is out of its scope. A follow-up worth considering
separately (not part of this plan, not implemented here): narrowing `SYSTEM_INSTRUCTIONS_BASE`'s
`kind='help'` trigger so a question *naming* a command to ask how it behaves reads differently from a
request to *list* commands — deliberately left as a follow-up rather than folded into this plan, since
it would change the classifier's own long-standing, separately-tested behavior rather than only add
the new isolated call this plan set out to add.

**Resolved (2026-08-10):** the follow-up above was implemented. `SYSTEM_INSTRUCTIONS_BASE`
(`nl-router.ts`) now carves out an explicit exception: a question that already names one or more
specific commands and asks something *about* them (how they differ, whether one duplicates another,
what a specific one does) is excluded from `kind='help'`/`'about'` even though it mentions commands,
and falls through to `kind='forward'` (→ `matched:false` → this plan's Q&A path) instead. `'help'`/
`'about'` are now reserved for a genuine request to see the list of commands or a general intro, with
no specific command already named as the question's subject. Covered by a new
`buildSystemInstructions` prompt-text assertion in `nl-router.test.ts`; `bun test`
(1337 pass) and `bun run typecheck` both clean. Not re-verified live against the real classifier call
(that would require a real Anthropic API round-trip or `claude -p` invocation per case) — the fix is
a prompt-wording change to an existing, separately-tested classifier path, not new code, so unit-level
coverage of the prompt text was judged sufficient here.

**A second, narrower instance of the same gap (live-observed 2026-08-11):** the 2026-08-10 carve-out
above only excludes a question that names a specific *slash command*. A control-topic message reading
"If i will use word 'branch' instead of session will you understand that need to create new session
with new command?" names no exact command at all — it's a hypothetical/meta question about the
classifier's own synonym tolerance, using generic words ("session", "new session", "new command")
that happen to overlap the schema's own vocabulary for `kind='new'` — and was still classified
`kind='help'`, producing the same "got the static command list instead of a real answer" failure mode
on a message the 2026-08-10 fix doesn't reach. **Resolved (2026-08-11):**
`SYSTEM_INSTRUCTIONS_BASE` now carves this out too: a hypothetical/meta question about how the bot
itself would interpret different wording (a synonym or alternate phrasing) is excluded from
`kind='help'`/`'about'` even when it names no exact command, and falls through to `kind='forward'`
the same way. Covered by a new `buildSystemInstructions` prompt-text assertion in `nl-router.test.ts`;
`bun test` (1543 pass) and `bun run typecheck` both clean. Same "prompt-wording change to an existing,
separately-tested path" reasoning as the first fix — not re-verified live against a real classifier
call for the same reason.
