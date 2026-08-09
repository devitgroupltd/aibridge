---
description: One-shot land-to-main from inside a session - commit, push, open/merge the PR. Combines /commit and /push, then merges via GitHub instead of stopping at a reviewable PR.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: [--squash|--merge|--rebase]
---

# Ship

Land this session's work on the repo's default branch, in one command, from inside the session.

This worktree can't fast-forward-merge into the default branch itself - only one branch can be
checked out per worktree, and the default branch is checked out elsewhere (the main clone, or the
Bridge's own checkout for `/deploy`/`/ship <slug>` from the control topic). So "land to main" from
in here goes through GitHub instead: push the branch, then merge the PR server-side. That's a
different mechanism from the control-topic `/ship <slug>` (which fast-forwards a local checkout
directly and then pushes) - both end with the same result on `origin/<default-branch>`.

## Steps

1. **Gate first, before asking for anything.** Run this repo's real gate (`bun test` at the repo
   root, then `bun run typecheck` for each package that declares one - see `CLAUDE.md`'s `##
   Commands`; for a non-bun repo, run whatever its own README/`package.json` scripts define). If it
   fails, stop here and report the failure - don't ask the operator to approve a commit/push for
   work that doesn't pass its own gate.
2. **Commit** - same as `/commit`: read `git status`/`git diff`, write a real commit message
   (unless there's nothing uncommitted), `git add -A && git commit -m "..."`.
3. **Push** - same as `/push`: refuse if somehow on the default branch already, `git push -u origin
   <branch>`, then `gh pr create --base <default-branch> --fill` if no PR exists yet for this
   branch.
4. **Merge** - `gh pr merge <number> --auto` is not enough on its own (it only arms auto-merge for
   when checks pass; there may be no CI configured on this repo to ever satisfy that). Instead:
   check `gh pr checks` if any are configured and wait/report on those, then merge for real with
   `gh pr merge <number> --squash` (default; `--merge`/`--rebase` if `$ARGUMENTS` asked for one of
   those instead). Never `--admin` (that bypasses branch protection - if merging is blocked, surface
   why and stop, don't force it through).
5. Report the merge result and the PR URL back to the operator via `reply`.

## Notes

- `git commit`, `git push`, and `gh pr *` all sit in this session's `permissions.ask` list - expect
  a Telegram button before each step that actually mutates anything. That's the intended safety
  gate for landing to main from inside a session; don't try to script around it.
- After a successful merge, this worktree's own local checkout of the default branch (if it has
  one) and the Bridge's separate main checkout (used by `/deploy`/control-topic `/ship`) are both
  now behind `origin/<default-branch>` until someone/something pulls - that's expected, not a bug
  in this command; don't try to sync them from here.
- If the gate has no tests at all, say so plainly rather than silently treating "nothing to run" as
  "nothing to worry about" - mirrors `/deploy`'s own `foundNoTests` handling.
- Never force-push, never skip the gate because "it's a small change", never merge with open
  unresolved review threads on the PR without calling that out first.
