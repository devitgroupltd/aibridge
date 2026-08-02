---
name: plan-craft
description: Create a new technical plan or deep-review an existing one. Finds edge cases, applies 25+ design principles, cross-checks codebase and web docs. Prints all findings and applies them automatically every pass (pass --manual for interactive batch approval), then bumps version with UTC timestamp and updates changelog. Exits with "plan is solid" when nothing remains.
when_to_use: "use to create new plans, review existing plans, or when codebase has drifted from spec"
argument-hint: "<plan-name-or-path> [--manual]"
allowed-tools: "Read Write Edit WebSearch WebFetch Agent Bash(date *) Bash(mkdir *) Bash(ls *) Bash(find *) AskUserQuestion"
---

**Step 1 — Resolve the plan file**

- The user's input is available as `$ARGUMENTS` (the full string after the skill name, e.g. `billing` or `billing monetization`).
- **Mode flag (`--manual`):** if the plan-name portion of `$ARGUMENTS` (the part before any ` -- ` seeded-findings separator) contains the standalone whitespace-delimited token `--manual`, set `manual_mode = true` and strip that token from `$ARGUMENTS` before any further parsing (plan-name resolution and the Step 1B ` -- ` split). Otherwise `manual_mode = false`. **Default (`manual_mode = false`) is fully autonomous — the skill applies every finding on every pass with no per-pass `AskUserQuestion` approval gate (see Step 7), then surfaces any auto-answered open questions once at the end of the run for review (the Step 10 decision checkpoint). Pass `--manual` to restore interactive batch approval.** (Autonomous mode removes only the **findings-approval** gate; plan **selection** and **creation** prompts in Step 1 — disambiguating multiple filename matches, the create-new flow — still appear when the input is ambiguous, since there is no safe way to auto-resolve *which* plan to review.)
- Initialize pass counter = 1. This counter tracks the current pass number and is displayed as "Pass N/5" in output.
- Ensure `plans/` directory exists first; if not, create it with `Bash`: `mkdir -p plans` (must happen before listing, even on no-arg calls)
- If `$ARGUMENTS` is empty → check whether an `ide_opened_file` path under `plans/` is present in the conversation context. If yes, use that file directly (treat it as a direct path — skip fuzzy search) and print `Using active editor file: {path}`. If no `ide_opened_file` under `plans/` is present, print the "no argument" table (see §Output) and stop.
- If `$ARGUMENTS` contains a path separator (`/`), treat it as a direct file path — skip the fuzzy search, verify the file exists using `Read`, and use it directly. If the file does not exist, print `Error: file not found at '{path}'. Use a plan name (without '/') for fuzzy matching in plans/.` and stop.
- Otherwise, search for `$ARGUMENTS` in **`plans/*.md` only, a non-recursive glob**. Match by: any word in `$ARGUMENTS` appearing in the filename (case-insensitive, ignore hyphens/underscores). No subdirectory is searched or listed: `completed/`, `production-ready/`, `ideas/`, `discussions/` and `audits/` are all reachable by explicit path only (`/plan-craft plans/ideas/foo.md`). Stating the scope this way is what makes the rule uniform: in particular `plans/audits/` holds `/plan-audit`'s per-plan sidecars, which share their plan's filename stem, so a recursive search would turn every plan name into a two-way ambiguous match and could offer an audit record as a plan.
- If **one match** → use it
- If **multiple matches** → use `AskUserQuestion` with up to 4 options (filenames); if more than 4 matches exist, list all in text output, print "Please re-run /plan-craft with a more specific name." and stop
- If **no match** → two sequential `AskUserQuestion` calls:
  - **Call A** (single question, 2 options): "No plan named '$ARGUMENTS' found. What would you like to do?" — options: "Create a new plan" / "List all plans and stop"
  - If "List" selected → print filenames in `plans/` and stop
  - **Call B** (implemented as 3 sequential `AskUserQuestion` calls, one per question — not a single multi-question call): (a) "Plan topic/purpose?" (placeholder: "General technical feature spec"), (b) "Who is the target audience?" (placeholder: "Engineering team"), (c) "Key sections to include (comma-separated)?" (placeholder: "Implementation, Testing, Rollout"). Each call has the placeholder option + "Other". Selecting "Other" causes the skill to output a text prompt (e.g., "Please type your custom answer for (a):") and pause; the user's reply in the next conversational message is used as the free-text value for that slot. After receiving the free-text reply, the skill continues to the next unanswered question — it does not pre-launch subsequent AskUserQuestion calls before the free-text reply arrives. Each question's value is resolved in order before the next question is asked. (AskUserQuestion is single-select only; "Other" always requires a follow-up text turn.) If the free-text reply is empty or whitespace-only, re-prompt once: "Your answer was empty — please provide a non-empty value for [question]." If still empty after the re-prompt, cancel plan creation and print an error.
  - For question (c): each comma-separated item in the answer becomes one `##` heading in the skeleton. An answer of "Goals, Implementation, Rollout" produces three `##` sections. Note: the skeleton always includes `## Overview` (with audience/description), `## Testing`, and `## Verification` as fixed sections — if the user's answer to (c) includes "Overview", "Testing", or "Verification", those items are silently skipped (deduplication) since the skeleton already provides them. Deduplication is case-insensitive and matches on the full trimmed item exactly ("Overview Plan" is NOT deduplicated against "Overview").
  - Collect answers; for any question where the user chose the placeholder rather than "Other", substitute the placeholder text in the skeleton.
  - Before writing the file: sanitize each free-text answer: (a) for the filename — strip characters invalid in file paths (colons, slashes, asterisks, question marks, quotes, angle brackets, pipes, backslashes), replace non-ASCII characters using ASCII-safe transliteration where a clear equivalent exists (e.g., `é` → `e`; otherwise strip the character), then slugify (lowercase, spaces → hyphens, strip remaining non-alphanumeric except hyphens); the final slug must contain only ASCII alphanumerics and hyphens; (b) for YAML frontmatter values — if the value contains any YAML-reserved character (`:`, `#`, `[`, `]`, `{`, `}`, `|`, `>`, `&`, `*`, `!`, `?`, or a leading `-`), wrap the entire string in double quotes; escape any embedded double quotes as `\"`; (c) for Markdown headings — these characters are safe as-is.
  - Filename = slugify the topic answer from question (a) + `-plan.md` (lowercase, spaces → hyphens, strip non-alphanumeric except hyphens). If that **filename stem** is already taken anywhere under `plans/**` (including `completed/` and `production-ready/`, not just `plans/` itself), append `-2`, `-3`, etc. until unique. The stem must be globally unique because `/plan-audit` binds a plan to its audit sidecar (`plans/audits/<stem>.audit.md`) **by stem**: two plans sharing one would bind to the same sidecar, and the pairing becomes undefined.
  - Create a new `.md` in `plans/` with the frontmatter template below and a skeleton body. Use `date -u +%Y-%m-%dT%H:%M:%SZ` for `last_modified_utc`. If `Write` fails (permission denied, disk full, etc.), print `Error: could not create plan file at plans/{filename}: {error}` and stop. On success, print: `Created: plans/{filename} (v0.1.0)`. Then proceed to Step 2 with the new file.
  - If ALL three answers are the default placeholder (not "Other"): warn "All sections will use generic placeholder defaults — /plan-craft will flag them as TODO on first review. Continue?" and create the plan only if confirmed.
  - If two of the three answers are placeholders: warn "2 sections will use generic placeholder defaults — /plan-craft will flag them as TODO on first review. Continue?" and create only if confirmed.
  - If exactly one answer is a placeholder: create the plan without warning — one placeholder is acceptable and will be flagged as TODO on first review.
  - If zero answers are placeholders (all three provided via "Other"): create the plan without warning — fully custom answers are the most desirable outcome.
  - All placeholder-confirmation prompts use `AskUserQuestion` (2 options): "Continue" / "Cancel". If "Continue" is selected (or no warning was shown): create the plan file (write frontmatter + skeleton body per the template below) and proceed to Step 2 with the new file. If "Cancel" is selected: stop without creating any file.

**New plan frontmatter template:**
```yaml
---
version: 0.1.0
status: draft
last_modified_utc: <result of: date -u +%Y-%m-%dT%H:%M:%SZ>
changelog:
  - "0.1.0 (<YYYY-MM-DD>): Initial plan created"
---
```
(Every changelog entry MUST be a double-quoted YAML string — see Step 8. The `{version} (date): summary` shape contains a `: ` that a strict YAML parser otherwise reads as a nested mapping.)

**New plan skeleton body** (generated from user's answers):
```markdown
# <Plan Topic — from Call B question (a)>

## Overview

**Audience:** <from Call B question (b)>

Brief one-paragraph description of what this plan covers and why it exists.

## <Section 1 — first item from Call B question (c)>

TODO: describe this section.

## <Section N — …remaining items from Call B question (c)>

TODO: describe this section.

## Testing

TODO (code-writing plans only): enumerate numbered test scenarios — happy-path use cases, edge cases, and error/failure paths. For each, name the test type (unit / integration / frontend spec) and target test project, and map it to an acceptance criterion. Name the test gate (e.g. `dotnet test` / `ng test`). Delete this section for pure ops/runbook/config plans.

## Verification

TODO: add manual/operational verification steps (deploy checks, smoke tests). Automated test coverage belongs in the ## Testing section above.
```

**Step 1B — Pre-seeded findings (optional)**

- If `$ARGUMENTS` contains ` -- ` (space, two hyphens, space), split on the **first** occurrence:
  - Part **before** ` -- ` → plan name/path (used by Step 1 resolution as normal)
  - Part **after** ` -- ` → pre-seeded findings block; split on ` | ` (space-pipe-space) to get individual findings
- Each pre-seeded finding must match the format: `SEVERITY §SECTION Description`
  - Valid severities (case-insensitive): `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `OPEN Q`
  - `§SECTION` is any section reference (e.g., `§6.K`, `§8`, `§3.B`)
  - `Description` is free text
  - Lines that do not match this format → print a warning (`Skipping malformed seeded finding: "{line}"`) and skip
- Store parsed findings as `seeded_findings[]`; each entry carries: `{severity, section, description}`
- In Step 4, **merge** `seeded_findings[]` into the findings list before running the full checklist. Treat them as confirmed findings at their stated severity — no checklist re-derivation needed for them. Agents (Step 3) still run normally and may discover additional findings. If an agent independently discovers the same issue as a seeded finding, merge them into a single finding entry (keep the seeded severity, append agent evidence if useful).
- If no ` -- ` separator is present, `seeded_findings[]` is empty and Step 1B has no effect.

**Step 2 — Parse the plan**

- Read the resolved plan file using the `Read` tool. For files longer than 2000 lines, use `offset` + `limit` (page size: 2000 lines per page) to read in pages until the entire file is loaded — do not start analysis until the full content is in context. Stopping condition: stop paging when the `Read` response returns fewer lines than the requested `limit` (that indicates end of file was reached).
- After reading, if the plan exceeds 500 lines, extract section boundaries: scan the `cat -n` output for lines matching `^N\t##` (where N is the line number); record each H2 heading as `{section-name: string, start_line: N, end_line: M}` where M is (next H2 start − 1), or EOF for the last section. Store these boundaries for use in Step 3.
- Extract: `version`, `last_modified_utc`, `changelog`, `changelog_archive` (if present — preserve it unchanged when rewriting frontmatter in Step 8), and any `v{semver_nodots}_touched_sections` blocks (keys matching the pattern `v\d+[a-z]*_touched_sections` — the `[a-z]*` suffix handles collision-disambiguated keys like `v1010a_touched_sections`)
  - The `v{semver_nodots}` key format: strip all dots from the version string. Version `1.6.0` → key `v160_touched_sections`. Version `0.1.0` → key `v010_touched_sections`.
- Malformed frontmatter means any of: (a) no `---` delimiter block exists, (b) the `---` block fails YAML parsing, (c) any of the three required fields (`version`, `last_modified_utc`, `changelog`) are absent, or (d) `version` is not valid semver (`X.Y.Z`). If frontmatter is missing or malformed: if the file was accessed via direct path (the `$ARGUMENTS` contained a `/`) AND the path does not start with `plans/`: in interactive mode (`manual_mode = true`) use `AskUserQuestion` (Yes/No): "This file has no plan frontmatter — it may not be a technical spec. Run full /plan-craft review anyway?" — proceed only if yes. In autonomous mode (`manual_mode = false`) do not prompt — print `Warning: {path} has no plan frontmatter; adding it and proceeding (autonomous mode).` and proceed. If proceeding (autonomous mode, or user said Yes, or no guard was triggered), add minimal frontmatter:
  ```yaml
  version: 0.1.0
  status: draft
  last_modified_utc: <UTC now>
  changelog:
    - "0.1.0 (<YYYY-MM-DD>): Frontmatter added — plan previously lacked valid frontmatter"
  ```
  and continue. If user answered No, stop without modifying the file.

**Step 3 — Parallel deep research**

> **Agent count rule:** For plans ≤ 2000 lines: launch 3 parallel `Agent` tool calls (Agents A, B, C) in a single response. For plans > 2000 lines: collapse Agents B and C into a single `general-purpose` agent to conserve context — launch 2 parallel Agent calls (Agent A as `Explore`, merged B+C as `general-purpose`). For the merged B+C agent, structure the prompt in two explicit sections: first, instruct it to read all other `.md` files in `plans/` and report conflicting business rules/enum ordinals and any testing/deploy-gate policy (which test layers are gated vs deferred) (Agent B scope); second, instruct it to use WebSearch and Context7 to verify API/event names and framework conventions (Agent C scope). Separate the two sections with a clear heading so the agent's response is similarly structured. One Agent invocation = one agent; do NOT use a single call for all agents.

Print: "Launching research agents for pass {N}..." before spawning the Agent calls.

Before launching sub-agents, read `CLAUDE.md` (project root) to extract:
- **(a) Source paths**: backend source dirs (e.g., `src/`), frontend source dirs (e.g., `angular/src/app/`)
- **(b) Framework names and versions**: e.g., "ASP.NET Core 10, ABP Framework, Angular 19"
- **(c) External service names**: e.g., "Stripe API, Anthropic Claude"
- **(d) Background job base class**: look for mentions of job framework in the Stack section

Pass this context (whether extracted from CLAUDE.md or inferred via fallback) verbatim in each sub-agent's prompt. If `CLAUDE.md` is absent OR lacks a relevant section, fall back to: (a) search common backend source patterns (`src/`, `app/`, `lib/`, or project root) for backend; look for common frontend source patterns (`frontend/`, `web/`, `ui/`, or any directory containing a `package.json`) for frontend; (b) infer frameworks from `*.csproj`, `package.json`, or `requirements.txt` in the project root; (c) treat all named external services in the plan as the list to verify.

For plans larger than 500 lines, include the plan's section boundaries (section name → start/end line numbers, derived from the Read calls in Step 2) in each sub-agent's prompt, so agents can read individual sections using `Read` with `offset` + `limit`. The full-file load requirement of Step 2 applies to the main skill context only — sub-agents for large plans should page through their assigned sections rather than attempting to load the full file.

If any Agent tool call returns an error or fails to complete, log a warning and proceed with the remaining agents' results (document-only review for the failed agent's domain).

- **Agent A (Codebase, `subagent_type: Explore`):** Using the source paths from CLAUDE.md, search for every class, enum, interface, job class, and API endpoint named in the plan. Report: symbols that do not exist, have been renamed, or contradict the plan. Verify background job classes use the framework's correct base class (identified from CLAUDE.md stack). Also report, for each named symbol, whether a corresponding test already exists in the project's test directories — so the plan's `## Testing` section can target genuine gaps rather than re-specify covered behavior.
- **Agent B (Cross-plan, `subagent_type: Explore`):** Read every other `.md` file in `plans/`. Report: shared business rules that differ, enum definitions duplicated with conflicting values, contradictory policy decisions. Also report any testing / deploy-gate policy found in other plans (which test layers are gated vs explicitly deferred or non-gating), so the test-coverage criteria can respect deferral decisions. If a file lacks frontmatter, still check its text content for conflicting business rules or enum definitions — do not report a frontmatter issue (Step 2 handles that separately). If no other `.md` files exist in `plans/`, return "No other plans found — no cross-plan contradictions possible."
- **Agent C (Web/Docs, `subagent_type: general-purpose`):** Read CLAUDE.md's Stack section to identify which frameworks and external services this project uses. Use WebSearch + Context7 to verify that any APIs, event names, permission conventions, and security recommendations mentioned in the plan match current docs for those frameworks and services.

**Step 4 — Apply criteria and checklist**

- For the CODEBASE CONSISTENCY, CROSS-PLAN CONSISTENCY, and WEB VALIDATION checklist sections: use the findings returned by Agents A, B, and C from Step 3 to answer those items. Do not re-run agent searches in Step 4.
- Read `criteria.md` using the `Read` tool: path is `.claude/skills/plan-craft/criteria.md`
- Read `checklist.md` using the `Read` tool: path is `.claude/skills/plan-craft/checklist.md`
- If either `Read` returns an error (file not found, permission denied), print: "Error: .claude/skills/plan-craft/[filename] not found — ensure all three skill files were created before running the skill." and stop.
- Run every criterion against every section of the plan
- Classify each finding:
  - **CRITICAL** — blocks correct implementation (wrong type, contradictory policy, missing required field, wrong class name)
  - **HIGH** — significant gap (unhandled error path, missing invariant, ambiguous requirement, security gap, design principle violation)
  - **MEDIUM** — incomplete detail (missing example, unclear ownership, minor principle violation)
  - **LOW** — noise (YAGNI bloat, duplicate info, over-explained obvious behavior)
- **Exception for newly created plans:** if the plan's current version is `0.1.0` and the changelog contains only the initial `0.1.0` entry (no changes have been applied yet), suppress all findings generated by the `[ ] No TODO, TBD, or placeholder text` item in the EXPLICIT checklist section — they are expected skeleton content. Report all other finding types normally. These placeholders will be flagged once the user fills in the sections and the version advances.

**Step 5 — Identify open questions**

- Separate findings where the correct answer requires a judgment call (business decision, tradeoff, two equally valid options)
- For each open question: propose one specific recommendation with a one-sentence justification
- Label these `OPEN Q` in the findings list

**Step 6 — Decision gate**

- If **zero findings and zero open questions** → call `Bash: date -u +%Y-%m-%dT%H:%M:%SZ` to get the "Last reviewed" timestamp, print "Pass {N}/5 — no findings." (omit this prefix when N = 1 and no changes were applied in this run), then print the "solid" message (see §Output); if the plan's current `status` value is not already `solid` (or the field is absent), use `Edit` to set `status: solid` in the frontmatter — this is the only file change at this step; then run **Step 10** (the end-of-run decision checkpoint) and stop
- Otherwise → proceed to Step 7

**Step 7 — Decide: auto-apply or ask the user**

**Autonomous default (`manual_mode = false`):** skip the human-input check entirely. On EVERY pass (including pass 1) auto-apply ALL findings of every severity (CRITICAL/HIGH/MEDIUM/LOW) **plus all OPEN Q items, answered with their recommended answers** — no `AskUserQuestion`, no severity filtering. For transparency: first print the full findings list (the §Output "Findings list" format), then print the summary line `Pass {N}/5 — autonomous: applying all {total} findings...` (when there is ≥ 1 OPEN Q, append ` ({q} open question(s) auto-answered with the recommended answer)`; omit that clause when {q} = 0), then go to Step 8. The applied set is **all** findings (LOW and OPEN Q included) — do NOT use the CRITICAL/HIGH/MEDIUM-only "If auto-applying" shape below. Skip the rest of Step 7. (OPEN Q recommended answers are written into the plan and recorded in the changelog per Step 8, so they can be reviewed and overridden afterward.)
  - **Track auto-answered decisions for the Step 10 checkpoint.** Each time an OPEN Q is auto-answered in autonomous mode, append an entry to a run-level accumulator `auto_answered_decisions[]`: `{section, question, recommended_answer_applied, touches_schema_billing_or_behavior: bool}`. Set the boolean `true` when the decision adds/changes a DB column, migration, enum, charge/hold/pricing behavior, or any runtime control-flow (these are the decisions whose recommendation should be code-verified before the user accepts it). This accumulator persists across all passes of the current invocation and is consumed once in Step 10. (If the same OPEN Q recurs across passes, keep a single entry with the latest applied answer.)

**Interactive mode (`manual_mode = true`, the `--manual` flag was passed):** check whether this pass requires human input. When it pauses, present the full batch-approval options menu under **If pausing** below (Apply all / Apply CRITICAL+HIGH only / Apply CRITICAL only / Skip all) — exactly the pre-autonomous behavior:
- **Pause and ask** if: there are any OPEN Q items (judgment calls), OR there are any LOW findings (noise removal that may be intentional), OR this is the first pass (pass 1 of N — always show findings to the user on the first pass)
- **Auto-apply** if: pass number > 1, zero OPEN Q items, zero LOW findings, and only CRITICAL/HIGH/MEDIUM findings remain

**If pausing (ask the user):**
- Print the full findings list as text (all severities, all open questions, with recommendations)
- Print: "Pass {N}/5. Skipped findings will reappear unless fixed manually."
- Use `AskUserQuestion` (single-select). Only show options where finding count > 0. Maximum 4 options — always include "Skip all":
  1. "Apply all {total} findings" (if any OPEN Q items are present, append: " — open questions answered with recommended answers")
  2. "Apply CRITICAL and HIGH only ({count} findings)" — skips MEDIUM, LOW, and OPEN Q
  3. "Apply CRITICAL only ({count} findings)" — minimal safe changes
  4. "Skip all — I'll make manual edits"

  In option 1, `{total}` is the full count including OPEN Q; option 1 is never omitted as long as there is at least one finding or open question. In options 2 and 3, `{count}` is the count for that severity tier only. Relabeling rule: if no CRITICAL findings exist but HIGH findings do, rename option 2 to "Apply HIGH only ({count} findings)". If no CRITICAL findings, option 3 is omitted (zero count). If no HIGH either, option 2 is omitted (zero count). Also omit option 3 when ALL findings are CRITICAL (zero HIGH, MEDIUM, LOW, OPEN Q) — in that case "Apply CRITICAL only" is identical in effect to "Apply all." Deduplication rule: after renaming, if option 2 would apply the exact same finding set and count as option 1, omit option 2 (option 1 is kept). This occurs when all findings are HIGH (no CRITICAL/MEDIUM/LOW/OPEN Q): option 2 renames to "Apply HIGH only (N)" which equals option 1 "Apply all (N)". After omitting any options, renumber the remaining options sequentially (1, 2, ... N) without gaps before passing to AskUserQuestion. **Special case — all findings are a single severity tier** (e.g., all CRITICAL only, or all HIGH only, or all MEDIUM only): renaming and deduplication rules collapse to option 1 ("Apply all {total} findings") plus "Skip all" — options 2 and 3 are both omitted. AskUserQuestion receives 2 options in this case. **OPEN Q-only case** (zero CRITICAL/HIGH/MEDIUM/LOW, only OPEN Q): options 2 and 3 are both omitted. AskUserQuestion receives 2 options: "Apply all {total} findings (with recommended OPEN Q answers)" / "Skip all — I'll fix manually." **Edge case — if deduplication somehow eliminates all substantive options (theoretically impossible since option 1 is never omitted):** auto-apply all findings without AskUserQuestion.

- OPEN Q items are included **only** in "Apply all", using the recommended answer. Severity-filtered batches exclude OPEN Q entirely.

**If auto-applying (no user input):**
- Print: "Pass {N}/5 — auto-applying {count} findings (no judgment calls required)..."
- Apply all CRITICAL, HIGH, and MEDIUM findings using the recommended fix for each. Major version bump handling (structural-rewrite confirmation) is delegated to Step 8.
- **Note on skipped categories:** auto-iteration applies all remaining CRITICAL/HIGH/MEDIUM findings regardless of which tiers the user chose to skip in a prior interactive pass. For example, if the user chose "Apply CRITICAL only" in pass 1, pass 2 will automatically apply any remaining HIGH findings without further user input.

**Step 8 — Apply changes**

- Apply the chosen or auto-determined set of findings
- For OPEN Q in the batch: write the recommended answer (user can override by editing then re-running)
- After all edits, re-run the agent-independent checklist sections only (FRONTMATTER, REFERENCES, IMPLEMENTATION COMPLETENESS, FAIL-FAST, IDEMPOTENCY & RETRY, OBSERVABILITY, SECURITY, SINGLE SOURCE OF TRUTH, EXPLICIT, DRY, KISS, API VERSIONING, CONVENTION OVER CONFIGURATION, INTERFACE SEGREGATION & SERVICE COHESION, COMPOSITION OVER INHERITANCE, STATELESS SERVICES, CONTRACT-FIRST, TRANSACTIONS, MIGRATIONS, GRASP/GoF items, YAGNI, TEST COVERAGE [structural items only — section exists, edge/error enumerated, layer/project named, Test → Acceptance mapping, gate named; codebase-derived edge cases defer to the next full pass with CODEBASE CONSISTENCY], VERIFICATION) against every section that was modified in this pass as a self-check — do not re-spawn sub-agents (CODEBASE CONSISTENCY, CROSS-PLAN CONSISTENCY, WEB VALIDATION are excluded; their re-check is deferred to the next full pass):
  - If the self-check finds one or more new inconsistencies: in autonomous mode (`manual_mode = false`), apply ALL of them automatically with no prompt. In interactive mode (`manual_mode = true`), print ALL of them clearly as a numbered list and use one additional `AskUserQuestion` (Yes/No): "{N} inconsistency/inconsistencies found during self-check. Apply all now?" — if Yes, apply ALL self-check findings as a batch; if No, skip all. Include the highest severity from all applied self-check findings in the current pass's version bump calculation. **Skipped self-check findings are not permanently dropped** — they will be re-discovered on the next pass (pass N+1 runs Step 3 → full checklist).
  - The self-check runs exactly once per pass. Self-check findings that are applied do not re-trigger another self-check. Their severity classification uses the same criteria as Step 4 for version bump purposes. If a self-check finding is applied, include its severity in the current pass's version bump calculation (highest applicable bump across all applied findings including self-check fixes wins).
- Calculate new version from the applied findings:
  - **Universal rule: the highest applicable bump wins — major > minor > patch. This covers all combinations including self-check fixes.**
  - Any CRITICAL or HIGH applied → bump **minor** (1.5.18 → 1.6.0)
  - MEDIUM or LOW only → bump **patch** (1.5.18 → 1.5.19)
  - OPEN Q items applied (no CRITICAL/HIGH/MEDIUM in the same batch) → bump **patch**
  - **Bump reset rule (semver):** when bumping minor, reset patch to 0 (e.g., `1.5.18 → 1.6.0`). When bumping major, reset both minor and patch to 0 (e.g., `1.5.18 → 2.0.0`).
  - Structural rewrite replacing ≥ 3 `##` (H2) sections entirely (defined as: section's prior body content is fully removed AND entirely new content is added with no shared lines) → bump **major**. In autonomous mode (`manual_mode = false`): proceed with the major bump automatically — no confirmation. In interactive auto-apply mode (`manual_mode = true`, pass > 1): pause and use `AskUserQuestion` (Yes/No) to confirm before proceeding; if the user declines, skip the structural-rewrite findings but apply the remaining CRITICAL/HIGH/MEDIUM findings using the highest applicable bump. In interactive approved mode (`manual_mode = true`, pass 1 or any pass where the user explicitly approved "Apply all"): proceed without an extra confirmation — the user's approval is sufficient. Adding new content within a section, or partially rewriting it, does not count. When uncertain, default to minor bump and note it in the changelog.
  - Pre-1.0 major bump: if the current version is 0.x.y and a structural rewrite triggers a major bump, the new version is 1.0.0 (semver increments the first component from 0 to 1, resets minor and patch to 0).
- Get UTC timestamp: `Bash` → `date -u +%Y-%m-%dT%H:%M:%SZ`
- Update `last_modified_utc` in the frontmatter to this same timestamp.
- Prepend new `changelog` entry **as a double-quoted YAML string**: `- "{new_version} ({YYYY-MM-DD}): {one-sentence summary of all applied changes}"`. Always wrap the entire entry in double quotes and escape any literal `"` in the summary as `\"` (and any `\` as `\\`). This is mandatory: the `{version} (date): summary` shape contains a `: ` (and summaries often contain more, e.g. `HIGH: …`, `(§2.2: …`), which a **strict** YAML parser — such as VS Code's markdown frontmatter preview — reads as a nested mapping and rejects ("Nested mappings are not allowed in compact mappings" / "mapping values are not allowed in this context"). Quoting makes each entry a plain string. **Also quote any pre-existing `changelog:`/`changelog_archive:` entries that are not already double-quoted in the same write** (semantics-preserving) so the whole block converges to valid strict-YAML. Do NOT quote `*_touched_sections` list items — those are `- section:` mappings and must stay as mappings.
- Print: "Changelog entry added."
- Add `v{semver_nodots}_touched_sections` block (e.g. `v160_touched_sections`) listing every section modified in this pass — including both the initial batch and any self-check fixes that were applied. The `section` value format is `{§N.X} {heading text}` — the §N.X notation followed by the heading text exactly as it appears in the plan:
  ```yaml
  v160_touched_sections:
    - section: "§6.B Stripe Handler"
      type: modified          # one of: added | modified | removed
      summary: "Fixed event name invoice.payment_succeeded → invoice.paid"
    - section: "§8.3 Legacy Overage Language"
      type: removed
      summary: "Removed — superseded by fail-fast wording in §6"
  ```
  The `type` field is required so `/plan-sync` can color-code additions, modifications, and removals without fallback text-diffing. This applies to ALL version bumps including 0.x.x versions — e.g., version 0.2.0 produces key `v020_touched_sections`.
  Section notation: `§N` identifies the H2 section by sequential position (1, 2, …); H3 sub-sections use `.B`, `.C`, etc. (letter suffix) or `.1`, `.2`, etc. — use whichever matches the plan's existing heading numbering, or assign sequential labels if the plan has none.
  Type assignment rules: use `added` when a section or sub-section heading did not previously exist; `removed` when a section is deleted entirely; `modified` for all other content changes within an existing section.
  Key collision detection: before writing the new key, scan all existing frontmatter keys matching `v{...}_touched_sections` for a matching stem. If a key with the same `v{semver_nodots}` stem already exists (from a prior version collision), append the next available letter suffix to the new key.
  Key collision suffix rule: the newly-written key for the current pass receives the suffix (never rename existing keys retroactively). Subsequent collisions use the next letter: `a`, `b`, `c`, … `z`; beyond `z`, use two-letter suffixes `aa`, `ab`, etc.
- After prepending the new changelog entry, check if the changelog list now exceeds 50 entries. If so, move the oldest 10 to a `changelog_archive:` YAML key within the frontmatter block (before the closing `---`); keep it as a proper YAML list. One "entry" = one top-level list item (`- ` prefix) regardless of line continuation. The `changelog_archive:` key accumulates across multiple archive events — always prepend newly archived entries before existing ones. There is no size limit on `changelog_archive:`.
- Always include `status: draft` in the frontmatter write (Step 8 is only reached when findings were applied — the plan is not solid until the next pass declares zero findings in Step 6).
- When writing frontmatter via `Edit` or `Write`, preserve ALL existing frontmatter fields that were not modified in this pass — specifically: `notion_page`, `confluence_page`, `notion_subpages`, `confluence_subpages`, `notion_synced_version`, `confluence_synced_version`, `last_synced`, and any other fields added by plan-sync or external tools. The replacement must include all existing frontmatter fields verbatim alongside the fields being updated.
- Write the updated file using a **single** `Edit` (or `Write` when ≥ 5 non-contiguous sections are modified in a single pass, or when both frontmatter and multiple body sections change). Accumulate all body changes AND the frontmatter update before writing — do not apply body edits and frontmatter edits as separate sequential tool calls. A failure between them would leave the file in an inconsistent state (updated body, stale version/changelog). If `Edit` or `Write` fails (file locked, concurrent modification, etc.), print an error ("Failed to write updated plan: {error}"), do not finalize changelog or version bump, and stop — the user must resolve the conflict and re-run.

**Step 9 — Loop or stop**

- The pass counter tracks the CURRENT pass number (initialized to 1 before pass 1 runs; displayed as "Pass N/5" in output).
- Note: the "solid" case (zero findings) is handled by Step 6 — execution stops there and never reaches Step 9.
- After the current pass completes, check termination conditions in order:
  1. (`--manual` only) The user selected "Skip all" at Step 7 → print "Pass {N}/5 — {count} findings skipped. Run /plan-craft again to review them." then run **Step 10** and stop; do not auto-iterate
  2. Pass counter = 5 → print "Reached 5 passes. Run /plan-craft again to continue." then run **Step 10** and stop ← this fires after pass 5 completes, meaning 5 full passes ran
  3. None of the above → increment pass counter by 1 and continue to Step 3 for the next pass (loop termination cases: conditions 1–2 above, or Step 6's solid gate)
- **Whenever the run terminates** — via condition 1 or 2 here, **or** via Step 6's solid gate — run **Step 10** (the decision checkpoint) immediately before the final stop, then stop.

**Step 10 — End-of-run decision checkpoint (autonomous mode only)**

- **Applies only when `manual_mode = false`.** In `--manual` mode the user already approved each batch (OPEN Q are only applied via an explicit "Apply all"), so skip Step 10 entirely.
- If `auto_answered_decisions[]` is **empty** (no OPEN Q was auto-answered this run), end silently as today — do not prompt.
- Otherwise, print a consolidated block titled `Decisions auto-answered this run (review):` listing each accumulator entry as `  §{section}  {question} → applied: {recommended_answer}` (mark entries with `touches_schema_billing_or_behavior = true` with a leading `⚠ ` so the high-stakes ones stand out).
- Then present **one** `AskUserQuestion` (single-select, 3 options + auto "Other"):
  1. **"Accept all auto-answered decisions"** — the recorded answers stand; end the run.
  2. **"Revisit specific decisions"** — ask the user (free-text follow-up) which by §section/number; for each named decision, discuss and apply any override the user gives.
  3. **"Investigate before deciding (code-grounded)"** — for every entry with `touches_schema_billing_or_behavior = true` (and any the user names), spawn a focused `Explore`/`general-purpose` `Agent` to verify the recommendation against the actual code/docs, present what the investigation found (explicitly flag any recommendation the evidence **contradicts**), then let the user confirm or override each.
- **Applying overrides / investigation outcomes:** any resulting edits go through Step 8's write + version-bump + changelog machinery as a final mini-pass — bump by the highest severity of the changed content (a pure OPEN Q answer swap with no CRITICAL/HIGH/MEDIUM content change = patch; a change that rewrites billing/runtime behavior = minor), add a changelog entry and a `v{semver_nodots}_touched_sections` block, and write once. If the user picks "Accept all" (or chooses to override nothing), make no edits and do not bump.
- Step 10 runs **once** per invocation. Its own AskUserQuestion is the only end-of-run prompt; it does not re-trigger the Step 3 loop.

---

## §Output

### When solid (no changes):
```
Plan is solid — no changes made.
Version: 1.5.18  |  Last reviewed: 2026-05-01T14:32:00Z  |  Completed in {N} passes.

Reviewed: {N} checklist items across {S} sections.
No findings.
```
(If solid on pass 1 with no changes applied in this run, omit "Completed in N passes" and show only the version and timestamp. "Completed in N passes" appears when ≥ 2 passes executed in this run; N = total passes that executed Step 3 (research phase) in this invocation, including the final pass where zero findings were found. Passes where "Skip all" was chosen are counted if Step 3 ran. Example: if pass 1 applied changes and pass 2 declared solid, show "Completed in 2 passes.")

### Findings list (printed in Step 7 — before the `AskUserQuestion` in `--manual` mode; before auto-applying in autonomous mode):
```
Findings (6):
  CRITICAL  §6.B  Stripe invoice.payment_succeeded → invoice.paid (renamed in Stripe API 2024-06)
  HIGH      §11   Scenario #38 references non-existent enum UsageEventKind.BundleRefund
  HIGH      §6.M  Observer event handler for billing is async — failure silently loses usage record
  MEDIUM    §3.2  Bundle price $0.80 contradicts §4.3 cost model — unified to $1.00
  LOW       §9    "May add AI image upscaling in phase 3" — no trigger defined (YAGNI)
  OPEN Q    §5.1  BillingAccount state machine missing Payg→Free transition
            ↳ Recommendation: add transition triggered by balance reaching zero

Note: skipped findings will reappear on the next run unless fixed manually.
```

### After changes applied (`--manual` user-approved pass):
```
Plan updated: 1.5.18 → 1.6.0  |  2026-05-01T14:32:00Z

Pass 1/5 — Applied: CRITICAL + HIGH batch (3 of 6 findings)
Skipped: 3 (MEDIUM, LOW, OPEN Q)

Changelog entry added. Launching research agents for pass 2...
```

### Autonomous mode (default, no `--manual`) — pass output:
```
Findings (6):
  CRITICAL  §6.B  Stripe invoice.payment_succeeded → invoice.paid
  HIGH      §11   Scenario #38 references non-existent enum UsageEventKind.BundleRefund
  MEDIUM    §3.2  Bundle price $0.80 contradicts §4.3 cost model — unified to $1.00
  LOW       §9    "May add AI image upscaling in phase 3" — no trigger (YAGNI)
  OPEN Q    §5.1  BillingAccount missing Payg→Free transition
            ↳ applying recommended: add transition triggered by balance reaching zero

Pass 1/5 — autonomous: applying all 6 findings (1 open question auto-answered with the recommended answer)...

Plan updated: 1.5.18 → 1.6.0  |  2026-05-01T14:32:00Z
Changelog entry added. Launching research agents for pass 2...
```

### Auto-iteration pass output:
```
Pass 2/5 — auto-applying 2 findings (no judgment calls required)...
  MEDIUM  §3.2  Bundle price $0.80 unified to $1.00
  MEDIUM  §7    Missing log level for token-exceeded path

Plan updated: 1.6.0 → 1.6.1  |  2026-05-01T14:32:05Z

Pass 3/5 — auto-applying 1 finding...
  MEDIUM  §11   Added verification scenario #43 for token-exceeded path

Plan updated: 1.6.1 → 1.6.2  |  2026-05-01T14:32:10Z

Pass 4/5 — no findings.
Plan is solid — no changes made.
Version: 1.6.2  |  Last reviewed: 2026-05-01T14:32:10Z  |  Completed in 4 passes.
```

### Auto-pass finds only LOW/OPEN Q (`--manual` mode — requires user decision):
```
Pass 2/5 — found 2 items requiring your decision (cannot auto-apply):
  LOW     §9    "May add AI image upscaling in phase 3" — no trigger defined (YAGNI)
  OPEN Q  §5.1  BillingAccount state machine missing Payg→Free transition
          ↳ Recommendation: add transition triggered by balance reaching zero

Pass 2/5. Skipped findings will reappear unless fixed manually.
[AskUserQuestion: Apply all 2 items (with recommended OPEN Q answers) / Skip all — I'll fix manually]
```

### Max iterations reached:
```
Reached 5 passes. Last version: 1.7.0.
Run /plan-craft billing again to continue.
```

### End-of-run decision checkpoint (Step 10 — autonomous mode, when OPEN Q were auto-answered):
```
Decisions auto-answered this run (review):
⚠ §9.1  Correlation id location → applied: new ContentBlock.GenerationCorrelationId column
⚠ §9.4  Hold on resume → applied: full re-hold (simple)
  §9.5  Retry vs Regenerate UX → applied: two distinct actions

These were answered with the recommended default, not your explicit decision.
[AskUserQuestion: Accept all / Revisit specific decisions / Investigate before deciding (code-grounded)]
```

### When a new plan is created:
```
Created: plans/content-moderation-plan.md (v0.1.0)
Launching research agents for pass 1...
[proceeds to findings output]
```

### When no plan name given:
```
Plans in plans/:
  billing-and-monetization-plan.md   v1.5.18  (2026-05-01)  [solid]
  secrets-management-plan.md         v1.1.0   (2026-04-28)  [draft]
  public-seo-site-plan.md            v0.9.2   (2026-04-25)  [draft]
  rename-seowrite-plan.md            v1.0.0   (2026-04-20)  [—]

Usage: /plan-craft <plan-name>
```
(The date shown is the YYYY-MM-DD portion of `last_modified_utc` from each plan's frontmatter. The version is the `version` field. The status column shows the `status` frontmatter value in brackets: `[solid]` or `[draft]`; show `[—]` when the field is absent. All three values are read directly from frontmatter — do not parse the changelog to derive them. For files with missing or invalid frontmatter, show `v—` for version, `—` for date, and `[—]` for status with a `(no frontmatter)` annotation.)

---

## Edge Cases

| Case | Behaviour |
|------|-----------|
| **Default (no `--manual`)** | Autonomous: apply ALL findings (incl. LOW + OPEN Q with recommended answers) every pass, no prompts; iterate until solid or 5 passes |
| **`--manual` flag passed** | Interactive: print findings and use the batch-approval `AskUserQuestion` gates described in Steps 7–8 |
| No argument | List plans in `plans/` and stop |
| `plans/` does not exist | Create it with `mkdir -p plans`, then proceed |
| `plans/` exists but contains no `.md` files (no argument) | Show empty list + "Usage: /plan-craft \<plan-name\>" and stop |
| `plans/` exists but contains no `.md` files (argument given) | Skip file search; go directly to create-new path (Call A "List" option shows "no plans yet") |
| No match for plan name | `AskUserQuestion`: create new plan or list existing |
| Multiple matches (≤ 4) | `AskUserQuestion` to pick |
| Multiple matches (> 4) | Print all as text, prompt user to re-run with a more specific name, and stop |
| Plan name is a full path | Accept directly without search |
| New plan created | Run full review immediately after creation |
| Codebase Agent tool call fails or returns error | Log warning, continue with document-only review for that agent's domain |
| Web research returns nothing | Log warning, skip web validation, note in output |
| Large plan (> 500 lines) | Sub-agents review section by section; note in sub-agent prompt |
| Self-check after edit finds new issue | One additional `AskUserQuestion` (Yes/No) before finalizing write (`--manual` only; autonomous applies automatically) |
| Changelog > 50 entries | Move oldest 10 to a `changelog_archive:` YAML key within the frontmatter block (before closing `---`) |
| User selects "Skip all" | Print findings list; do not modify file; stop (no auto-iteration) (`--manual` only) |
| Plan is not a technical spec | `--manual`: warn and ask user to confirm before running full review; autonomous: warn and proceed (detected in Step 2 when file accessed via direct path outside `plans/` has no frontmatter) |
| Auto-iteration stopped by OPEN Q/LOW on pass 2+ | Step 7 pauses (not auto-applies) and shows `AskUserQuestion`; user decides in-place — no need to re-run (`--manual` only) |
| Auto-iteration: max 5 passes reached | Print summary and stop; user re-runs if more passes needed |
| Major version bump needed in auto-pass | Pause and ask user to confirm even mid auto-iteration (`--manual` only; autonomous proceeds automatically) |
| CRITICAL/HIGH findings AND structural rewrite in same pass | Major bump wins (highest applicable bump: major > minor > patch) |
| `v{semver_nodots}` key collision (e.g. versions `1.0.10` and `10.1.0`) | Append letter suffix to disambiguate: `v1010a_touched_sections` |
| Autonomous run auto-answered ≥ 1 OPEN Q | At end of run (solid, "Skip all", or 5-pass stop) run **Step 10**: list the auto-answered decisions and offer Accept all / Revisit / Investigate-before-deciding. Skipped entirely in `--manual` mode and when no OPEN Q was auto-answered. |
| `status` field lifecycle | `draft` — set in new-plan template, in malformed-frontmatter fallback, and by Step 8 whenever findings are applied. `solid` — set by Step 6 (via `Edit`) only when zero findings remain. `completed` — set manually when plan is shipped and moved to `plans/completed/`. If a plan has no `status` field it is treated as `draft`; the field is written on the next plan-craft run that either applies findings (→ `draft`) or finds nothing (→ `solid`). |
