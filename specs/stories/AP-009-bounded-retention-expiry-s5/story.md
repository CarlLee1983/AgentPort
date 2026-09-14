# Story: AP-009 — Bound Terminal Retention and Expiry in S5

## Goal

Give authorized Callers a bounded, durable retention period for terminal Task results and operation history,
then make expiry explicit without reopening work, silently skipping cursor history, evicting in-period results,
or deleting any nonterminal recovery/control state.

## Context

This is the issue-17-only first S5 slice from [Implementation Plan S5](../../../docs/implementation-plan.md),
not the G5 fault-matrix exit condition. It adds retention, expiry, cleanup and capacity behavior at the existing
`DurableAdmissionStore` seam after S4 has established durable Context, Task, receipt, event, Question and
continuation state.

[Technical Design sections 9–11](../../../docs/technical-design.md) require SQLite/WAL physical-byte accounting,
terminal-only expiry, minimal operation tombstones, scope/filter-bound cursor expiry, and reserved control paths.
[ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md) forbids automatic replay of uncertain work;
[ADR-0003](../../../docs/adr/0003-local-transactional-task-store.md) keeps the durable store as the single
transactional source. Cleanup is an internal durable-store operation: no new public cleanup tool, MCP Adapter
state, Runtime behavior, or external side effect is introduced.

ForgePilot `GATE-027` selected the public expiry semantic: expiry retains only the minimal authorized
Task/operation marker; `agentport_get_task` and an identical operation retry return `result_expired`; expired
Tasks are omitted from `agentport_list_tasks`; and a Context retires after its final Task expires unless a related
nonterminal dependency still protects it.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: yes
* commit: no
* push: no
* deploy: no

## Architecture

* Impact: high
* Boundary: `DurableAdmissionStore retention, receipt tombstone, cursor and capacity transaction seam`
* Contract: `DurableAdmissionStore atomically derives terminal expiry markers, removes private payload only after durable tombstones, preserves protected Contexts, and never starts or reopens an expired operation`
* Owner: `DurableAdmissionStore retention, receipt tombstone, cursor and capacity transaction seam = AgentPort core persistence`

## Risk

* Level: high
* Reason: `retention-overflow`
* Reason: `bounded-capacity`
* Reason: `concurrency`
* Reason: `error-projection`

## Retention and Overflow

* Retained resource: `terminal Task result, operation receipt, scope/filter cursor history and Context reference`
* Retention bound: `administrator-configurable terminal retention defaulting to 30 days from durable terminal commit`
* Overflow policy: `atomically retain minimal replay/cursor tombstones before deleting private payload; never evict in-period results or nonterminal/protected state`
* Recovery / observability: `restart-safe cleanup records durable expiry boundaries and DB-plus-WAL usage without invoking Runtime work`
* Evidence AC: `AC-03`

## Capacity

* Bounded resource: `general tombstones and SQLite DB-plus-WAL admission storage`
* Limit: `100000 general tombstones and 2 GiB DB-plus-WAL admission budget with reserved control capacity`
* Saturation behavior: `reject submit edit and resume while allowing reserved reply cancel and acknowledge paths; do not evict retained results`
* Failure projection: `stable unavailable or capacity rejection without a durable false acceptance or Runtime dispatch`
* Evidence AC: `AC-08`

## Concurrency

* Contended resource: `terminal payload, operation receipt, cursor tombstone, Context protection and capacity counters`
* Linearization point: `single DurableAdmissionStore SQLite transaction that commits terminal marker, cleanup decision, tombstone and capacity accounting`
* Conflict outcome: `one durable winner; retry projects result_expired or the committed live result and never reopens execution`
* Evidence AC: `AC-07`

## Error Projection

* Source failure: `expired result or cursor, retention/capacity saturation, and internal cleanup/storage error`
* Public projection: `result_expired cursor_expired unavailable or stable capacity rejection through existing authorized tool responses`
* Detail policy: `redact private payload, raw SQLite/WAL paths, SQL errors, cross-scope identifiers and internal cleanup metadata`
* Evidence AC: `AC-09`

## Scope

### In Scope

* An administrator-configurable default 30-day retention window anchored only to the durable terminal commit.
* Terminal-only atomic cleanup that first creates the minimum replay and cursor tombstones, then removes private
  Task payload; no nonterminal, paused, recovering, stopping, stop-unknown, held or quarantined Task is eligible.
* Durable `result_expired` and `cursor_expired` behavior, Context protection/retirement rules, migration and
  restart coverage at the `DurableAdmissionStore` boundary.
* Admission saturation at 100,000 general tombstones and 2 GiB combined database/WAL bytes, including reserved
  `reply`, `cancel`, and interruption-acknowledgement control paths.
* Existing MCP projections and authorization checks for retention-related errors, cursors, filters and markers.

### Out of Scope

* G5’s complete crash-window matrix, latency/load target, repeated-crash proof, production declaration, or S6
  deployment/release evidence.
* A new cleanup-facing MCP tool, Adapter-owned lifecycle state, Runtime cleanup command, vendor transcript
  deletion, remote storage service, or eviction of in-period results to create capacity.
* Changing the `GATE-027` expiry semantic or Task lifecycle, or altering the separate administrator policy for
  vendor transcript retention.

## Inputs

* [Issue 17](../../../.scratch/agentport-v0-1/issues/17-retention-expiry.md), [Implementation Plan S5](../../../docs/implementation-plan.md), and [Technical Design sections 9–11](../../../docs/technical-design.md).
* Durable S4 Task, Context, receipt, event, Question, claim, recovery and authorization records.
* Administrator retention policy and trusted controllable `asOf` test clock; Callers do not supply cleanup time.

## Outputs

* Additive durable-store migration and transactionally consistent retention/capacity implementation.
* Authorized, bounded expiry and cursor error projections; no new public tool or Runtime side effect.
* Focused integration, acceptance, migration, MCP and fault verification evidence for this slice.

## Rules

* R1: The retention period defaults to 30 days, is configurable only by administrator policy, and begins at the
  durable terminal commit—not candidate outcome, request receipt, query time, worker exit, or process restart.
* R2: Cleanup may run only for a terminal Task. It must never expire a nonterminal, paused, recovering, stopping,
  stop-unknown, held or quarantined Task, its required control data, or a Context protected by a related
  nonterminal/queryable Task.
* R3: One durable transaction creates the minimal authorized replay/cursor tombstones before it removes private
  prompt, answer and result payload. An expired operation stays expired: it never reopens, redispatches or makes
  a new Runtime call.
* R4: A scope- and filter-bound cursor that refers to expired history returns `cursor_expired` and requires a
  fresh snapshot; it must not silently skip removed events, broaden a filter, or disclose another Access Scope.
* R5: Context remains until all related Tasks have expired and no nonterminal dependency protects it. AgentPort
  cleanup never deletes a vendor Runtime transcript; its retention remains administrator managed.
* R6: Before either capacity limit is exceeded, retain in-period results. At saturation reject `submit`, `edit`
  and `resume`, while reserved `reply`, `cancel`, and `acknowledge_interruption` paths remain available until a
  physical storage failure requires the existing unavailable/quarantine behavior.
* R7: No cleanup implementation may introduce a public cleanup tool, Adapter-side retention truth, a Runtime
  command, or a vendor transcript side effect.
* R8: `get_task` and identical-operation retry return `result_expired`; expired Tasks are omitted from lists; and
  an unprotected Context retires after its final Task expires, exactly as selected by `GATE-027`.

## Expected Errors

* `result_expired` for an authorized expired Task marker or identical expired operation retry, without payload,
  restart, redispatch or execution mutation.
* `cursor_expired` for a scope/filter cursor whose history expired, requiring a fresh authorized snapshot rather
  than a skipped page or broadened query.
* Stable capacity rejection for new-work mutations at a tombstone or DB/WAL limit, and `unavailable` for an
  unrecoverable storage/control-reserve failure; neither claims a durable acceptance.
* Cross-scope Task, operation, cursor, filter or expiry-query attempts return the existing sanitized authorization
  projection without exposing tombstone, retention, payload or storage detail.

## Dependencies

* AP-008’s S4 durable Context, continuation, receipt, cursor and recovery contracts must be available to this
  slice; their current lifecycle authority remains ForgePilot.
* ForgePilot `GATE-027` resolved the public expiry semantic stated in Context and R8; implementation must not
  broaden or reinterpret that decision.

## Constraints

* Migration is additive and preserves live and in-period S4 durable records, including Contexts, Tasks, receipts,
  events, Questions, claims and recovery evidence.
* Capacity measures actual SQLite database plus WAL bytes, page/JSON/audit overhead and reserved control space;
  payload-size accounting alone is insufficient.
* `make verify`, `pnpm run test:mcp`, and `pnpm run test:faults` are required automated evidence commands for
  the implementation candidate. No commit, push, deploy, dependency addition, Gate resolution or Human Review
  is authorized by this Story.

## Guidance

Relevant:

* [Engineering entry](../../../guidance/ENTRY.md): retain one source of truth and test at the narrowest useful seam.
* [Development workflow](../../../docs/development-workflow.md): changed public semantics require a ForgePilot Gate.
* [ADR-0001](../../../docs/adr/0001-external-observation-and-control.md): queries and controls remain independent of Runtime input.

Not applicable:

* No new Runtime integration or deployment guidance applies to this internal durable-store slice.

## Trust Boundary Fields

* `taskId` — Caller-selected logical Task identity, authorized within the current Access Scope before expiry lookup.
* `operationId` — Caller idempotency identity, scoped to operation type and immutable input fingerprint before replay/tombstone lookup.
* `cursor` — Caller-provided opaque scope/filter-bound event/list position, validated before any retained-history read.
* `filters` — Caller-provided list/event scope filters, authorized and bound before cursor reuse or expiry projection.
* `private payloads` — persisted prompts, answers and result bodies eligible only for terminal cleanup; never returned after expiry.
* `retentionDays` — administrator policy value, bounded and never caller-controlled through an MCP request.
* `asOf` — trusted controllable test/cleanup clock input, never taken from a Caller request.
* `error.details` — storage, cleanup and authorization diagnostics that must be sanitized before public projection.
