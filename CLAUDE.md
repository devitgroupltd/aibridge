# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: design complete, no code written yet

This repo currently contains only `README.md` and the full design document,
[`plans/telegram-claude-session-control-plan.md`](plans/telegram-claude-session-control-plan.md). That
plan is the source of truth for every architectural decision below — read it (particularly the
Overview, §2 Architecture, §7.5, §9, and §12 Phases) before implementing anything. This file summarizes
it; it does not replace it. When the plan and this file disagree, the plan wins and this file is stale.

Current position in the roadmap (§12): prerequisites P-1/P-2/P-4/P-5 and the interactive protocol
sitting (Phase 1.0) are done. Phase 1 ("walking skeleton" — Bridge with a single `getUpdates` loop, a
minimal channel server, one hardcoded topic) has not been started.

## What this project is

aibridge is a daemon (the **Bridge**) that lets one developer drive several parallel Claude Code
sessions from Telegram — one session per forum topic, against any git repo registered in a
`repos.toml` registry (§7.5) — with a live activity feed and button-based permission/question
approval. It is a standalone tool: it carries no project-specific code, and "which project" is always
a `repos.toml` lookup, never something baked into aibridge itself.

## Commands

No build, lint, or test tooling exists yet because no source code exists yet. Once implementation
starts, per §9 (the only place aibridge's own conventions are specified rather than deferred):

- Runtime/tooling: **Bun** (TypeScript). The hook client is compiled to a single-file binary via
  `bun build --compile` (startup latency is load-bearing there, §2.2); the Bridge and channel server
  run from source under `bun`.
- Test framework: `bun test`. Type gate: `tsc --noEmit`. Both are meant to run in CI per package.
- Testing convention: unit-test any helper whose failure mode is **silent-wrong** (produces a
  plausible-looking but incorrect result) rather than a loud crash, plus every exit-code or protocol
  contract another component branches on. §9 lists ~24 concrete scenarios this covers (protocol
  contract, permission-rule derivation, rate-limit governors, reconciliation) — treat these as the
  initial test plan, not just documentation.

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
