Systematic per-pass checklist — every item checked on every run.

**Note for reviewer:** Items in the CODEBASE CONSISTENCY and WEB VALIDATION sections are parameterised by the project's CLAUDE.md. The CLAUDE.md context loaded in Step 3 is valid for all passes — re-reading it on subsequent passes is safe but unnecessary. Identify from it: source paths, framework names, external services, and naming conventions. Skip items that don't apply to the current plan (no background jobs → skip job-class checks; no external payments → skip payment API checks). Skip silently — do not report "not applicable" as a finding.

FRONTMATTER
[ ] version, last_modified_utc, and changelog all present and consistent
[ ] For each version in changelog after 0.1.0 (excluding v0.1.0 itself — the initial skeleton has no applied changes) where changes were applied: a corresponding v{semver_nodots}_touched_sections key must exist (key pattern: `v\d+[a-z]*_touched_sections` to match optional letter suffixes from collision disambiguation)
[ ] version string is valid semver (X.Y.Z)
[ ] last_modified_utc is valid ISO-8601 UTC (ends with Z)
[ ] Every changelog (and changelog_archive) entry is a double-quoted YAML string — flag any unquoted `- {version} (date): …` entry, since its `: ` breaks strict YAML parsers (e.g. VS Code's frontmatter preview). Fix = wrap in double quotes, escaping interior `"`. Do NOT flag `*_touched_sections` items (those are `- section:` mappings).

REFERENCES
[ ] All §-references in the document resolve to actual sections that exist in the file
[ ] All §-references in changelog entries resolve to actual sections
[ ] No "see above" or "see below" without a §-reference

CODEBASE CONSISTENCY (Agent A — paths and framework names from CLAUDE.md)
[ ] Every class/entity named in the plan exists in the project's source directories
[ ] Every enum value named matches the shared domain layer files exactly
[ ] Every background job class uses the correct framework base class (identified from CLAUDE.md stack)
[ ] Every API endpoint path follows the project's routing convention (identified from CLAUDE.md)
[ ] Every frontend component name exists in the project's frontend source path

CROSS-PLAN CONSISTENCY (Agent B)
[ ] No business rule contradicts any other plan in plans/
[ ] No enum redefined with different ordinal values from another plan's definition of the same enum

WEB VALIDATION (Agent C — frameworks and services from CLAUDE.md Stack section)
[ ] All external service API method/event names match current docs for those services
[ ] Framework permission/routing/job naming conventions match current framework docs
[ ] Any named security recommendation (OWASP, CSP, etc.) matches current guidance

IMPLEMENTATION COMPLETENESS
[ ] Every feature section: input shape, output shape, error cases, entity names, implementation pattern
[ ] Every async job: names the framework's job class and its args type (from CLAUDE.md stack)
[ ] Every API endpoint: method, full versioned path, permission name, all response codes
[ ] Every UI interaction: component name and its binding mechanism (reactive form, model binding, or equivalent for the project's frontend framework)

SINGLE RESPONSIBILITY (SOLID-S)
[ ] Each §N covers exactly one concept; no section mixes business rules with implementation detail in the same block

FAIL-FAST
[ ] Validation layer named for each constraint (controller vs service vs DB)
[ ] Fail-fast constraints at earliest possible layer
[ ] Jobs distinguish terminal / transient / non-fatal error types
[ ] Long-lived operations specify a maximum duration before forced timeout

IDEMPOTENCY & RETRY
[ ] Every external call: idempotency strategy, timeout, retries, backoff, error classification

OBSERVABILITY
[ ] Log level stated for every state transition and external call
[ ] Correlation ID propagation mentioned for all async flows
[ ] PII / API keys excluded from log spec
[ ] Compliance-sensitive mutations specify an audit log entry format

SECURITY
[ ] Each operation lists its read/write entity scope
[ ] Each endpoint specifies its permission/authorization name (framework convention from CLAUDE.md)
[ ] Multi-layer validation present for user-facing mutations
[ ] Webhook payloads contain no sensitive data beyond what the consumer requires

SINGLE SOURCE OF TRUTH
[ ] No field in multiple entities without explicit authority + invalidation rule
[ ] No enum/constant defined in more than one layer without an explicit sync note

EXPLICIT
[ ] No "sensible defaults" without naming the value and type
[ ] No TODO, TBD, or placeholder text
[ ] All optional fields declare their omission behavior

DRY (NO REPEATED DEFINITIONS)
[ ] No enum, entity shape, or policy rule defined in more than one section — all other sections cross-reference by §N
[ ] No duplicate field in two entities without declaring which is authoritative and which is a cached copy

KISS (NO OVER-ENGINEERING)
[ ] No factory, strategy, or mediator pattern with only one concrete implementation now (≥ 2 concrete variants required to justify the pattern)

DOMAIN TYPE MODELING
[ ] No field/DTO property/job-input key typed as `string` when its values are a closed, code-owned set (status/kind/tone/tier/mode/type) — model as `enum` (open/free text, external IDs, and lookup-table sets stay string)

API VERSIONING & BACKWARD COMPATIBILITY
[ ] All new endpoints include version in path (e.g., /api/v1/)
[ ] New optional fields on existing DTOs document the default value for old clients
[ ] Breaking changes (field removal, rename, enum value change) marked and accompanied by a migration path

CONVENTION OVER CONFIGURATION
[ ] Shared patterns (retry policy, log format, callback contract) defined once and referenced — not repeated per job
[ ] Naming conventions stated once in a shared § and not restated per section

INTERFACE SEGREGATION & SERVICE COHESION (SOLID-I/O/D)
[ ] No fat interface/AppService bundling unrelated responsibilities (CRUD + bulk + events + reporting on one service) — split by responsibility
[ ] No planned service with > ~8 collaborators/repositories without a named split (extract service / facade / domain-event publisher)
[ ] High-level sections depend on an interface seam, not a concrete class, where one exists (Dependency Inversion)
[ ] No discriminator switch/if-else destined to grow when an extension seam fits and ≥ 2 variants exist now (Open/Closed)

COMPOSITION OVER INHERITANCE
[ ] Shared behavior implemented via injected services/interfaces, not base class fields
[ ] Background jobs use the framework's base class (from CLAUDE.md); logic delegated to injected services, not placed in the base class body

STATELESS SERVICES
[ ] No service stores per-request state in fields
[ ] Each job invocation reads fresh state from DB; no in-memory cache shared across retries
[ ] The plan addresses what happens when the same job runs concurrently on two nodes

CONTRACT-FIRST
[ ] All DTO fields documented with type, required/optional, and validation constraints
[ ] All enum values tied to explicit ordinal integers matching across backend and frontend layers
[ ] All response codes mapped to error types

TRANSACTIONS
[ ] Transaction boundaries named (EF SaveChangesAsync, or equivalent for the project's ORM — identified from CLAUDE.md stack)
[ ] Fire-and-forget operations explicitly labelled
[ ] Compensating actions defined for non-atomic multi-step operations

MIGRATIONS
[ ] Every new or modified entity has a corresponding EF migration file specified (or equivalent for the project's ORM)
[ ] Deployment order stated for schema changes (migrate-first policy, feature-flag gate, or blue-green)
[ ] Existing-row backfill strategy specified for new non-nullable columns
[ ] Rollback plan stated for destructive changes (column removal, table drop, rename)

GRASP: LOW COUPLING
[ ] No entity references external SDK types directly
[ ] Removing one entity does not require changing ≥ 3 others

GRASP: HIGH COHESION
[ ] No service with ≥ 5 unrelated public methods
[ ] No entity accumulating unrelated concerns

GRASP: INFORMATION EXPERT
[ ] Operations placed in the class that owns the required data

GRASP: PROTECTED VARIATIONS
[ ] Every external SDK dependency sits behind an interface in the domain

GoF: STRATEGY
[ ] ≥ 2 concrete variants with same signature → shared interface named

GoF: OBSERVER
[ ] Domain events specify synchronous vs asynchronous; failure modes for billing/audit events named

GoF: FACADE
[ ] No client required to call ≥ 3 endpoints in sequence for one user action

GoF: CHAIN OF RESPONSIBILITY
[ ] Multi-guard pipelines specify short-circuit behaviour and failure semantics

GoF: STATE
[ ] Every Status enum has a complete transition table including back-to-baseline transitions

GoF: SINGLETON
[ ] Singleton services with mutable state have a thread-safety note

YAGNI
[ ] No feature gated on "phase 2" without a defined trigger
[ ] No factory or Strategy with only one concrete implementation
[ ] No "might be needed" patterns

TEST COVERAGE (code-writing plans only — the plan is a build spec for new/changed code; see criteria "Test Coverage & Testability". Skip silently for ops/infra/config/runbook/research and analysis/gap/status/roadmap docs that only reference or audit existing code)
[ ] A dedicated Testing section exists — H2 heading `Testing`, allowing a leading number / trailing qualifier (`## 11. Testing (xUnit)`, `## Testing Checklist` count) — distinct from ## Verification; an existing test-scenario section under another heading satisfies this (rename/consolidate, do not duplicate)
[ ] Every feature/use case the plan adds or changes has ≥ 1 numbered happy-path test scenario
[ ] Edge cases AND error/failure paths are enumerated as scenarios — not only happy paths (boundary/empty/null/limit, ordering, concurrency, idempotent re-invocation; invalid input, external-call failure terminal-vs-transient, timeout, cancellation, permission denied)
[ ] Each scenario names its test type/layer and target test project for the layers the project gates (e.g. xUnit *.Tests, ABP integration test, gated Angular *.spec.ts — from CLAUDE.md); a layer recorded as deferred/non-gating in a canonical plan or CLAUDE.md is noted as deferred, not flagged
[ ] Each acceptance criterion / verification item is proven by ≥ 1 test scenario, and no scenario proves nothing (explicit Test → Acceptance mapping present)
[ ] The test gate command is named (e.g. dotnet test / a gated ng test)

VERIFICATION
[ ] Every new or significantly changed section has a matching numbered scenario — code-writing sections are covered by ## Testing (above; not re-flagged here); ops/infra sections have a manual/operational verification step (deploy check, smoke test)
