What "good" means for a developer-facing plan consumed by Claude Code.

> **Note:** Examples below use class names and patterns from a specific project (ABP.IO + Stripe + Angular) to illustrate each principle. The principles themselves apply to any project and tech stack — substitute with your project's equivalents as identified from CLAUDE.md.

---

### Core Four

**Single Responsibility (SOLID-S):** each §N covers exactly one concept; no mixed business + implementation concerns in the same block.

**No Repeated Definitions (DRY):** enums, entity shapes, policy rules defined once; all other sections cross-reference by §N.

**No Speculative Design (YAGNI):** no "might be useful later", "phase 3 optional", or multi-phase features without a defined trigger. A factory with only one concrete product is YAGNI. A Strategy with only one concrete implementation is YAGNI.

**No Over-Engineering (KISS):** patterns chosen must match actual complexity. A factory/strategy/mediator requires ≥ 2 concrete variants that exist now.

---

### Implementation Completeness

- Every feature section has: input shape, output shape, all error cases, entity/field names, and the specific framework/ORM/frontend pattern to use (identified from CLAUDE.md stack)
- Every async operation names the background job class (the correct base class is identified from CLAUDE.md stack) and its args type
- Every UI interaction names the frontend component and its binding (reactive form field, ngModel, or equivalent for the project's framework)
- Every API endpoint: HTTP method, full versioned path (e.g. `/api/v1/…`), framework permission name (e.g., ABP.IO permission string, Spring Security role — per CLAUDE.md), all response codes

---

### Fail-Fast

- Input validation rules must identify which layer executes them (controller DTO → service guard → DB constraint); fail as early as possible
- Startup checks that would silently degrade at runtime must fail loudly at startup instead
- Every job must distinguish: terminal errors (fail job immediately, no retry) vs transient errors (retry with backoff) vs non-fatal errors (log + continue)
- Long-lived operations must specify a maximum duration before forced timeout

---

### Idempotency & Safe Retry

- Every job calling an external service must declare its idempotency strategy (idempotency key, hash, or request-id)
- Every external call must specify: timeout value, max retries, backoff strategy, and transient vs permanent error classification
- State transitions must define what happens on second invocation (last-write-wins, conflict, or idempotent skip)

---

### Observability

- Every state transition and external call must name the log level (INFO / WARN / ERROR)
- Async operations must specify correlation ID or trace context propagation
- Compliance-sensitive mutations must specify the audit log entry format
- Sensitive data (PII, API keys, AI prompts in full) must not appear in standard logs — use DEBUG level only

---

### Security (Least Privilege + Defense in Depth)

- Each operation lists exactly which DB entities/fields it reads and writes — nothing broader
- Each API endpoint specifies its framework permission name (e.g., ABP.IO permission string, Spring Security role, etc.) and any additional service-layer auth check
- Multi-layer validation required for all user-facing data mutations (DTO validation + service guard + DB constraint)
- No sensitive data in webhook payloads beyond what the consumer requires

---

### Single Source of Truth

- When a field appears in multiple entities, the plan must declare which is authoritative and which is a cached copy, plus the invalidation rule
- Enums and constants defined once in the project's shared domain layer (identified from CLAUDE.md); no duplication in DTOs or frontend without an explicit sync note

---

### Persistence Shape (JSON column vs relational table)

> Applies to code-writing plans that introduce a new place to store structured, multi-field data (a list/object per parent row). Surface a finding only when the plan **picks one shape without weighing the other**, or picks the shape the heuristic argues against — not as a blanket rule. There is **no default "avoid JSON in columns"**; both shapes are correct in their lane.

- A plan storing a structured collection/object must **state** whether it lives in a serialized column (JSON/JSONB) or its own table/child entity, **and why** — an unjustified pick is a **MEDIUM** finding.
- **Lean to a relational table / child entity when** any of: the inner fields are query/filter/sort/aggregate/join targets in SQL; rows have an independent lifecycle (individually edited, added, or deleted — e.g. a user-facing review/edit feature); the data feeds analytics or reporting; the collection is unbounded; or inner items need their own FK/uniqueness/referential integrity.
- **Lean to a serialized column when** the blob is a **value-object snapshot**: written/replaced wholesale, always loaded with its parent, read-only or atomically-overwritten, bounded in size, with no need to query inner fields relationally. Forcing such a blob into a table adds an aggregate + repository + DTO + join for no consumer (over-normalization is as real a defect as under-normalization).
- **On PostgreSQL prefer `jsonb` over `text`** for any JSON that is kept as a column — it validates on write and stays GIN-indexable/queryable later, so a column choice does not foreclose querying. Flag a plan that specifies a plain `text`/`nvarchar(max)` column for JSON on a Postgres project (**LOW**).
- **Matching an existing JSON-column convention is a valid reason to reuse it**, but is **not** sufficient when this data has a near-term relational consumer the convention-bearer lacked — name the consumer and the promotion trip-wire.

---

### Domain Type Modeling (enum vs string for a closed value set)

> Applies to code-writing plans that introduce a new field, DTO property, or job-input
> key. Surface a finding only when the plan types as a **string** a value whose set is
> **closed and code-owned** — not as a blanket rule. Open/free text stays a string.

- A field whose value comes from a **fixed, code-owned set** (status, kind, tone, tier,
  mode, type) must be modeled as an **`enum`** (or a strongly-typed value object), not a
  `string`. A `string` for a closed set invites typos, case mismatches, invalid values,
  and stringly-typed comparisons the compiler can't catch — an unjustified `string` here
  is a **MEDIUM** finding.
- **A `string` is correct when** the value is genuinely open/free text (titles, prompts,
  URLs, slugs), is owned by an external system (third-party IDs/codes the plan does not
  control), or the set is large/volatile enough to belong in a lookup table. Do **not**
  flag these.
- When the plan **adds** an enum, it inherits the existing enum rules: define it once in
  the shared domain layer (see Single Source of Truth), tie members to explicit ordinals
  matching across backend and frontend, and append new members at the **end** to avoid
  renumbering persisted/serialized values.

---

### Explicit Over Implicit

- No "sensible defaults" without naming the default value and type
- All optional fields declare their omission behavior (which code path runs)
- State machines must enumerate all transitions including invalid inputs and the "no-op" case

---

### Transactional Semantics

- Multi-step operations must name the transaction boundary (EF `SaveChangesAsync`, or equivalent for the project's ORM — identified from CLAUDE.md stack)
- Fire-and-forget operations must be explicitly labelled as non-blocking and non-rolling-back
- Compensating actions must be specified for multi-step non-atomic operations

---

### API Versioning & Backward Compatibility

- Every new endpoint includes version in path (`/api/v1/`)
- New optional fields added to existing DTOs must document the default for old clients
- Breaking changes (field removal, rename, enum value change) must be marked and include a migration path

---

### Convention Over Configuration

- Shared patterns (job retry policy, callback contract, log format) defined once and referenced; not repeated per job
- Naming conventions stated once in a shared §: project conventions (e.g., PascalCase for C# classes, camelCase for JSON, kebab-case for Angular selectors — or whatever the project uses, per CLAUDE.md)

---

### Interface Segregation & Service Cohesion (SOLID-I)

> Applies to code-writing plans that introduce or extend a service interface / AppService.
> This is the plan-time companion to Single Responsibility (SOLID-S, per-section) and to
> the code-review "constructor-dependency-count" smell — caught here before code exists.

- A proposed interface / AppService must serve **one cohesive responsibility**. Flag a
  **fat interface** that bundles unrelated operations (e.g. CRUD + bulk-import + event-
  publishing + reporting on one service) so that consumers are forced to depend on methods
  they never call — a clear case is a **MEDIUM** finding with a suggested split.
- Use the **dependency-count signal** as the trip-wire: if a planned service's described
  collaborators/repositories exceed ~8, the service is doing too much — name the split
  (extract a dedicated service, facade, or domain-event publisher) rather than specifying
  the god-service.
- **Open/Closed (SOLID-O):** when the plan anticipates new variants of a behavior, prefer
  an extension seam (new implementation of an existing interface) over editing a growing
  `if/else`/`switch` on a type discriminator — but only when ≥ 2 variants exist now (else
  it is YAGNI, see Core Four). Flag a plan that specifies a discriminator-switch destined
  to grow as a **LOW** finding.
- **Not in scope here:** Liskov Substitution (subtype behavioral contracts) is a code-time
  concern verified by the code-review gate / `csharp-dev`, not from a spec.

---

### Composition Over Inheritance (SOLID-D, Dependency Inversion)

- Shared behavior is injected services or interfaces, not base class fields
- Background jobs use the framework's base class (from CLAUDE.md); logic lives in the execute method, delegated to injected services
- High-level sections depend on abstractions (interfaces), not concrete classes — a plan that wires a section directly to a concrete implementation where an existing interface seam exists is a **MEDIUM** finding (Dependency Inversion)

---

### Stateless Services

- Services must not store per-request state in fields
- Each job invocation reads fresh state from DB; no in-memory cache across retries
- Plan must note what happens when the same job runs concurrently on two nodes

---

### Contract-First

- DTO fields documented with type, required/optional, validation constraints
- Enum values tied to explicit ordinal integers (must match across backend and frontend layers — no implicit ordering)
- All response codes mapped to error types

---

### GRASP: Low Coupling

- Entities must not reference external SDK types directly (e.g. `Stripe.CreditGrant` as a field); use internal abstractions
- Removing one entity must not require changing ≥ 3 others

---

### GRASP: High Cohesion

- A single entity or service must not accumulate unrelated responsibilities (e.g. billing state + generation violation state + sanction state in one class)
- Flag "God service" smell: any service with ≥ 5 unrelated public methods

---

### GRASP: Information Expert

- Operations must be placed in the class that owns the data needed (e.g. balance check belongs to `BillingAccount`, not the Angular client)
- If an operation crosses entity boundaries, it belongs in a domain service, not in either entity. Placing an operation in the wrong class is a **HIGH** finding (incorrect responsibility assignment — not just style).

---

### GRASP: Protected Variations

- Every volatile external dependency (Stripe SDK, AI provider SDK) must have an abstraction layer (interface) between it and domain logic
- If the plan calls an external SDK method directly from a domain service, flag it

---

### GoF: Strategy

- If the plan describes ≥ 2 concrete variants with the same call signature, it must name a shared interface
- If only one variant exists now, flag as YAGNI

---

### GoF: Observer

- If a plan uses domain events or an event bus for cross-aggregate communication, it must specify whether the handler is synchronous within the unit of work or asynchronous (eventual consistency)
- Failure in an async observer that loses a billing/audit record is a CRITICAL defect

---

### GoF: Facade

- If a frontend client or external API consumer must call ≥ 3 endpoints in sequence to complete one user action, the plan needs a composite server-side endpoint
- Orchestration logic must live server-side, not in the client

---

### GoF: Chain of Responsibility

- Multi-step validation pipelines (sanction check → balance check → content moderation) must specify: does each step short-circuit? What does each step return on failure?
- Security: a guard chain must short-circuit at the first security failure and not leak information about later checks

---

### GoF: State (State Machine Completeness)

- Any entity with a `Status` enum must include a complete transition table: all valid transitions, all invalid transitions, and what triggers each
- Transitions back to a baseline state (e.g. `Payg → Free` when balance hits zero) are frequently missing — explicitly required

---

### GoF: Singleton (Thread-Safety)

- Any service described as a singleton that holds mutable state must have a thread-safety note in the plan
- Singletons holding per-request data (credentials, user context) are a CRITICAL defect

---

### Test Coverage & Testability

> **Applies only to code-writing plans** — plans whose deliverable is application code to be written (the plan is the build spec for new/changed C#/Angular: entity, aggregate, AppService, domain service, background job, DTO, validator, controller, EF migration; or Angular component, service, model/interface, template). Skip this whole section **silently** for plans that are not themselves a build spec: purely operational plans (server provisioning, CI/CD wiring, secrets/DNS, runbooks), pricing/policy decisions, research, and analysis/gap/status/roadmap/tracking docs that merely reference or audit existing code rather than specify new code. For a mixed plan, only the build-spec portion is in scope.

- A code-writing plan has a dedicated **Testing** section — an H2 whose heading is `Testing`, allowing a leading number and a trailing qualifier (`## 11. Testing (xUnit)`, `## Testing Checklist` both count) — distinct from `## Verification` (manual/operational checks — deploy steps, smoke tests). An existing test-scenario section under another heading (e.g. a test-bearing `## Verification`) **satisfies** this — ask the author to rename/consolidate; do **not** add a second one. Absence of any such section in a code-writing plan is a **HIGH** finding.
- The section enumerates **numbered test scenarios** covering, for each feature the plan adds or changes:
  - the happy-path **use case(s)**,
  - the **edge cases** — boundary/limit values, empty/null, max length, ordering, concurrency, idempotent re-invocation, and
  - the **error/failure paths** — invalid input, external-call failure (terminal vs transient), timeout, cancellation, permission denied.
  Listing only happy paths is a **HIGH** finding — edge and error coverage is the point of the section.
- **Cover the layers the project actually tests and gates** (identified from CLAUDE.md and the project's testing/deploy-gate policy). Name each scenario's test type/layer and target test project — e.g. an xUnit `*.Tests` project per `xunit-testing-patterns`/`generate-tests`, or an ABP integration test per `abp-integration-testing`, for the backend; a component spec (e.g. Angular `*.spec.ts`) for a frontend app whose tests are gated. A scenario with no named layer/project is a **MEDIUM** finding.
- **Respect recorded deferral decisions (single source of truth).** If a canonical plan or CLAUDE.md records that a test layer is deferred or non-gating (e.g. an admin SPA whose unit/E2E tests are a later phase), do **not** raise a finding demanding tests for that layer — instead require the plan to state that its verification for that layer follows the deferred policy (manual / E2E later). Demanding tests the project has explicitly chosen not to write yet is a false finding.
- Each **acceptance criterion / verification item** is **proven by** ≥ 1 test scenario (an explicit Test → Acceptance mapping, as in the gold-standard plans). An acceptance criterion with no proving scenario — or a scenario that proves nothing — is a **MEDIUM** finding.
- The section names the **test gate** the developer must pass for "done" (the project's CI gate, e.g. `dotnet test` / a gated `ng test`).
- **Derive** the scenarios primarily from the plan's own already-required content — its enumerated error cases (Implementation Completeness), state transitions (GoF: State), idempotency rules, and timeouts — so each test traces to a spec the plan already makes. Cross-check against existing tests (Agent A) to target genuine gaps rather than re-specify covered behavior. Default a missing degrade-vs-fail decision to a fail-fast assertion (a clear retryable failure over silently producing lower-quality output), consistent with the project's quality-first stance.
