# Story: AP-015 — Existing-Task Control Under Synthetic Load

## Goal

Let an authorized Caller reply, cancel and acknowledge an interruption for
accepted work through the existing outer MCP tools under reproducible synthetic
execution and storage pressure, without losing durable control or claiming that
an unconfirmed Execution has stopped.

## Context

[Issue 21](../../../.scratch/agentport-v0-1/issues/21-load-control-latency.md)
requires existing-Task control to remain available under capacity and fault
pressure before S5/G5 exit. [AP-014](../AP-014-outer-mcp-observation-under-load/story.md)
measured outer reads under synthetic load but explicitly excluded loaded
`cancel_task`, `reply` and `acknowledge_interruption`. AP-009 and AP-010 established
per-Task control reserve and storage-incident behavior; AP-013 established the
ten-tool authorization matrix. This Story tests those existing contracts together
on a candidate. Their prior Work Items do not provide loaded-control Evidence.

[ADR-0001](../../../docs/adr/0001-external-observation-and-control.md)
keeps cancel outside Runtime work input. [ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md)
forbids replay of uncertain work. [ADR-0003](../../../docs/adr/0003-local-transactional-task-store.md)
keeps SQLite receipts, Tasks and claims as the durable authority.
[ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)
permits platform-neutral MCP/SQLite fixtures without treating a scripted
Reference or stop precondition as Linux Runtime or trusted Stop Evidence.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: mixed

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: no
* push: no
* deploy: no

## Architecture

* Impact: medium
* Boundary: `outer MCP existing-Task control through core authorization and SQLite receipts, reserves and claims`
* Contract: `reply, cancel and acknowledge_interruption remain short, current-authorized durable mutations with existing public results; a response or scripted callback cannot substitute for a committed receipt or trusted stop confirmation`
* Owner: `outer MCP existing-Task control through core authorization and SQLite receipts, reserves and claims = AgentPort protocol, core and persistence boundaries`

## Risk

* Level: high
* Reason: `loaded-control-receipt`
* Reason: `stale-authorization`
* Reason: `synthetic-stop-overclaim`

## Scope

### In Scope

* Official MCP Client through the existing loopback Streamable HTTP listener,
  core authorization and real SQLite worker for the three existing control
  tools; no alternate protocol or fake storage response.
* Four scripted held Execution References on different Workspaces, a queued
  same-Workspace successor, documented active and queue bounds, general receipt
  saturation, eligible reserved controls that actually commit while saturated,
  bounded event/audit pressure, concurrent polling and a held synthetic worker
  callback.
* Existing per-Task reply, cancel and interruption-acknowledgement reserves,
  operation receipt replay, Question delivery uncertainty, exact claim retention
  while stop is unconfirmed, and current authorization after revocation.
* Controlled worker delay, write timeout or physical storage failure, including
  an identical-operation retry that discovers the durable winner where a prior
  response was ambiguous. Bounded owning-boundary fixes only if a deterministic
  fixture demonstrates a violation of the approved existing contract.
* One candidate-bound focused command and sanitized expected/actual control
  record naming fixture parameters, full official-Client response-time samples,
  counts, result location and limitations.

### Out of Scope

* Issue 21's five-second disconnected Client message, production backpressure,
  large-output/HTTP serialization and message-limit proof, and complete S5/G5
  exit.
* AP-012's protected production worker-entrypoint live deadline, designated
  Linux crash/credential/cgroup target, actual Runtime start or trusted Stop
  Evidence; AP-011 S6 operations, real Caller and G6/release acceptance.
* New MCP tools or public error codes, queue/reserve/retention policy, Task or
  Question lifecycle semantics, in-flight read/revocation ordering, Runtime
  isolation, Supervisor operations, schema, dependency or migration.

## Inputs

* AP-009/010 capacity, physical reserve and storage-incident contracts;
  AP-013 current Registry authorization and AP-014 official Client, real SQLite
  and scripted-load fixtures.
* Technical Design's initial four-active, one-per-Workspace, 32-per-Workspace
  and 256-global queue values, plus short outer-control and stop-confirmation
  behavior.
* Bounded synthetic Task, Question, answer, Reference and private markers only.

## Outputs

* Deterministic loaded-control and storage-pressure regression fixtures with
  durable Task, Question, receipt, claim, audit and synthetic start observations.
* A reproducible focused MCP command and sanitized candidate-bound control
  record with expected/actual outcomes and result location.
* Explicit remaining Client-outage, production-backpressure, Linux, AP-012,
  S5/G5 and S6 limits.

## Rules

* R1: Configured new-admission, queue or general-receipt saturation rejects new
  work without evicting accepted Tasks or consuming their reserved reply, cancel
  and interruption-acknowledgement capacity. An eligible call for each control
  commits its durable receipt while general receipts are saturated, with the
  acknowledgement's stopped precondition explicitly scripted for this test.
  These expected limits do not by themselves latch a physical storage incident.
* R2: A loaded active-Task cancel commits the existing intent and returns a
  `stopping` snapshot without waiting for held Runtime input or a pending
  cooperative/force-stop callback. Until the exact Execution Generation is
  sealed and its Unit is proven empty by the trusted boundary, Task and
  Workspace claim stay nonterminal and held; a scripted fixture never supplies
  that production proof.
* R3: A loaded first reply commits one answer and its receipt before reporting
  accepted delivery. Repeating the identical operation ID/input replays the
  durable winner; callback or delivery-ack uncertainty remains pending/unknown
  and cannot redeliver or turn an answer into a new Task.
* R4: Interruption acknowledgement rejects a recovering Task before the
  existing same-Reference stopped precondition. A platform-neutral test may
  script that store precondition to exercise the core/receipt branch, label it
  synthetic, then assert the existing `interrupted` result and replay. It does
  not establish Linux Stop Evidence, production claim release or G5.
* R5: Every fresh control call uses current Registry membership and Agent
  allowlist. Foreign or revoked targets remain concealed with existing bounded
  results; private answer, instruction, Reference and host diagnostics do not
  enter unauthorized responses, errors, events, audit or timing records.
* R6: A timed-out or failed storage mutation response cannot prove either
  acceptance or rejection. Identical operation retry checks the committed
  receipt after recovery; classified physical failure closes admission and
  dispatch under AP-010, and no mutation fabricates a terminal result or frees
  a claim.
* R7: Under the stated synthetic load with the SQLite worker available, each
  control's full official-Client response, including serialization, meets a
  two-second fixture target. Record sample counts, maxima and percentiles for
  reply, cancel and acknowledgement separately. A storage timeout or classified
  fault is recorded as an unavailable/ambiguous outcome, never a normal timely
  success; this fixture target is not a host or network availability guarantee.
* R8: Public mutation results, control reserve policy, authorization ordering,
  Stop Evidence semantics or Runtime credential topology stay unchanged. A
  demonstrated need to change one requires a ForgePilot Gate before affected
  work.

## Expected Errors

* Queue or general-receipt saturation returns its existing capacity code for
  new work while reserved existing-Task controls remain eligible.
* Foreign or unknown protected targets retain bounded `not_found`; fully
  revoked membership after valid bearer authentication retains `access_denied`.
* Premature interruption acknowledgement keeps its existing rejection; a
  storage timeout or classified physical failure keeps existing
  `storage_unavailable` or commit-ambiguous retry behavior without a false
  durable-acceptance claim.

## Dependencies

* AP-009/010/013/014 approved contracts remain intact. Their DONE state is a
  prerequisite, not AP-015 loaded-control Evidence.
* A qualified Linux protected-credential/cgroup target and AP-012 live
  worker-entrypoint/crash evidence remain prerequisites for complete issue-21
  and G5, not for this platform-neutral slice.

## Constraints

* Synthetic callbacks, References and scripted stopped preconditions are
  labeled separately from actual Runtime starts and trusted Stop Evidence.
* No ambient credential, actual private host path, raw instruction or answer
  enters a versioned fixture or sanitized control record.
* Run focused control, MCP and affected fault checks plus `make verify` for the
  same exact candidate; use ForgePilot `--snapshot` for intentional uncommitted
  content and inspect every Acceptance Evidence row before Human Review.

## Guidance

Relevant:

* [Engineering entry](../../../guidance/ENTRY.md): test behavior at the
  owning boundary and preserve one durable source of truth.
* [Development workflow](../../../docs/development-workflow.md): bind machine
  Evidence to the actual candidate and gate changed product semantics.

## Trust Boundary Fields

* `bearer` — official MCP Client credential at the loopback listener.
* `principal` — current Registry membership and Agent allowlist at each control.
* `agentId` — Caller-selected Agent for saturated new admission.
* `taskId` — Caller-selected protected Task control target.
* `questionId` — Caller-selected Question reply target.
* `operationId` — Caller-supplied idempotency key and retry input.
* `expectedRevision` — Caller-supplied interruption acknowledgement revision.
* `question.answer` — protected Caller reply held across delivery uncertainty.
* `cursor` — Caller-presented event pagination position under polling pressure.
* `execution.reference` — derived exact synthetic Reference and claim identity.
* `stop.precondition` — scripted fixture condition before acknowledgement;
  never production Stop Evidence.
* `event.projection` — bounded derived public control event metadata.
* `error.details` — derived SQLite, worker, Supervisor or host diagnostic before
  bounded public/audit projection.
* `control.result` — derived candidate outcome, counts and result location.
