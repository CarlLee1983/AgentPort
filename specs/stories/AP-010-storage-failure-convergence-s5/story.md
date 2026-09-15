# Story: AP-010 — Converge Physical Storage Failures in S5

## Goal

Keep accepted work controllable and bounded when AgentPort's durable storage or
physical control reserve fails: close new admission and dispatch before another
Runtime start, stop every active Execution through the independent Supervisor,
and recover without inventing acceptance, terminal state, Stop Evidence, or
replaying work.

## Context

This Story promotes [issue 18](../../../.scratch/agentport-v0-1/issues/18-capacity-storage-failure.md)
as the next incremental S5 slice after [AP-009](../AP-009-bounded-retention-expiry-s5/story.md).
AP-009 already implements the default 100,000 general-tombstone limit, 2 GiB
SQLite database-plus-WAL admission budget, 256 MiB physical control reserve,
per-Task reply/cancel/acknowledgement capacity, retention expiry, and existing
capacity/unavailable projections. AP-010 does not redesign those contracts.

[Technical Design sections 9–11](../../../docs/technical-design.md) require
physical storage failure to stop admission and dispatch, let the independent
Supervisor revoke and stop active Execution Generations, retain claims until
trusted Stop Evidence and durable recovery exist, and expose only authorized
committed stale observations. [ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md)
forbids automatic replay of uncertain work; [ADR-0003](../../../docs/adr/0003-local-transactional-task-store.md)
keeps SQLite as the only durable lifecycle source.

The controlled-runtime composition is the owning seam. It may keep a bounded
ephemeral safety set of exact active Execution References solely to stop work
while SQLite is unavailable; that set is not a second Task lifecycle source.
This slice retains the existing three-operation Supervisor interface and does
not claim issue 19's simultaneous daemon-loss crash matrix or G5 completion.

## Classification

- Security sensitive: yes
- Baseline conformance: no
- Task mode: execution

## Authority

- plan: yes
- modify: yes
- add_dependency: no
- migration: no
- commit: no
- push: no
- deploy: no

## Architecture

- Impact: high
- Boundary: `controlled-runtime storage-incident detection, dispatch closure, active-Reference tracking and Supervisor convergence`
- Contract: `the composition closes admission and dispatch on classified physical or commit-ambiguous storage failure before another start, then stops every known exact Execution Reference without publishing terminal state or releasing claims until durable recovery and trusted Stop Evidence`
- Owner: `controlled-runtime storage-incident detection, dispatch closure, active-Reference tracking and Supervisor convergence = AgentPort core composition`

## Risk

- Level: high
- Reason: `bounded-capacity`
- Reason: `concurrency`
- Reason: `error-projection`

## Capacity

- Bounded resource: `existing 2 GiB SQLite DB-plus-WAL admission budget, 256 MiB same-filesystem physical control reserve and per-Task control reservations`
- Limit: `AP-009 limits remain unchanged; the active Execution safety set is bounded by the existing global active-execution limit`
- Saturation behavior: `expected configured saturation rejects new load while preserving reserved controls; physical storage or reserve failure closes admission and dispatch and initiates stop convergence`
- Failure projection: `stable existing capacity or unavailable result without false durable acceptance, early result eviction or unbounded Runtime activity`
- Evidence AC: `AC-01`

## Concurrency

- Contended resource: `storage commit or timeout, incident latch, dispatch authority, active Execution References, Supervisor stop evidence and durable claims`
- Linearization point: `durable transaction remains mutation acceptance; a classified storage incident closes the composition dispatch latch before Supervisor stop fan-out or any later Runtime start`
- Conflict outcome: `same-operation retry resolves an ambiguous commit; uncertain stop retains unavailable or recovering state and its claim, and no new generation starts`
- Evidence AC: `AC-05`

## Error Projection

- Source failure: `configured saturation, SQLite full or I/O failure, write lock or timeout ambiguity, worker loss, physical control-reserve failure and Supervisor indeterminate stop`
- Public projection: `existing capacity rejection, storage_unavailable, authorized stale observation or observation_unavailable according to committed evidence`
- Detail policy: `redact SQLite and WAL paths, SQL text, control-reserve metadata, Execution References, Supervisor internals, private payload and cross-scope cached content`
- Evidence AC: `AC-06`

## Scope

### In Scope

- Deterministic storage fault seams for commit failure, SQLite full/I/O error,
  write lock or timeout, worker loss and physical control-reserve failure.
- A controlled-runtime composition-owned, fail-closed storage incident latch
  shared by admission and dispatch; expected AP-009 quota saturation does not
  trip the global incident latch.
- A bounded ephemeral set of each exact Execution Reference from durable claim
  until durable terminal commit and claim release, used only for independent
  per-reference Supervisor revoke-and-stop convergence during a storage incident.
- Waiting-for-answer, accepted-answer-before-ack, cancel, candidate outcome and
  terminal-commit failure coverage, including ambiguous commit retry behavior.
- Authorized committed stale observation fallback, storage recovery and reserve
  reconciliation without Runtime replay, answer redelivery or synthetic terminal state.
- Fault, MCP and designated Linux evidence plus capacity/storage-failure
  operational recovery and rollback documentation.

### Out of Scope

- Reimplementing or changing AP-009 retention, tombstone, cursor, 100,000
  receipt, 2 GiB admission or normal reserved-control semantics.
- A fourth Supervisor operation, supervisor-wide `stopAll`, autonomous recovery
  across simultaneous daemon loss and unavailable SQLite, or issue 19's full
  repeated-crash matrix.
- New public tools, error codes, readiness states, Runtime commands, storage
  services, migrations or durable lifecycle truth outside SQLite.
- Issue 20's complete authorization/policy adversarial matrix, issue 21 load
  and latency acceptance, G5 completion, S6 packaging or deployment.

## Inputs

- AP-009's Human-reviewed retention, physical capacity, reserve and expiry implementation.
- Existing AgentExecutionService, controlled Runtime dispatcher/composition,
  exact Execution Reference, Supervisor and recovery contracts.
- [Issue 18](../../../.scratch/agentport-v0-1/issues/18-capacity-storage-failure.md),
  [Implementation Plan S5](../../../docs/implementation-plan.md), and
  [Technical Design sections 9–11](../../../docs/technical-design.md).

## Outputs

- Composition-owned storage incident coordination with bounded active-Reference tracking.
- Fail-closed admission/dispatch behavior and independent Supervisor stop convergence.
- Deterministic physical storage/reserve fault fixtures and phase-specific integration coverage.
- Updated `test:faults` coverage and capacity/storage-failure operations documentation.

## Rules

- R1: Expected queue, tombstone or configured DB/WAL saturation follows AP-009:
  reject new load, retain in-period data and preserve reserved existing-Task
  controls without globally stopping accepted Executions.
- R2: Physical control-reserve loss, worker death, SQLite I/O/commit failure or
  write timeout/lock ambiguity latches admission and dispatch closed before
  another Supervisor start. A later request cannot silently reopen the latch.
- R3: The composition tracks no more exact active Execution References than the
  existing global active-execution limit. The safety set authorizes only
  revoke/stop; it cannot publish state, replace SQLite, start work or release a claim.
- R4: Every known active Reference is sent to the existing Supervisor
  `revokeAndStop`. Without trusted same-Reference Stop Evidence and recovered
  durable storage, AgentPort preserves unavailable/recovering/quarantine and the claim.
- R5: A timeout or failed response never proves a mutation was rejected. Retry
  uses the identical operation ID and input to discover the durable winner; no
  Task, answer, generation, candidate or terminal result is replayed or fabricated.
- R6: `stale` is available only from a previously committed snapshot that is
  still authorized under the current Registry. Without that evidence, reads
  return `observation_unavailable`; storage details never reach the Caller.
- R7: The incident latch reopens only through a new controlled composition
  startup that successfully opens storage, reconciles the physical reserve,
  recovers exact References and checks Supervisor evidence. Recovery never
  automatically dispatches or redelivers work.
- R8: The existing three Supervisor methods, public MCP inventory, error codes,
  generation fencing, Linux Stop Evidence and AP-009 migration remain unchanged.

## Expected Errors

- Expected configured capacity returns the existing queue, tombstone or storage
  capacity rejection and does not trip stop convergence.
- Commit-ambiguous timeout, SQLite I/O/lock failure, worker death or control
  reserve loss returns sanitized `storage_unavailable` for mutations and closes
  new admission/dispatch without claiming rejection or acceptance.
- An authorized read returns a current projection, an authorized committed
  `stale` snapshot, or `observation_unavailable`; it never leaks another scope's cache.
- Supervisor pending, unavailable or indeterminate stop preserves the exact
  Reference, claim and unavailable/recovering projection; it is not Stop Evidence.
- Recovery mismatch remains quarantined and cannot start a replacement generation.

## Dependencies

- WI-010 / AP-009 must be DONE and Human-reviewed before this Work Item starts.
- Existing controlled Runtime dispatch, Linux Supervisor, clarification and
  recovery contracts from AP-005 through AP-008 remain authoritative.
- Designated Linux cgroup-v2 target evidence is required for the real
  Supervisor-stop acceptance path; deterministic macOS fixtures do not replace it.

## Constraints

- No schema migration or dependency addition is authorized.
- Storage never calls the Supervisor and the Supervisor never writes the core DB.
  The composition coordinates them without a cross-system transaction.
- Do not add scattered per-method failure truth or a second Task state machine;
  use one incident signal and one bounded active-Reference safety set.
- `make verify`, `pnpm run test:mcp`, `pnpm run test:faults`, and
  `pnpm run test:linux` are required candidate evidence. `test:faults` must
  actually include the new S5 storage-failure fixtures.
- Commit, push, deploy, Gate resolution and Human Review require separate authority.

## Guidance

Relevant:

- [Engineering entry](../../../guidance/ENTRY.md): keep one source of truth and test the owning seam.
- [Development workflow](../../../docs/development-workflow.md): high-risk candidate, Gate and environment evidence rules.
- [ADR-0001](../../../docs/adr/0001-external-observation-and-control.md): queries and controls remain independent of Runtime input.
- [ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md): uncertain work is never automatically replayed.
- [ADR-0003](../../../docs/adr/0003-local-transactional-task-store.md): SQLite remains the sole durable lifecycle source.
- [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md): only Linux cgroup-v2 evidence proves reliable Runtime stop.

Not applicable:

- No new Runtime Driver, public protocol, deployment or storage-service design applies.

## Trust Boundary Fields

- `operationId` — Caller mutation identity used to resolve commit-ambiguous retries.
- `taskId` — Caller-selected Task identity authorized before live or stale lookup.
- `questionId` and `answer` — Caller reply fields that must not be redelivered or reopened after failure.
- `executionReference` — core-derived exact Reference held only in the bounded safety set and Supervisor calls.
- `worker.observation` — Runtime-derived progress, question and candidate data that may race storage failure.
- `stopEvidence` — Supervisor-derived proof that must match the exact Reference before durable convergence.
- `cachedSnapshot` — previously committed projection reauthorized before any stale response.
- `storageFailure` — internal SQLite, WAL, worker, lock, timeout and control-reserve diagnostic input.
- `error.details` — bounded public projection that must omit storage, Supervisor and cross-scope details.
