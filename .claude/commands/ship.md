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

1. **Sync with the default branch first.** `git fetch origin`, then check how far behind:
   `git rev-list --count HEAD..origin/<default-branch>`. If it's `0`, skip to step 2.
   Otherwise this branch is missing commits that landed on the default branch since it was cut, and
   merging/pushing/opening a PR without them risks a conflicted or stale-looking PR:
   - If `git status --porcelain` shows uncommitted work, commit it first (same as `/commit`: read
     the actual diff, write a real message, `git add -A && git commit -m "..."`) so the merge lands
     on a clean tree instead of tangling with in-progress edits.
   - `git merge origin/<default-branch>`. If it merges clean, done - move on to step 2.
   - If it reports conflicts, resolve them for real: read each conflicted file's markers and both
     sides' actual intent (`git log --oneline HEAD...origin/<default-branch>` for what the default
     branch added helps), edit to the correct combined result, `git add <file>` per file, then
     `git commit` to complete the merge once every conflict is resolved. Never resolve by blindly
     taking `--ours`/`--theirs` wholesale, and never guess through a conflict that changes actual
     business logic (not just adjacent lines) - if the right resolution isn't clear, stop and ask
     the operator via `reply` rather than picking one side.
   - This produces a real merge commit, which sits under the same `permissions.ask` gate as any
     other `git commit` here - expect a Telegram button for it too.
2. **Gate, before asking for anything else.** Run this repo's real gate (`bun test` at the repo
   root, then `bun run typecheck` for each package that declares one - see `CLAUDE.md`'s `##
   Commands`; for a non-bun repo, run whatever its own README/`package.json` scripts define) against
   the now-synced tree. If it fails, stop here and report the failure - don't ask the operator to
   approve a commit/push for work that doesn't pass its own gate.
3. **Commit** - same as `/commit`: read `git status`/`git diff`, write a real commit message
   (unless there's nothing uncommitted left - step 1 may already have committed everything). 
4. **Push** - same as `/push`: refuse if somehow on the default branch already, `git push -u origin
   <branch>`, then `gh pr create --base <default-branch> --fill` if no PR exists yet for this
   branch.
5. **Merge** - `gh pr merge <number> --auto` is not enough on its own (it only arms auto-merge for
   when checks pass; there may be no CI configured on this repo to ever satisfy that). Instead:
   check `gh pr checks` if any are configured and wait/report on those, then merge for real with
   `gh pr merge <number> --squash` (default; `--merge`/`--rebase` if `$ARGUMENTS` asked for one of
   those instead). Never `--admin` (that bypasses branch protection - if merging is blocked, surface
   why and stop, don't force it through).
6. Report the merge result and the PR URL back to the operator via `reply`. If step 1 did a
   nontrivial conflict resolution, call that out explicitly rather than folding it silently into the
   rest of the summary.

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
- Step 1 uses `git merge`, not `git rebase`, to pull in the default branch - rebasing would rewrite
  this branch's commits, which forces a `--force`-push once any of it is already on `origin`; a
  merge commit doesn't. Don't switch it to a rebase to "keep history clean."
