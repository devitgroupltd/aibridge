---
version: 0.17.0
status: solid
last_modified_utc: 2026-08-03T12:33:15Z
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
  - "0.17.0 (2026-08-03): Phase 2 (permission relay) implemented and live-verified end to end - the
    plan's one open risk here (§3.1/§6.3's claude/channel/permission capability, never
    live-verified before now, unlike every other keystroke/protocol primitive this plan already
    measured) is resolved in favour of the design as written, not a guess: a throwaway spike
    handler in channel-server logged a real notifications/claude/channel/permission_request for a
    genuine Write call under manual mode, matching §6.3's worked example field-for-field
    (request_id/tool_name/description/input_preview, nothing more, nothing less), and an
    auto-allow verdict sent back closed the local terminal dialog with no keystroke - proving both
    halves of the round trip before any real implementation was written on top of it. Built:
    settings.ts (§6.2's baseline, generated fresh per launch, wired into session-launcher.ts's
    --settings flag), rule-derivation.ts (§6.6's Always-rule derivation with the metacharacter
    guard), permission-registry.ts (pending-request tracking with 30-minute expiry, no
    persistence - a restart still loses pending prompts per §4.5/§6.5), permission-callback.ts
    (the perm:<id>:<a|d|A> callback_data scheme and card renderer), and the channel-server/pipe-server/
    index.ts wiring connecting all of it. Verified live a second time end to end against the real
    Telegram group (not just the stub): a real Write permission card was tapped Allow from the
    operator's actual phone, and the resulting git commit ask-prompt was tapped Allow too, landing
    a real commit - confirming both the relay itself and that the generated ask-list settings
    genuinely gate git commit on a live session, not just in a unit test. §9 scenarios 4-13 and 30
    covered by new unit/integration tests (131 tests passing across all packages, tsc clean).
    Phase 2 is complete"
  - "0.16.0 (2026-08-03): Added /restart, a gap noticed live: the fleet's own session, after
    implementing a feature to the Bridge, said unprompted 'this needs a Bridge restart to take
    effect - I can't hot-reload the process I'm running under', and there was no way to trigger that
    from Telegram. Mechanism is a self-respawn (spawn a detached successor with the running
    process's own process.argv, then exit) rather than an external supervisor - deliberately not a
    new code path, just an operator-triggered instance of the exact restart event §4.5/scenario 37
    already measures and reconciles. Stated plainly rather than glossed: because Phase 1 has no
    persisted session_id for the successor to pass to claude --resume, /restart today kills every
    live session and relaunches fresh, losing conversation history, not resuming it - the same
    cold-start cost §4.5 already flags for the supervisor's own automatic restarts. Non-destructive
    only once Phase 5's session-id persistence lands, so /restart is scoped to Phase 5, not
    backported to Phase 1 despite being noticed there. New §4.5.1, a fleet-scoped (not
    session-scoped) command row in §4.2, test scenario 44, and a Phase 5 bullet. Not implemented in
    code - design only, pending Phase 5's routing table"
  - "0.15.1 (2026-08-03): §4.2.2's cycle order is now VERIFIED, not inferred. Sent the raw \\x1b[Z
    (Shift+Tab) keystroke four times against the live Phase 1 session via the dev-control port,
    reading the resulting mode label off the status line after each press: manual -> 'accept edits
    on' -> 'plan mode on' -> 'auto mode on' -> back to 'manual mode on'. Confirms the exact order
    0.15.0 assumed from the picker's listed order, with no surprises - the fourth press wrapping
    cleanly back to manual also confirms the cycle length used by buildModeKeystrokes's modulo
    arithmetic. Promotes /mode from 'needs live confirmation before it ships' to ready for Phase 5"
  - "0.15.0 (2026-08-03): Added /mode <name>, the permission-mode counterpart to 0.14.0's /model. The
    picker (Manual/Edit automatically/Plan/Auto) has no typed slash command - it is reached only by
    Shift+Tab cycling at the prompt, already named in §10.0 as one of three keystroke primitives proven
    live during the 2026-08-02/03 sitting. Reuses /model's raw-PTY-write mechanism (§4.2.1) but adds a
    problem /model didn't have: Shift+Tab is relative ('next'), not absolute, so reaching a target mode
    means knowing the current one and writing the right number of presses, with no ack over the
    protocol to confirm it landed. Mitigated by tracking mode per session in the routing table, seeded
    from manual (Phase 1's spawn default, confirmed live) and updated optimistically after each write -
    with the honest caveat that manual cycling at the desk between remote commands drifts this state
    with nothing to detect it. The cycle order (manual -> acceptEdits -> plan -> auto) is inferred from
    the picker's own listed order and flagged as needing the same live confirmation the other two
    keystroke primitives already got, not shipped as a plan-time assumption. New §4.2.2, test scenario
    43, and a Phase 5 bullet next to /model's"
  - "0.14.0 (2026-08-03): Added /model <name>, a gap noticed live: /new --opus|--haiku fixes a
    session's model at launch (§4.2) but nothing let an operator change it mid-conversation once a
    turn was already burning the wrong tier's tokens. Cannot be a /cmd-style shim - /model is a
    CLI-native slash command with no backing markdown file, so wrapping it in a <channel> tag the
    way ordinary inbound text is wrapped would just hand Claude a literal string, never reaching the
    TUI's own command parser. Resolved by generalising §10.1's dev-control port (today a manual,
    loopback-HTTP-only escape hatch for the dev-channels dialog) into a real feature: the Bridge
    writes the raw keystroke '/model <name>\\r' straight to the session's PTY, bypassing
    renderChannelTag entirely - exactly what an operator's own fingers would type at the terminal.
    Since a model switch fires no hook and makes no reply call, the channel cannot observe it landed,
    so the Bridge posts its own confirmation immediately after the write rather than waiting for an
    ack that will never arrive. New §4.2.1, test scenario 42, and a Phase 5 bullet alongside the
    per-session model routing it extends"
  - "0.13.0 (2026-08-03): Post-Phase-1 addition, not part of the original scenario list: an
    operator-visible 'Claude is working' signal for the gap between an inbound message landing and
    the reply tool call being confirmed (§9's reply-permission ask rule alone left that gap silent).
    First attempt was Telegram's native sendChatAction typing status; live testing surfaced a real
    Telegram Desktop client bug (tdesktop#30452) where the indicator only renders in the topics
    overview list, not inside the open topic the operator is actually watching - confirmed via a
    direct sendChatAction call returning ok:true while nothing appeared in the open topic. Fixed by
    adding a second, independent mechanism (thinking-placeholder.ts): a real '(thinking emoji)
    Thinking...' message sent when a turn starts and edited in place into the reply text once it
    lands via editMessageText, rather than a second message - real messages render identically on
    every client. Both mechanisms are kept side by side (typing-indicator.ts for mobile, the
    placeholder for desktop) since neither costs anything the other doesn't already pay. Also fixed
    the typing indicator's own maxTicks safety cap, originally 24 ticks (96s), which was expiring
    well before turns that took several minutes - raised to 450 (30 min), backstopped by the reply's
    onReplySent as the real stop signal. Proven live end to end against the real Telegram group:
    placeholder message appears, gets edited into the actual reply with no duplicate message, typing
    indicator confirmed visible on both mobile and (once the placeholder message existed in the
    topic) desktop. 35 tests and tsc --noEmit stayed green throughout"
  - "0.12.0 (2026-08-03): PHASE 1 COMPLETE. Scenario 37 measured: killing the Bridge process alone
    (Stop-Process, not a tree-kill) took the live claude.exe and its channel-server child down with
    it - zero survivors. This collapses §4.5's reconciliation table's 'process alive' row to never
    occurring in practice on this stack, makes claude --resume on a fresh PTY the only recovery path
    (not one of several), and promotes the Job Object opt-out fallback from a contingency to a
    concrete Phase 5 candidate. Both Phase 1 exit items (scenario 29, scenario 37) are now done"
  - "0.11.0 (2026-08-03): Stage 7 manual verification findings. HIGH: notifications/claude/channel
    confirmed broken upstream and independent of channelsEnabled - server.getClientCapabilities()
    returns undefined in this exact config, matching the consolidated tracker
    anthropics/claude-code#36431; §10.0's 'RESOLVED' framing is superseded (not deleted) by new §10.1.2,
    which surveys community workarounds (all of which inject via tmux/PTY keystrokes rather than the
    channel-notification path) and records the decision to switch Phase 1 inbound delivery to direct
    PTY text injection while keeping the reply MCP tool for outbound. HIGH: corrected two false §2.4
    claims found while diagnosing this live - registering the channel in ~/.claude.json alone does not
    make --dangerously-load-development-channels resolve it (needs .mcp.json, which reintroduces the
    per-/new consent dialog v0.10.0 thought it had avoided), and a registered MCP server's env does not
    inherit from the ptyEnv() passed to the outer claude.exe process (AIBRIDGE_SLUG/AIBRIDGE_TOPIC must
    be set directly on the server's own env key). MEDIUM: a bare `command: \"bun\"` in an MCP server
    registration doesn't resolve for the same reason a bare `claude` didn't (§2.4 correction 4) -
    resolve bun.exe's absolute path the same way. Same day, same session: the §10.1.2 PTY-injection
    workaround was actually implemented (protocol renderChannelTag, Routing.setPtyWrite, index.ts
    wiring) and PROVEN LIVE end to end against the real Telegram group - closing Stage 7's scenario 29.
    One more live-only finding folded in: a single .write() carrying the tag text plus a trailing \\r
    left it unsubmitted (bracketed-paste handling swallowing the embedded Enter); sending \\r as a
    separate write fixed it. 43 tests and tsc --noEmit stayed green throughout"
  - "0.10.0 (2026-08-02): Pass 2 review - HIGH: guard-git-write.ps1 was renumbered by an unrelated
    concurrent edit to SeoWrite (Layer 3 -> Layer 6 for the auto-allow, Layers 1/2 -> Layers 3/4 for
    the protected-branch/--no-verify hard blocks); rewrote all four live cross-references (§6.1.1,
    §7.3) to name the layers by function with the current numbers kept only as a dated snapshot, so
    the plan survives the hook being renumbered again. MEDIUM: added scenarios 40-41 proving the
    sessions.state transition table and the non-429 retry/backoff policy added in pass 1, neither of
    which had a test scenario. MEDIUM: gave the §8.2 pairing bootstrap code an explicit charset and a
    10-minute single-use expiry, matching the rigor already given to the permission request_id.
    MEDIUM: P-2 now validates both bot tokens with a getMe call at startup rather than surfacing a bad
    token for the first time inside a live sendMessage. LOW: clarified that the §5.7 query_source
    attribute distinguishes request origin (main/subagent/auxiliary), not billing pool, so it is
    never the mechanism for verifying §10.5's subscription-vs-credit-pool split"
  - "0.9.0 (2026-08-02): Pass 1 review - HIGH: corrected Telegram's bot file-download limit from 50MB
    to the actual documented 20MB (§5.6). HIGH: added a retry/backoff policy for non-429 Telegram API
    failures, so a failed P0 permission-prompt send is never silently assumed delivered (§5.4).
    MEDIUM: added the six v{semver}_touched_sections blocks missing since 0.2.0 (v020, v070, v071,
    v072, v073, v080), reconstructed from their own changelog entries. MEDIUM: softened the
    channelsEnabled 'no error anywhere' claim now that current docs describe a startup-time admin
    banner (§4.1). MEDIUM: P-1 now names the Bun-specific node-pty NAN-vs-NAPI ABI loading risk
    separately from the build-toolchain risk (§12). MEDIUM: removed the speculative Transport
    interface claim in favour of a plain Telegram module until a second transport exists (§11,
    YAGNI). MEDIUM: added aibridge's own ERROR/WARN/INFO logging convention for the Bridge's
    operational log (§9). MEDIUM: added an exhaustive sessions.state transition table, including the
    dead-topic-message edge case (§4.3). LOW: Phase 6a's exit criterion now cites scenarios 24 and 37
    like every other phase (§12)"
  - "0.8.0 (2026-08-02): EXTRACTED into its own repo, github.com/devitgroupltd/aibridge, so the same
    Bridge can drive sessions across any number of registered projects rather than living inside
    SeoWrite's plans/ folder. Renamed swtg -> aibridge throughout (env vars, socket/pipe paths, the
    MCP server and reply-tool names, the plugin name). Added decision 5 to the Overview's decisions
    table: ship as a standalone repo, project identity is a `repos.toml` lookup, not code. §4.1.1 reframed from
    'this repo's second developer' to the general one-operator-one-instance rule, with the SeoWrite/
    Devitgroup two-developer case kept as a labelled worked example rather than the default framing.
    §6.1.1 and §7.3 reframed: SeoWrite's `guard-git-write.ps1` is now explicitly a worked example from
    the pilot project, not aibridge's own file - aibridge touches no file in any target repo. §9
    scenario 13 and the §7.6 bash-port item reframed as a target-repo's own testing/porting
    responsibility. §7.1's repo registry example extended to show two registered projects. Frontmatter
    `relates_to` rewritten since the SeoWrite-local companion plans and CLAUDE.md this plan pointed to
    do not exist in this repo"
  - "0.7.3 (2026-08-02): §4.1.1 refined with three facts confirmed by the Owner, closing gaps before
    the second developer starts: (1) channelsEnabled is confirmed NOT per-developer - the second
    developer is in the same Devitgroup Ltd org the Owner already enabled it on, so their instance
    inherits it satisfied, and the plan now states the general case too (an unaffiliated account
    would never be gated by it at all, since the docs scope it to Team/Enterprise). Corrects the
    prior '0.7.2 all three prerequisites are per-developer' framing to 'two of three'. (2) §10.5's
    weighted-concurrency cap and burn-rate threshold are flagged as Max-5x-specific arithmetic, not
    a policy - the second developer is confirmed on a Standard, non-Premium tier, so they need their
    own pass through §10.5's method before their own Phase 5, not the Owner's figures. (3) The P-4
    protocol probe's findings are properties of the Claude Code client version, not the machine, so
    a second developer on the same pinned version does not need to re-run the sitting harness, only
    the per-machine actions it surfaced"
  - "0.7.2 (2026-08-02): NEW §4.1.1 - this repo has a second developer who may also want Telegram
    control, so the plan now says explicitly what was previously only implicit: each developer runs
    a fully independent instance (own machine, own clone, own supergroup, own bot tokens), not a
    shared Bridge. Direct consequence of §8.1's threat model, which is scoped to one machine on
    purpose - routing a second person through the existing sender allowlist would still mean their
    tool calls execute on the first developer's machine, which is a bigger blast radius than §8.2/
    §8.3 were built to carry. Also records why the §4.1 setup steps cannot be scripted with the
    Bot API (bots cannot create groups, cannot enable Topics, cannot self-promote to admin, and bot
    tokens only come from @BotFather's conversation, not an endpoint) and that a real user account
    over MTProto could do all of it but is not worth the standing credential for a one-time step"
  - "0.7.1 (2026-08-02): CORRECTION to §10.1's escape from the dev flag, found while checking whether
    the admin console's \"choose which servers to trust\" copy implied an undocumented per-server trust
    dialog (it does not - confirmed against the published channels docs, no such dialog exists beyond
    the ones already in §2.4). The docs show the escape from
    --dangerously-load-development-channels is self-service via the org's own allowedChannelPlugins in
    managed settings, not a wait on Anthropic admitting the plugin to a public allowlist as previously
    written. Same admin console and Owner role that already controls channelsEnabled. Also notes an
    empty allowedChannelPlugins array blocks the ordinary allowlist but not the dev flag; only an unset
    channelsEnabled blocks both"
  - "0.7.0 (2026-08-02): THE GO/NO-GO PASSED. The interactive sitting ran and P-4 is closed. Item 1c VERIFIED: all 20 pushed events reached Claude's context, in the initial context, injected mid-turn while Claude was working, and in the user-turn slot; Claude acted on the first event with no user turn at all. The two prior failures were NOT a protocol fault - channelsEnabled was unset on the claude.ai Team org, which blocks all channels including the development flag and drops events silently with no error to the server. The Owner enabled it mid-sitting and the same running session started delivering, which is now §10.1.1: a managed org switch we do not control, off by default, silent on failure, live on revocation, with a startup nonce probe and a periodic re-probe as the mitigation. §10.0 rewritten from a failure record to a proof record. Item 4 answered by demolition: the PermissionRequest hook carries NO tool_use_id, permission_rule_id or permission_rule_text (all three were assumed), and shares no field with the relay's request_id, so §6.5 stops joining and renders the approval card from the channel payload alone, whose input_preview proved complete and untruncated; resolution detection falls back to (session_id, tool_name, deep-equal tool_input) and permission_suggestions becomes the basis for §6.6 Always. Item 5 VERIFIED interactively. Items 1b and 2 moot - neither dialog fired on a virgin directory. NEW BLOCKER: first-run onboarding (theme picker, fullscreen-renderer offer) precedes every banner and would deadlock an unattended launch on a blank screen, so §2.4's dialog table goes from three to five and the onboarding keys become a hard prerequisite. Also: source is reserved and must never appear in meta (§3.2), a reply is not a per-event acknowledgement so the liveness warning must key on hook activity (§3.2), MCP tool calls raise their own permission dialog so mcp__aibridge__reply joins the §6.2 baseline, and ~/.claude.json holds duplicate drive-letter-case project entries so every path key must be canonicalised (§2.4, §4.3)"
  - "0.6.0 (2026-08-02): HOST DECISION REVERSED, and the first failed probe. Decision 1 changes from WSL2 to native Windows for Phases 1-5, with WSL2 held as the Phase 6b migration (§7 rewritten, §7.6 added as a checklist). Rationale: the ONLY Windows-unavailable capability is the OS sandbox; against that, Windows removes a reboot and a from-scratch WSL install (the features are all Disabled on this machine today), the /mnt/c boundary, the second clone, and the guard-hook bash port. P-3 is therefore DELETED and the plan now touches no existing repo code. Costs recorded honestly, not glossed: no OS-enforced secret containment until 6b (§10.4.1, §13 check 7 expected to fail), and tmux is gone so re-adoption after a Bridge restart is partial (§2.3, §4.5). tmux is replaced by node-pty/ConPTY, which is cross-platform and so survives the migration; the unix socket becomes a named pipe (§2.5). PROBES RUN against pinned 2.1.220: --dangerously-load-development-channels and --channels both VERIFIED to exist (hidden from --help, recognised by the parser); a hand-rolled channel server VERIFIED to load and connect with the experimental capability accepted; but inbound notifications/claude/channel events did NOT reach Claude's context in 8 attempts across 2 turns, with no error returned. That is now §10.0, ranked above research-preview churn, and Phase 1.0 becomes a go/no-go interactive sitting covering all four items that cannot be probed headlessly"
  - "0.5.0 (2026-08-02): Pass 4 - remaining open questions closed. NEW LIMITATION FOUND: EnterPlanMode and ExitPlanMode are disabled outright in any session with a channel configured (issue #41787, closed as not planned), so Telegram sessions have no plan mode at all; recorded as §10.6 with the workflow split it forces. Probed the AskUserQuestion hook and got an informative negative - the tool does not exist in -p at all, so P-4.5 needs an interactive probe, which independently re-confirms §5.2. Slash commands cannot cross the channel boundary, so added a Bridge command shim (§4.2). Specified the socket protocol and reconnect (§2.5). Softened sandbox strict mode to a gated escape hatch via the documented Bash(dangerouslyDisableSandbox:true) ask rule (§6.7). Added inbound attachments (§5.6), compaction feed lines, and the WSL2 repo-registry/credentials prerequisites (§7.5)"
  - "0.4.1 (2026-08-02): Owner reversed the model default from Opus to Sonnet, with /new --opus to upgrade. Quota no longer binds before the rate budget, so the concurrency cap returns to 4 and becomes weighted (Opus 2 units, Sonnet 1, Haiku 0.5) rather than a flat session count (§2.4, §4.2, §10.5)"
  - "0.4.0 (2026-08-02): Pass 3 - the two remaining flags resolved rather than deferred. §6.1.1's ask-rule precedence is now VERIFIED EMPIRICALLY on this machine by a control/treatment probe, not merely quoted from the docs, which retires P-4 item 3 (§6.1.1, scenario 31). Usage/cost moves from an accepted risk to a built mechanism: the Bridge ingests Claude Code's OpenTelemetry metrics on a local OTLP endpoint, keyed by session.id, giving per-session live token and cost figures in /ls (§5.6). Owner is on Max 5x with Opus as the /new default, so concurrency drops to 3 and the burn-rate alarm becomes load-bearing rather than advisory (§10.5). Added per-session model routing (§2.4, §4.2)"
  - "0.3.0 (2026-08-02): Pass 2 - open questions and risks investigated against the docs and closed. CORRECTION: v0.2.0's central finding was wrong. A PreToolUse hook returning `allow` does NOT pre-empt the permission system; the docs state deny and ask rules are evaluated regardless of hook output. The fix is an `ask` rule in the generated per-session settings, so guard-git-write.ps1 needs no change and the AIBRIDGE_SESSION gate is withdrawn (§6.1.1). Adopted the OS-level Bash sandbox, which works on WSL2 and inverts the allowlist strategy (§6.7). Replaced the 540s AskUserQuestion auto-answer with the documented per-hook `timeout` field and the official updatedInput/answers shape (§6.4). Added a non-blocking PermissionRequest observer hook, which makes prompt reconciliation exact instead of heuristic (§6.5). Second bot token for feed traffic: Telegram limits are per bot, so P2 gets its own 20/min (§5.4). Launch dialogs are three, not one, and two are avoidable via user-level config (§2.4, §10.1). Added the usage/cost risk (§10.5). §9 grew to 30 scenarios"
  - "0.2.0 (2026-08-02): Pass 1 review - CRITICAL: guard-git-write.ps1 Layer 3 now auto-allows commit/push, which pre-empts the channel relay and would let a phone commit unapproved; added the AIBRIDGE_SESSION escalation gate (§6.1.1) and moved P-3 to a Phase 2 blocker. CRITICAL: editMessageText shares the sendMessage rate budget, so fixed 3s coalescing overruns the 20/min group limit at 2+ sessions; replaced with session-count-scaled intervals and a 12/min P2 reservation (§5.4). Expanded the bash-port parity requirements and pinned both implementations to test_claude_hook_guards (§7.3, scenarios 11-12). Renumbered §9 to 24 contiguous scenarios and corrected every cross-reference"
  - "0.1.0 (2026-08-02): Initial plan - Telegram-driven multi-session Claude Code control via a custom MCP channel server, hook-fed activity feed and inline-button permission relay, hosted on WSL2"
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
| `/new [--opus\|--haiku] <repo> <prompt>` | Create worktree, create topic, launch session, send prompt as first message. Sonnet unless overridden |
| `/ls` | List live sessions: slug, state, worktree, branch, age, last activity, model, session cost and tokens (§5.7) |
| `/budget` | Rolling 5-hour spend across the fleet, per-session breakdown, and the cap (§10.5) |
| `/kill <slug>` | SIGTERM the session, close the topic, leave the worktree in place |
| `/rm <slug>` | As `/kill`, plus remove the worktree and delete the topic |
| `/attach <slug>` | Post the tail of the session's PTY ring buffer, plus the `claude --resume <session_id>` command for local pickup (§2.3) |
| `/cmd <name> [args]` | Run a repo slash command by proxy. See below: this is a shim, not a passthrough |
| `/model <sonnet\|opus\|haiku\|fable>` | Switch the current session's model live, mid-conversation. Session-scoped only, same convention as a bare `/kill` (§4.2.1) |
| `/mode <manual\|acceptEdits\|plan\|auto>` | Switch the current session's permission mode live. Session-scoped only, same convention as a bare `/kill` (§4.2.2) |
| `/pause <slug>` | Stop pushing feed updates for that topic (replies and prompts still flow) |
| `/restart` | Fleet-scoped, control topic only. Self-respawns the Bridge process to pick up a code change. Kills every live session with it (§4.5); Phase 5 scope, see §4.5.1 |

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
words, truncated to Telegram's 128-char topic-name cap). When the session first calls `reply`, or when
a `SessionStart` hook reports a `sessionTitle`, the Bridge issues `editForumTopic` once to upgrade the
name. Renaming is capped at one per session to avoid burning rate-limit budget on cosmetics.

### 4.5 Restart recovery and orphan reconciliation

On Bridge start, reconcile three sources of truth that can disagree: the SQLite table, the live
processes (by `pty_pid`, verified by image name so a recycled pid is not mistaken for a session), and
the Telegram topic list.

| Situation | Action |
|---|---|
| Row exists, process alive | Re-adopt. Post "bridge restarted, session still running" to the topic. **The PTY handle is gone even though the process is not** - see below |
| Row exists, process gone | Attempt `claude --resume <session_id>` on a fresh PTY. On failure, mark `dead` and post a notice with the worktree path so work is not lost |
| Row exists, topic deleted in Telegram | Mark `dead`, terminate the process, leave the worktree. Log |
| Process alive, no row | Orphan from a crashed Bridge mid-`/new`. Adopt into a fresh topic |
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

**The honest Phase 1 caveat, stated plainly rather than glossed:** §4.5's measurement means `/restart`
kills every live session along with the Bridge, and Phase 1 has no persisted `session_id` (that is
Phase 5's SQLite routing table, §12) for the successor to pass to `claude --resume`. So today, `/restart`
does not hot-reload a session's *conversation* - it relaunches fresh, and whatever was mid-turn is gone,
not resumed. This is the same "cold-start cost on every restart" tradeoff §4.5 already flags for the
supervisor's own automatic restarts; `/restart` just makes the operator able to pay that cost
deliberately, on their own schedule, instead of only when something crashes. It becomes non-destructive
once Phase 5's session-id persistence lands, and not before - **`/restart` is therefore Phase 5 scope**,
not a Phase 1 retrofit, same as the supervisor duty it's a manual trigger for.

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
screenshot. Photos and documents sent to a session topic are downloaded by the Bridge into
`$STATE/sessions/<slug>/inbox/` and announced as an ordinary channel message naming the path:

> operator sent an image: `/home/…/inbox/2026-08-02-141233-screenshot.png`

Claude then reads it with the normal file tools, which is the whole trick: no protocol extension is
needed, because a path in context is enough. The official Telegram plugin uses the same inbox pattern
and caps at Telegram's 20MB bot-download limit; we inherit both. The inbox sits inside the session
state directory rather than the worktree, so nothing accidentally gets committed.

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

**The one honest gap: this starts at logon, not at boot.** After a reboot the machine must reach a
logged-in desktop session before the bot answers. The alternatives are worse than the gap: *Run whether
user is logged on or not* puts the task in session 0, where ConPTY behaviour is not something this plan
should assume and where the Claude Code credential store in the user profile may not resolve. Options,
in order: accept it and reboot deliberately; or enable autologon with the workstation locked
immediately afterwards. **Verification item, not a design decision** - §13 check 1 measures it.

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
| **Secrets** | Both bot tokens in `~/.config/aibridge/.env`, mode `0600`, never in a worktree, never in any target repo. `Read(.env)` and the ssh/aws paths are denied so a session cannot read credentials and hand them to Claude, which would put them in a transcript |
| **Secrets, actually enforced** | The row above is necessary and insufficient. Read and Edit deny rules cover Claude's file tools and the Bash file commands Claude Code recognises (`cat`, `head`, `tail`, `sed`); they explicitly do **not** cover an arbitrary subprocess that opens the file itself, so a three-line Python script walks past them. `sandbox.credentials.files` (§6.7) is the kernel-enforced version and is the control that actually holds. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips Anthropic and cloud credentials from every subprocess regardless of sandboxing, and is set for all sessions |
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
    Phase 1 exit criterion.
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
    `$STATE\sessions\<slug>\inbox\`. Unit, table-driven over hostile filenames.
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
- Still open, not yet done: (a) the "New MCP server found" consent dialog `.mcp.json` registration
  (the §2.4 correction above) now raises on every `/new` needs the same treatment correction 3 already
  gives the dev-channels warning - i.e. it's Phase 5 supervisor work, not a new Phase 1 gap, and today
  it was answered by hand through the dev control server exactly like the existing dev-channels
  keystroke. (b) the §9 test scenario list needs a scenario for "inbound delivered via PTY injection,
  not notification" replacing the assumption baked into the existing scenario 29 language. (c) file our
  own comment on #36431 with this plan's specific repro (`getClientCapabilities()` returning `undefined`
  for a raw `server:` dev-flag registration, not just marketplace plugins) - the existing thread's
  evidence table is missing this exact configuration.

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
  (`rule-derivation.ts`). One open question flagged rather than solved: whether a running session
  hot-reloads its `--settings` file mid-conversation, so an `Always` tap's derived rule is
  confirmed *written*, not confirmed *effective on the very next matching call* - unverified.
- **Exit:** scenario 30 passes (automated, and live-verified twice against the real Telegram group -
  a Write card and the resulting `git commit` ask-card, both tapped from the operator's actual
  phone, the second one landing a real commit), plus scenarios 4-13. **Phase 2 is complete.**

### Phase 3 - activity feed

- Compiled hook client; hook registration in the generated settings.
- Turn card renderer; per-topic coalescing; the two-token priority governor; `details` button.
- **The prompts-per-hour metric**, promoted here from Phase 6. On a host with no sandbox it is the only
  instrument that says whether the allowlist has grown too broad (§10.4.1).
- **Exit:** scenarios 14-21 pass, and a real tool-heavy turn stays inside the rate budget with two
  sessions running.

### Phase 4 - questions

- `AskUserQuestion` blocking `PreToolUse` hook; option keyboards; `updatedInput`/`answers` return.
- The per-hook `timeout` and the cancel-on-timeout path (§6.4).
- **Exit:** scenarios 22 and 23 pass, and a real `AskUserQuestion` is answered from the phone.

### Phase 5 - the fleet

- `/new`, `/ls`, `/kill`, `/rm`, `/attach`, `/pause`.
- Topic lifecycle including create, rename-once and delete.
- Worktree provisioning per session; the SQLite routing table.
- The supervisor: launch, health, restart, and the dev-flag confirm keystroke.
- Package as a plugin so the allowlist path stays open (§10.1).
- The OTLP listener and telemetry ingest (§5.7); `/ls` cost columns, `/budget`, the burn-rate alarm and
  the distinct "stopped on a usage limit" state (§10.5).
- Per-session model routing: Sonnet default, `--opus` and `--haiku` overrides, and the weighted unit
  budget that admits them (§10.5).
- `/model <name>` (§4.2.1), reusing the dev-flag confirm keystroke's raw PTY write as a real feature
  instead of a debug-only affordance, so a running session's model can change mid-conversation.
- `/mode <name>` (§4.2.2), the same primitive driving the Shift+Tab permission-mode cycle. The cycle
  order it depends on is live-verified (2026-08-03), not carried forward as a plan-time assumption.
- `/restart` (§4.5.1): the self-respawn primitive the supervisor's own automatic restart-on-crash duty
  already needs, made reachable as a fleet command. Depends on this phase's own session-id persistence
  to stop being destructive to whatever conversation was mid-turn - do not backport to Phase 1.
- **Exit:** scenarios 24-28, 32, 42, 43 and 44 pass; four concurrent Sonnet sessions run for an hour
  without manual intervention, the weighted budget refuses a fifth, and the fleet's spend is visible in
  `/budget` throughout.

### Phase 6 - hardening, and the WSL2 migration

Two separable halves. The first is worth doing on Windows regardless; the second is what makes
unattended running defensible, and **should not be skipped just because Phases 1-5 worked** (§10.4.1).

**6a, on Windows:**

- The full §4.5 reconciliation matrix, including the partial-re-adoption case.
- Stale-inbound handling and monotonic timers (§7.4), verified across a real modern-standby suspend.
- Quiet mode.
- The Task Scheduler task and a README covering setup, recovery and the VPS escape hatch.
- **Exit:** scenarios 24 and 37 pass under a real restart - kill the Bridge mid-turn with a permission
  prompt open, restart it, and the system converges to a correct state with no dead buttons.

**6b, the migration (§7.6),** triggered by wanting unattended overnight runs, by prompts-per-hour
showing an uncomfortably broad allowlist, or by adding a repo other than this one:

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

1. **Cold boot.** Reboot Windows, log in, touch nothing. Within two minutes the bot answers `/ls`.
   Note that "log in" is load-bearing on this host and is the §7.2 gap being measured, not an
   incidental step: record how long after the desktop appears the bot becomes responsive.
2. **Sleep and resume.** Close the lid for 30 minutes with a session mid-turn. On resume, the topic
   shows an accurate state and no phantom pending prompts.
3. **Stale command.** Send "push it" while the machine is asleep. On resume it is confirmed, not
   executed.
4. **Terminal race.** Trigger a permission prompt, answer it at the terminal, confirm the Telegram
   buttons resolve rather than hanging.
5. **Guard rails hold, all four paths - run against SeoWrite, the pilot project.** From the phone:
   (a) ask a session on `main` to commit - SeoWrite's PowerShell guard hard-blocks it and the block is
   visible in the topic; (b) ask it to `git commit --no-verify` on a feature branch - blocked; (c) ask
   it to commit normally on a feature branch - a button appears rather than the commit just happening,
   driven by the `ask` rule and not by the guard's return value (§6.1.1); (d) ask it to
   `git push origin main` from a feature branch - the guard lets it through by design and SeoWrite's
   own `.githooks/pre-push` catches it. (c) and (d) are the ones most likely to regress silently. A
   registered repo with no equivalent guard hook has no (a)/(b)/(d) to verify - only (c), the `ask`
   rule, applies universally.
6. **Rate storm.** Four sessions on tool-heavy tasks simultaneously. Permission prompts still arrive
   promptly on the control bot; only feed frames degrade.
7. **Sandbox holds.** Ask a session to read the fleet SSH private key two ways: with `cat`, which the
   permission layer refuses, and with a throwaway Python script, which only the sandbox refuses.
   **On Windows this check is expected to FAIL on the second path and that is not a bug** - it is
   §10.4.1 made visible, and running it is how the operator sees the size of what the migration buys.
   Record the failure explicitly rather than skipping the check; it becomes the acceptance test for
   Phase 6b, where both paths must fail.
8. **Compromise drill.** Revoke the control bot token and confirm the fleet fails closed: sessions keep
   running locally, no Telegram control, no silent auto-approvals, and the feed bot alone cannot
   approve anything.
