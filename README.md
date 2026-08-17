# aibridge

Control a fleet of Claude Code sessions, across any of your git repos, from Telegram.

One long-lived daemon (the **Bridge**) owns your Telegram bot tokens and a routing table; each Claude
Code session runs in its own git worktree, on its own topic in a single Telegram supergroup, with a
custom MCP channel server pushing messages in and a hook-fed activity feed and inline-button
permission relay reporting out. Switching projects means passing a different name to `/new` - not
standing up anything new. See `repos.toml` and §7.5 of the plan below.

**Status: Phases 1-5 built and live-verified; Phase 6a (hardening) in progress.** The full design,
including everything already probed and verified against a real Claude Code client, lives in
[`plans/telegram-claude-session-control-plan.md`](plans/telegram-claude-session-control-plan.md) - §12
is the phase-by-phase status, kept current there rather than duplicated here.

## Setup

One-time host setup on a new Windows machine (installs Bun, MSVC build tools, sets the Defender
exclusion, generates the fleet SSH key, and walks you through the Telegram bot/chat-id setup - safe to
re-run, it skips whatever's already done):

```powershell
# from an elevated PowerShell
bun run setup
```

This is `scripts/setup-windows.ps1` (§12 P-1/P-2). At the end you have a populated
`%APPDATA%\aibridge\.env` (`CONTROL_BOT_TOKEN`, `FEED_BOT_TOKEN`, `SUPERGROUP_CHAT_ID`) and an
`%LOCALAPPDATA%\aibridge` state directory. Two things the script does not do for you:

- **`repos.toml`.** Create `%LOCALAPPDATA%\aibridge\repos.toml` by hand, one `[name]` block per repo
  you want `/new` to be able to open (path, base branch, optional default model) - see §7.5 of the
  plan for the format. `/new` refuses an unregistered name with the list of what is registered, rather
  than guessing a path. If a registered repo ships its own project-scoped `.mcp.json`, those servers
  are **rejected by default** in every session cut from it; add `projectMcp = true` to that repo's
  block to run them. Closed by default because an MCP server is a long-lived process holding
  credentials, not a per-tool-call hook - see `packages/bridge/src/project-mcp-policy.ts`.
- **Claude Code login.** `claude` must be logged in, interactively, as the same Windows account the
  Bridge will run as, once, before the first session launch - otherwise every session in the fleet
  fails at launch with an auth error, which from a phone looks like "the whole thing is broken" (§7.5).

## Running the Bridge

Day to day, from the repo root, for local dev/iteration:

```
bun run bridge:start     # start the dev Bridge (packages/bridge/src/index.ts)
bun run bridge:status    # is it running, and where's the log
bun run bridge:logs      # tail the log
bun run bridge:restart
bun run bridge:stop
```

These are thin wrappers around `scripts/dev-bridge.sh` (bash - Git for Windows already puts `bash`
on PATH) - see that file for what "start" actually does (env vars, log/pid file locations). This is
**dev tooling**, not the production path: it runs under `node --experimental-strip-types` with a fixed
dev-control port and writes its log to `%LOCALAPPDATA%\aibridge\bridge-dev.log`.

### Running unattended (autostart)

For everyday use you want the Bridge to start itself, not to be launched by hand from a terminal every
time you log in. From the control topic:

```
/autostart status      # is a logon task registered, and what did it last do
/autostart install      # register it
/autostart uninstall    # remove it
```

`install` registers a Windows Task Scheduler task (`aibridge`, *at log on*, current-user scope,
`/RL LIMITED` - no admin rights needed) that runs `bun run packages/bridge/src/index.ts` (§7.2).
`status` reads it back via `schtasks /Query`; a `Not registered` reply means Telegram control does not
survive a reboot until you run `install` once.

**The one honest gap (§7.2): this starts at log-on, not at boot.** After a reboot, the bot goes quiet
until *someone logs into that Windows session* - Task Scheduler's *"run whether user is logged on or
not"* mode was deliberately not used, because it runs in session 0, where ConPTY behaviour and the
Claude Code credential store are not things this project is willing to assume. Two ways to close the
gap in practice: reboot deliberately and log in right after, or enable Windows autologon with the
workstation immediately locked afterward.

**Fixed in 0.74.0: the Bridge now owns its own log file regardless of launch method.** A Task Scheduler
launch used to capture no stdout/stderr at all - `bridge:logs`' dev log file was only ever an artifact
of `scripts/dev-bridge.sh`'s own shell redirect, not something the Bridge process did itself, so
autostart launches had nothing. `logger.ts` now writes every `log()` line to
`%LOCALAPPDATA%\aibridge\bridge.log` directly (10MB cap, one rotated `.1` backup) no matter how the
process was started, and uncaught exceptions/unhandled rejections are logged there before the process
exits - so a silent post-reboot failure now has a real log file to read, on top of `/autostart status`'s
`Last result` field (a Win32 exit code - `0` means the process exited cleanly, which for a daemon that's
supposed to keep running is itself a bad sign) and Windows' own Event Viewer (Task Scheduler's
operational log, under *Task Scheduler Library*). Confirm the Bridge is actually up via `/ls` or
`/settings` from Telegram either way, not just a "registered" status.

### The VPS escape hatch

Everything above is written for a laptop, because that is where this project runs today. Nothing in
the Bridge or channel server is Windows-specific beyond the two named exceptions in §7.6 (the named
pipe, and a couple of `schtasks`/PowerShell calls), so the sleep/resume handling in §7.4 - which exists
*because* a laptop's lid closes - is a workaround for a problem a cloud VPS or always-on desktop simply
doesn't have. If prompts-per-hour or unattended-overnight-run needs outgrow "reboot and log back in",
moving the Bridge to a VPS (or leaving a desktop always logged in) is a smaller step than the WSL2
migration (§7.6): a service unit (or the same Task Scheduler approach on Windows Server) plus a clone,
no protocol or code change required. Not built or scripted today - recorded here as the pressure-release
valve, not a roadmap item.

## Recovery

Things that go wrong and what to do about them, without touching code:

- **Bridge won't start / dies immediately.** Check `%APPDATA%\aibridge\.env` exists and has all three
  required keys - a missing or empty one throws a named error at startup rather than failing silently
  deep inside the first Telegram call (§12 P-2). A missing/expired Claude Code login produces the same
  "every session dies instantly" symptom (§7.5) - run `claude` interactively once to confirm login is
  live.
- **After a restart, a session looks dead but its worktree/topic still exist.** This is what startup
  reconciliation is for - every non-`dead` row is resumed via `claude --resume` automatically on Bridge
  boot (§4.5), live-verified across real restarts. Give it a few seconds, then check `/ls`. If it's
  still wrong, `/remove --dead` clears rows reconciliation itself gave up on, without touching live ones.
- **A `claude.exe` process is running but doesn't show up in `/ls`.** Startup reconciliation's orphan
  scan flags exactly this to the control topic for manual review - it is never auto-killed, because
  deciding to kill an unrecognized live process is the operator's call, not a heuristic's (§4.5).
- **A session's Telegram topic was deleted while the Bridge was down.** Reconciliation marks that row
  dead and notifies the control topic instead of a now-nonexistent topic (§4.5) - no action needed
  beyond noticing the notice.
- **The whole fleet needs a clean-slate restart** (e.g. after a code change during dev, or the Bridge
  process looks wedged): `/restart` from the control topic self-respawns the Bridge process in place;
  running sessions survive it (§4.5.1). `bun run bridge:restart` does the same thing from the desk for
  local dev.
- **Woke the laptop up and something typed while it was asleep looks like it's about to be silently
  actioned on stale context.** It won't be - anything queued more than 30 minutes is treated as stale
  and re-confirmed rather than acted on directly (§7.4). If it doesn't behave that way, that's the one
  piece of §7.4 not yet fully wired (see the plan's §12 Phase 6a status) - report it rather than
  assuming it's covered.
- **A permission or question prompt is stuck with a dead button** (e.g. after a restart mid-turn).
  Permission prompts expire on their own after 30 minutes even with no hook resolving them (§6.5);
  `AskUserQuestion` prompts do the same at 3540s (§6.4). Answering at the terminal instead also
  resolves the Telegram side - that race is scenario 24/37's territory (§13 check 4).

## Why this is its own repo

This project was originally designed inside [SeoWrite](https://github.com/devitgroupltd/seowrite)'s
`plans/` folder, since that was the first (and only) project it was meant to control. The design
itself never assumed a single project - `/new <repo> <prompt>` already resolves `<repo>` through a
`repos.toml` registry - so nothing about extracting it to its own repo required a redesign, only
generalizing prose that assumed "the repo" meant SeoWrite specifically. See the plan's decision 5 and
its v0.8.0 changelog entry for exactly what changed on the move.

## Status of the design

- The channel protocol (Anthropic's `--dangerously-load-development-channels` flag) is verified to
  exist and to deliver events end-to-end, including mid-turn injection, against a pinned Claude Code
  client. See §10.0 of the plan.
- Phases 1-5 (walking skeleton -> permission relay -> activity feed -> questions -> the fleet) are all
  built and live-verified. Phase 6a (hardening on Windows: reconciliation, autostart, sleep/resume,
  quiet mode) is in progress; Phase 6b (the WSL2 migration, for the OS-level sandbox) has not started.
  See §12 of the plan for the current, authoritative status - this file summarizes it and can go stale.
