---
description: Stage and commit the current worktree's changes with a real, reviewed commit message. Reusable on its own, and the first step /push and /ship chain into.
allowed-tools: Bash, Read
argument-hint: [message]
---

# Commit

Stage and commit whatever is currently uncommitted in this worktree.

## Steps

1. `git status --porcelain` and `git diff` (staged + unstaged) - read the actual changes, not just
   the file list. If there's nothing to commit, say so and stop.
2. If `$ARGUMENTS` is non-empty, use it verbatim as the commit message. Otherwise write a real
   commit message from what you just read: a concise summary line (imperative mood, no trailing
   period), a blank line, then body lines only where the *why* isn't obvious from the diff itself.
   Never a generic placeholder like "update files" or "fixes".
3. `git add -A` (this worktree is a session's own throwaway branch - there's nothing else sharing
   it to stage around), then `git commit -m "<message>"`.
4. Report the commit sha and one-line summary back to the operator (via `reply`, brief - they're
   reading on a phone).

## Notes

- `git commit` sits in this session's `permissions.ask` list, not `allow` - expect a Telegram
  button before it actually runs. That's the safety gate, not a bug; don't try to work around it.
- Never `git commit --amend` or rewrite history that's already been pushed - if the working tree is
  already committed and clean, say so and stop rather than inventing something to change.
- Never `git push` from here - that's `/push`'s job, kept separate so a commit can be reviewed
  before it leaves the machine.
