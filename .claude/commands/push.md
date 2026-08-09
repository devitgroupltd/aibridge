---
description: Push this session's branch to origin and open (or update) a PR against the default branch. Reusable on its own, and the second step /ship chains into after /commit.
allowed-tools: Bash, Read
argument-hint: [--no-pr]
---

# Push

Get this session's branch onto the remote and reviewable, without landing it.

## Steps

1. `git status --porcelain` - if there's uncommitted work, run through `/commit`'s steps first
   (don't push a dirty tree half-committed).
2. Find the current branch: `git rev-parse --abbrev-ref HEAD`. Refuse if it's the repo's default
   branch itself (`git symbolic-ref refs/remotes/origin/HEAD` or `gh repo view --json defaultBranchRef`)
   - a session's own worktree should always be on its own `claude/<slug>-<id>` branch (§2.3); being
   on the default branch here means something's already wrong, not something to push through.
3. `git push -u origin <branch>` (first push sets the upstream; a re-run is a plain `git push`).
4. Unless `$ARGUMENTS` contains `--no-pr`: check for an existing PR (`gh pr view --json url` for
   this branch); if none exists, `gh pr create --base <default-branch> --fill` (let it infer
   title/body from the commit(s) unless they need a better summary - edit with `--title`/`--body`
   if the auto-fill is generic).
5. Report the branch name and PR URL (if any) back to the operator via `reply`.

## Notes

- `git push` and `gh pr *` both sit in this session's `permissions.ask` list - expect a Telegram
  button before each actually runs.
- Never `git push --force`/`--force-with-lease` from here - a rejected push means the remote branch
  moved (someone/something else touched it); stop and surface that rather than overwriting it.
- This only gets the branch onto GitHub and (optionally) opens a PR - it does not merge to main.
  Landing to main is `/ship`'s job (in-session: merges the PR via `gh pr merge`; from the control
  topic: `/ship <slug>` does the same end to end without opening the session).
