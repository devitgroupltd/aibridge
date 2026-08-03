---
description: Deep review-and-fix loop for a target (file, plan, code area, or current work) — auto-applies MAJOR (Critical/High) findings across up to 5 passes until a pass finds none, held to SOLID/DRY/KISS/YAGNI, with web research and clarifying questions when they change the answer.
allowed-tools: Read, Glob, Grep, Bash, Edit, WebSearch, WebFetch, AskUserQuestion
argument-hint: [path-or-topic] [--report-only|--manual]
model: opus
disable-model-invocation: true
---

# Deep Check

A thorough critique-and-fix loop for a target: **what's missing, what's a gap, what
could be improved or simplified** — measured against **SOLID, DRY, KISS, YAGNI**.

**Target**: $ARGUMENTS

## Modes

Parse trailing flags out of `$ARGUMENTS` before resolving the target:

- **Default (no flag)** — autonomous loop: investigate → auto-apply every **MAJOR**
  (Critical/High) finding → verify → repeat, up to 5 passes, stopping the moment a
  pass turns up zero MAJOR findings. This is the mode described below.
- **`--report-only`** — single pass, no edits: print findings at every severity and
  stop. Use when you just want the critique, not the fixes.
- **`--manual`** — same loop, but each pass's MAJOR batch is gated behind one
  `AskUserQuestion` ("Apply all N MAJOR findings" / "Skip this pass" / "Stop") instead
  of auto-applying.

In every mode: never commit, stage, or push unless the user asked for that in this
message. The loop only edits the working tree; finished edits are left uncommitted
for the user to review.

## Resolve the target

1. If `$ARGUMENTS` (minus any mode flag) names a file, folder, plan, or topic → that
   is the target.
2. Else if the IDE has a selection → review the selected code/text.
3. Else → review the **current uncommitted work**:
   ```bash
   git status --porcelain
   git diff --stat
   ```
   Read each changed file in full (not just the hunk) before judging it.

State up front, in one line, what you resolved the target to be. If it's ambiguous
or too broad to review meaningfully, ask a clarifying question before proceeding.

**Freeze the scope.** Record the concrete file list (or folder/topic) resolved here
as `target_scope`. Every pass below investigates only `target_scope` — re-running
`git diff --stat` in later passes is to see *this loop's own edits*, not to pull in
unrelated files that happen to have changed elsewhere. Fixing a bug should not let
the review wander into files nobody asked about.

## What to look for

Investigate deeply — don't skim. In priority order:

1. **Missing / gaps** — unhandled cases, absent validation, missing tests, a step the
   plan or code skips, an assumption that isn't guaranteed, error/edge paths.
2. **Correctness** — real bugs, race conditions, wrong assumptions, spec drift
   (code vs. `plans/telegram-claude-session-control-plan.md`, or plan vs.
   `CLAUDE.md` — the plan wins when they disagree, per `CLAUDE.md`'s own note).
3. **Could be improved** — clarity, structure, naming, resilience. Prefer
   fail-fast over silent degrade.
4. **Could be simplified** — over-engineering, dead code, needless abstraction,
   speculative features/params built for a need that isn't here yet (YAGNI),
   duplicated logic that DRY would collapse, steps that could merge (KISS).

Hold every finding against **SOLID / DRY / KISS / YAGNI** and name which principle it
touches.

## Severity discipline — why this stays bounded

Repeated runs of a review tool can turn into an infinite treadmill if "any
improvement" is treated as a finding: there is always another rephrasing, another
abstraction to flatten, another name to bikeshed. That set is unbounded and
subjective, so a loop that chases it never converges. Real bugs and gaps are not
unbounded — a given piece of code has a finite number of ways it's actually wrong.
The loop below exploits that difference:

1. **MAJOR (Critical + High) — the only findings this loop auto-applies or loops on.**
   To qualify, a finding **must cite a concrete failure scenario**: a specific
   input/state that produces a wrong output, a crash, a broken contract (the
   line-delimited JSON protocol, a permission-rule derivation, a session-state
   transition — see §9 of the plan), a security hole, or a spec contradiction that
   will bite someone. "This could be cleaner" is never enough on its own to earn
   Critical/High — if you can't name the concrete way it breaks, cap it at Medium
   regardless of how it feels.
   - **CRITICAL** — blocks correct operation right now (wrong logic, contradictory
     behavior, missing required handling, a real security hole — e.g. a secret
     reachable from inside a worktree, per the "Key constraints" section of
     `CLAUDE.md`).
   - **HIGH** — a significant, demonstrable gap (unhandled error path with a named
     trigger, missing invariant with a named violation, race condition with a named
     interleaving).
2. **MEDIUM/LOW — reported once, never auto-applied, never extend the loop.**
   Clarity, structure, simplification, YAGNI-style, and other principle-only
   findings land here. They're printed at the end as a suggestions list for the user
   to act on by hand. They do not affect the pass/stop decision, so a codebase that
   has plenty of stylistic room for improvement still converges to "done" once no
   MAJOR issue remains.

## Apply project knowledge

- Load whatever project-specific skills exist for the target's layer before judging
  it (check the available-skills listing for anything matching the target's stack —
  e.g. TypeScript/Bun patterns for this repo; `plan-craft` conventions if the target
  is a plan file).
- Respect the documented constraints and decisions in `CLAUDE.md` and the canonical
  plan (`plans/telegram-claude-session-control-plan.md`) — do not "fix" a deliberate
  design decision (e.g. native-Windows-first over WSL2 for Phases 1-5, PTY sessions
  over `claude --bg`, user-level MCP registration). If the plan already settled a
  choice, don't re-open it as a gap; surface only decided-but-not-implemented gaps.
  `CLAUDE.md` currently notes this repo has **no source code yet** — if the target
  turns out to be pre-implementation, most findings will legitimately be about the
  plan itself rather than code.

## Web research

Use `WebSearch` / `WebFetch` **when a finding depends on external truth** you can't
confirm from the repo — a library's current API/behaviour, a framework best practice,
a spec/standard, a regulation (Bun, `node-pty`/ConPTY, the Telegram Bot API, the
Claude Code hooks/MCP surface). Prefer the `Context7` MCP for library docs if
available. Cite what you relied on. Don't research what the codebase already
answers.

## Ask questions

If a decision is genuinely the user's to make — and the answer changes your findings —
use `AskUserQuestion` (1–4 focused questions) **before** finalizing. Don't ask about
things you can verify yourself, and don't ask for permission to proceed.

## The loop

Initialize before pass 1: `pass = 1`, `applied_ledger = []` (every MAJOR fix applied
this run, as `{file, anchor, fix_summary}` where `anchor` is the line range or symbol
touched), `stalled = []` (findings withheld by the oscillation guard below).

**Step A — Investigate.** Run "What to look for" against `target_scope` only,
classify every finding per the severity discipline above.

**Step B — Decision gate.**
- If this pass found **zero MAJOR findings** → stop looping. Print the consolidated
  MEDIUM/LOW list once (informational — do not touch these), then go to §Output
  "clean" case.
- Else → continue to Step C.

**Step C — Apply.**
- **Default mode:** auto-apply every MAJOR finding from this pass with `Edit`.
  Before applying each one, check `applied_ledger` for a prior entry at the same
  `file`+`anchor`. If one exists and the new fix would reverse or contradict it,
  **do not apply it** — move it to `stalled`, exclude it from this pass, and treat
  this as a signal to stop after this pass (see Step E) rather than keep grinding on
  a spot two passes disagree about. Otherwise apply it and append to
  `applied_ledger`.
- **`--manual` mode:** print this pass's MAJOR findings and use one
  `AskUserQuestion`: "Apply all {N} MAJOR findings" / "Skip this pass" / "Stop — I'll
  fix manually." Apply, skip, or stop accordingly.

**Step D — Verify.** After applying a pass's fixes, run the narrowest relevant fast
check for what actually changed this pass, per `CLAUDE.md`'s `## Commands` section
(skip entirely if that section's prerequisites — actual source code — don't exist
yet for the touched package):
- A `packages/<name>/**/*.ts` file changed → `bun test` scoped to that package
  (`cd packages/<name> && bun test`), plus `tsc --noEmit` for that package if a
  `tsconfig.json` is present there.
- Nothing under `packages/**` changed (e.g. a docs/plan-only target) → no gate
  applies; skip verification.

If the check **fails**: revert only this pass's edits (`git restore` on exactly the
files touched this pass — `applied_ledger` tells you which), report which finding's
fix caused the break, and **stop the loop entirely** — do not continue to further
passes. A verification failure means the auto-fix loop is not safe to keep running
unattended on this target.

**Step E — Loop or stop.**
- `stalled` gained an entry this pass (oscillation guard tripped) → stop after this
  pass; report the stalled finding(s) for manual judgment.
- `pass = 5` → stop; print the max-passes summary.
- Otherwise → increment `pass`, return to Step A.

## §Output

### Per-pass (default mode):
```
Pass {n}/5 — applying {count} MAJOR findings:
  CRITICAL  file:line  <one-line statement>
  HIGH      file:line  <one-line statement>

Verifying: {command run} ... passed
```

### Clean (loop converged):
```
Pass {n}/5 — no MAJOR findings. Loop complete.

MEDIUM/LOW suggestions (not applied — act on these manually if useful):
  MEDIUM  file:line  <one-line statement>
  LOW     file:line  <one-line statement>

{count} MAJOR fixes applied across {n} pass(es). Nothing committed — review the
diff and commit when ready.
```
(If pass 1 is already clean, omit the "across N passes" clause.)

### Verification failure (loop stopped early):
```
Pass {n}/5 — applied {count} MAJOR findings, but verification failed:
  {command}: {failure summary}

Reverted this pass's edits. The finding that likely caused it:
  {severity}  file:line  <one-line statement>

Stopping — auto-fix is not safe to continue unattended here.
```

### Oscillation guard tripped:
```
Pass {n}/5 — {finding} at file:line contradicts a fix applied in an earlier pass.
Withholding this one for manual judgment rather than flip-flopping.

Stopping after this pass.
```

### Max passes reached:
```
Reached 5 passes. {count} MAJOR fixes applied; {count} MAJOR finding(s) remain.
Run /deep-check again to continue, or fix the rest manually.
```

### `--report-only` mode:
Unchanged from a plain critique: ranked findings at every severity, `file:line`,
why it matters, suggested fix — no edits, no loop. End with a one-line verdict:
**"solid — nothing material found"** or the count of findings by severity.

## Safety rails

- Never commit, stage, or push in any mode unless the user asked for that in this
  message.
- The 5-pass cap and the MAJOR-only auto-apply gate are fixed, not
  arguments — don't add configurability that wasn't asked for.
- Don't "fix" a deliberate decision documented in `CLAUDE.md` or the canonical plan —
  that's spec drift in the *finding*, not license to override it.
