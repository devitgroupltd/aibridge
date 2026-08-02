---
description: Deep review of a target (file, plan, code area, or the current work) for gaps, missing pieces, and simplifications — held to SOLID/DRY/KISS/YAGNI, with web research and clarifying questions when they change the answer.
allowed-tools: Read, Glob, Grep, Bash, WebSearch, WebFetch
argument-hint: [path-or-topic]
model: opus
disable-model-invocation: true
---

# Deep Check

A thorough, on-demand critique of a target: **what's missing, what's a gap, what
could be improved or simplified** — measured against **SOLID, DRY, KISS, YAGNI**.

**Default to report-only.** Investigate and report; leave the code untouched and
wait for the user to decide what to act on. Apply fixes **only if the user explicitly
asks in the same message** — and **never** commit, stage, or push unless asked.

**Target**: $ARGUMENTS

## Resolve the target

1. If `$ARGUMENTS` names a file, folder, plan, or topic → that is the target.
2. Else if the IDE has a selection → review the selected code/text.
3. Else → review the **current uncommitted work**:
   ```bash
   git status --porcelain
   git diff --stat
   ```
   Read each changed file in full (not just the hunk) before judging it.

State up front, in one line, what you resolved the target to be. If it's ambiguous
or too broad to review meaningfully, ask a clarifying question before proceeding.

## What to look for

Investigate deeply — don't skim. In priority order:

1. **Missing / gaps** — unhandled cases, absent validation, missing tests, a step the
   plan or code skips, an assumption that isn't guaranteed, error/edge paths.
2. **Correctness** — real bugs, race conditions, wrong assumptions, spec drift
   (code vs. its plan, or plan vs. `CLAUDE.md`).
3. **Could be improved** — clarity, structure, naming, resilience. Prefer
   fail-fast over silent degrade.
4. **Could be simplified** — over-engineering, dead code, needless abstraction,
   speculative features/params built for a need that isn't here yet (YAGNI),
   duplicated logic that DRY would collapse, steps that could merge (KISS).

Hold every finding against **SOLID / DRY / KISS / YAGNI** and name which principle it touches.

## Apply project knowledge

- Load whatever project-specific skills or references exist for the target's layer
  before judging it (check the available-skills listing for anything matching the
  target's stack, e.g. TypeScript/Bun patterns for this repo).
- Respect the documented constraints and decisions in `CLAUDE.md` and the canonical
  plan (`plans/telegram-claude-session-control-plan.md` for aibridge) — do not "fix"
  a deliberate design decision. If the plan already settled a choice, don't re-open
  it as a gap; surface only decided-but-not-implemented gaps.

## Web research

Use `WebSearch` / `WebFetch` **when a finding depends on external truth** you can't
confirm from the repo — a library's current API/behaviour, a framework best practice,
a spec/standard, a regulation. Prefer the `Context7` MCP for library docs if available.
Cite what you relied on. Don't research what the codebase already answers.

## Ask questions

If a decision is genuinely the user's to make — and the answer changes your findings —
use `AskUserQuestion` (1–4 focused questions) **before** finalizing. Don't ask about
things you can verify yourself, and don't ask for permission to proceed.

## Output

Ranked, most-severe first. One real gap beats ten nitpicks — skip style trivia.
For each finding:

- **Severity** — Critical / High / Medium / Low
- **What & where** — one-line statement + `file:line` (clickable)
- **Why it matters** — the concrete failure/consequence, or the principle it violates
- **Suggested fix** — a concrete direction (snippet if small); do not apply it

End with a one-line verdict: either **"solid — nothing material found"** or the count
of findings by severity. Then stop and wait — apply fixes only if the user explicitly
asked in this message; otherwise change nothing.
