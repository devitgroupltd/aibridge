# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: implemented through Phase 6a; only the WSL2 migration (6b) is unbuilt

The full design document,
[`plans/telegram-claude-session-control-plan.md`](plans/telegram-claude-session-control-plan.md), is
still the source of truth for every architectural decision below — read it (particularly the
Overview, §2 Architecture, §7.5, §9, and §12 Phases) before touching related code. This file
summarizes it; it does not replace it. When the plan and this file disagree, the plan wins and this
file is stale.

Current position in the roadmap (§12): Phases 1-5 **and 6a** are implemented and live-verified
(`packages/bridge`, `packages/channel-server`, `packages/hook-client`, `packages/protocol`,
`packages/stub-telegram`) — the `getUpdates` loop, the pipe protocol, fleet commands, the session
supervisor with crash-resume, deploy/voice/NL-router support, the full §4.5 reconciliation matrix,
autostart, stale-inbound/monotonic timers, quiet mode, and the Telegram-automation live-verification
rig are all real and covered by `bun test` (see `Commands` below).

**Phase 6b, the WSL2 migration, is the only unbuilt phase**, and it is deferred deliberately (§12,
0.56.0) until one of its three named triggers fires — wanting unattended overnight runs,
prompts-per-hour showing an uncomfortably broad allowlist, or registering a repo other than this one.
Do not treat it as an open task on a calendar; re-read §12's 6b section when a trigger actually fires.
[`plans/codebase-hardening-plan.md`](plans/codebase-hardening-plan.md) has its whole 2026-08-09 audit
closed out (P0-1–P0-6, P1-1–P1-8, P2-1–P2-6), plus P0-7/P1-9 (2026-08-12) and
P1-10/P0-8/P1-11/P1-12 (2026-08-13); its **## Open findings** section is currently empty. Outstanding work is therefore
§13's manual verification checks 2, 3, 5, 7 and 8 — the ones automated tests cannot cover — plus a
few built-but-never-live-exercised paths named in §12.

## What this project is

aibridge is a daemon (the **Bridge**) that lets one developer drive several parallel Claude Code
sessions from Telegram — one session per forum topic, against any git repo registered in a
`repos.toml` registry (§7.5) — with a live activity feed and button-based permission/question
approval. It is a standalone tool: it carries no project-specific code, and "which project" is always
a `repos.toml` lookup, never something baked into aibridge itself.

## Commands

Per §9 (the only place aibridge's own conventions are specified rather than deferred):

- Runtime/tooling: **Bun** (TypeScript). The hook client is compiled to a single-file binary via
  `bun build --compile` (startup latency is load-bearing there, §2.2); the Bridge and channel server
  run from source under `bun`.
- `bun test` — the full suite (all packages, ~1250+ tests). Test framework: `bun test`.
- `bun run typecheck` — `tsc --noEmit` across every package's own `tsconfig.json`. Type gate: both
  this and `bun test` are meant to run in CI per package.
- Testing convention: unit-test any helper whose failure mode is **silent-wrong** (produces a
  plausible-looking but incorrect result) rather than a loud crash, plus every exit-code or protocol
  contract another component branches on. §9 lists 41 concrete scenarios this covers (protocol
  contract, permission-rule derivation, rate-limit governors, reconciliation, session-state
  transitions, send-failure retries) — treat these as the initial test plan, not just documentation.

## Live-verifying against the real Telegram client

Before telling the user something "can't be verified without a real bot/browser" or "would need you
to check Telegram yourself" — check **`scripts/telegram-automation/`** first. It is a Playwright rig
that drives the actual Telegram Web K client as the logged-in operator (`chromium.launchPersistentContext`
against a real, already-authenticated profile — `status.txt` in that folder reads `logged_in` when a
session exists). It is dev/QA tooling for aibridge, not aibridge itself (same "not aibridge's own code"
boundary as `scripts/dev-bridge.sh`).

- `login.js` — one-time interactive login (run manually, scan the QR code). Skip this if `status.txt`
  already says `logged_in`.
- `client.js` — shared helpers (`connect`, `openGroup`, `openTopic`, `sendMessage`, `getMessageTexts`,
  `getMessageCount`) every other script imports. Read this first for the DOM selectors it already
  fought through (documented inline: composer disambiguation, ripple-overlay click interception, stale
  message-matching pitfalls).
- `send-command.js "<cmd>"` — sends a real control-topic command and prints what comes back.
- `check-topic.js "<substring>" [count]` — reads the last N messages from a session's own topic.
- `send-to-topic.js "<substring>" "<message>"` — sends into a session's own topic (not the control
  topic) and prints what comes back; `send-command.js` only covers the control topic.
- `list-topics.js`, `inspect-last-message.js`, `inspect-topic.js`, `tap-button.js`,
  `tap-topic-button.js` — narrower inspection/interaction helpers; read before writing a new one-off
  script, most needs are already covered.
- For anything not covered by an existing script (e.g. checking Telegram's native command-autocomplete
  popup), write a small one-off script in this folder that reuses `client.js` rather than declaring the
  check impossible — a real, already-logged-in browser profile is sitting right there.
- Only one browser may run against the persisted profile at a time (`launchPersistentContext` refuses
  a second concurrent instance) — don't run two of these scripts simultaneously.
- The Bridge itself only picks up new code on restart (`bun run bridge:restart` /
  `scripts/dev-bridge.sh restart`) — if a live check doesn't show an expected change, restart the
  daemon before concluding the feature is broken; it's easy to be live-checking a stale process.

## Architecture

Three long-lived-differently components, one per process lifetime requirement (§2.1):

- **Bridge** — the only long-lived daemon. Owns both Telegram bot tokens (a `getUpdates`-polling
  control bot and a send-only feed bot — Telegram allows exactly one poller per token, which is why a
  central daemon is structurally required at all, see Overview "the constraint that forces a daemon"),
  the routing table (SQLite), topic lifecycle, a per-token rate governor, the pending-permission-prompt
  registry, and the session supervisor (`node-pty` over ConPTY).
- **Channel server** — one per session, spawned by `claude` itself over stdio via
  `--dangerously-load-development-channels` (a real, hidden-from-`--help` flag, confirmed against a
  pinned client, §2.4/§10.0). Implements the `claude/channel` and `claude/channel/permission` MCP
  capabilities. Lives exactly as long as its session.
- **Hook client** — a tiny compiled binary invoked by Claude Code's `command` hooks on every relevant
  event (tool calls, questions). Reports activity into the feed and blocks on `AskUserQuestion`.

All three speak one line-delimited JSON protocol over a single Windows named pipe
(`\\.\pipe\aibridge`; a unix socket under the future WSL2 migration, §7.6), mode-restricted as the
in-machine trust boundary.

**Why the split matters for the feed:** channels can only carry inbound pushed messages and text
Claude explicitly sends via its `reply` tool — no thinking blocks, tool calls, or diffs. Anything that
looks like "what is Claude doing" therefore has to come from **hooks**, not the channel. The feed is
two independent event paths landing in the same Telegram topic, and that split drives most of §5/§6's
complexity.

**Session model (§2.3):** one `claude` process per Telegram topic, each on its own Bridge-owned PTY, in
its own git worktree cut from the target repo (`git worktree add ... -b claude/<slug>-<id>`). Chosen
over `claude --bg` background agents because their short id is unstable across resumes and there's no
supervision API; a PTY gives a stable `session_id` from `SessionStart`, keeps the session on the
interactive TUI (subscription billing + `AskUserQuestion` availability), and makes restart a supported
`claude --resume <session_id>`. `node-pty`/ConPTY (not tmux — no Windows port) was chosen partly
*because* it doesn't need to be replaced at the eventual WSL2 migration.

**Project registry (§7.5):** `/new <repo> ...` takes a short name, resolved via `$STATE\repos.toml`
(`$STATE` = `%LOCALAPPDATA%\aibridge`) to an existing clone; worktrees are cut into
`c:\data\worktrees\<slug>`. Adding a project means editing that TOML file, not touching any aibridge
code path. Secrets (bot tokens, a dedicated fleet-only SSH key) live in `%APPDATA%\aibridge`, kept
separate from `$STATE` because one is disposable and the other isn't — never in a worktree or target
repo.

## Key constraints worth re-reading before touching related code

- **Host is native Windows for Phases 1-5**, WSL2 (with its OS-level sandbox) is a deliberate Phase 6
  migration, not the starting point (decision 1, §7). This means there is currently no OS-enforced
  secret containment — a script the session writes can read `%USERPROFILE%\.ssh` regardless of `deny`
  rules — so the git-push credential is a dedicated, separately revocable SSH key, not the owner's
  everyday one (§7.5).
- **Permission model is allowlist + button escalation** (decision 3, §6): safe reads/builds/tests are
  pre-approved in generated per-session settings; everything else raises an inline Telegram keyboard.
  Generated `ask`-list settings must put `git commit`/`git push` in `permissions.ask` explicitly, not
  merely leave them out of `allow` — a bare `Bash` ask rule is skipped for sandboxed commands (§6.1.1,
  §9 scenario 11).
- **Registration is user-level** (`~/.claude.json`), not per-worktree `.mcp.json`, specifically to avoid
  a "new MCP server found" consent dialog firing on every `/new` (every worktree is a new project
  directory) (§2.4).
- **A registered target repo's own `.claude/` hooks run unmodified** inside its worktrees (e.g.
  SeoWrite's `guard-git-write.ps1`) — aibridge does not touch target-repo code, and any such repo's own
  hook-parity testing (e.g. a future bash port for the Phase 6b WSL2 migration) is that repo's
  responsibility, not aibridge's test suite (§9 scenario 13, §7.5).
