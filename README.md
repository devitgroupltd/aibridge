# aibridge

Control a fleet of Claude Code sessions, across any of your git repos, from Telegram.

One long-lived daemon (the **Bridge**) owns your Telegram bot tokens and a routing table; each Claude
Code session runs in its own git worktree, on its own topic in a single Telegram supergroup, with a
custom MCP channel server pushing messages in and a hook-fed activity feed and inline-button
permission relay reporting out. Switching projects means passing a different name to `/new` - not
standing up anything new. See `repos.toml` and §7.5 of the plan below.

**Status: design complete, implementation not started.** The full design, including everything already
probed and verified against a real Claude Code client, lives in
[`plans/telegram-claude-session-control-plan.md`](plans/telegram-claude-session-control-plan.md).
Start there before writing any code.

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
- Phases 1-5 are scoped as a walking skeleton (protocol) -> permission relay -> activity feed ->
  questions -> the fleet. See §12.
- Nothing has been built yet. The plan is the starting point for Phase 1.
