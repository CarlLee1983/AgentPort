# Story: AP-016 — Serialized Observation Under Slow-Client Pressure

## Goal

Show that an authorized Caller can obtain bounded outer MCP observations and
control an accepted Task while a Client reads a large response slowly, without
blocking durable worker observations or claiming fresh state when storage is
unavailable.

## Context

[Issue 21](../../../.scratch/agentport-v0-1/issues/21-load-control-latency.md)
requires output, HTTP serialization and slow-Client pressure to be checked as
part of S5/G5. [AP-014](../AP-014-outer-mcp-observation-under-load/story.md)
measured `get_task`, `list_tasks` and `get_events` with synthetic ingress,
SQLite and polling pressure, but not large serialized responses or a slow
reader. [AP-015](../AP-015-existing-task-control-under-synthetic-load/story.md)
proved synthetic loaded control, but excluded production backpressure.

[Technical Design](../../../docs/technical-design.md) names bounded Task
content, page and HTTP output, and requires a slow Client not to obstruct
worker event preservation. [ADR-0001](../../../docs/adr/0001-external-observation-and-control.md)
keeps observation and cancellation outside Runtime work input.
[ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)
permits platform-neutral MCP/SQLite evidence without treating scripted
References as Linux Runtime or trusted Stop Evidence.

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
* Boundary: `outer MCP serialization and Client response through core observation and SQLite event/control persistence`
* Contract: `authorized bounded current observations may be returned; stale or unavailable reads are identified honestly, while a slow response consumer cannot substitute for or block a committed event or control receipt`
* Owner: `outer MCP serialization and Client response through core observation and SQLite event/control persistence = AgentPort protocol, core and persistence boundaries`

## Risk

* Level: high
* Reason: `slow-client-event-persistence`
* Reason: `serialized-private-content`
* Reason: `observation-currentness`

## Scope

### In Scope

* Official MCP Client through the existing loopback listener, core service and
  real SQLite worker for bounded `get_task`, `list_tasks` and `get_events`.
* A test-only HTTP reader that pauses at least 2.5 seconds on a legal
  `get_task` response of at least 128 KiB serialized bytes, withholding at
  least 64 KiB after its first chunk, while other official Clients poll and
  cancel an accepted Task with a held scripted Execution
  Reference. The reader is labeled a transport fixture, not a product Client.
* Maximum allowed event-page count, near-bound legal Task instruction including
  UTF-8 and JSON escaping, full serialized-response byte counts, durable event
  and cancel-receipt observations, and safe current/stale/unavailable outcomes.
* Reproducible focused commands and sanitized candidate-bound records. Reuse
  AP-014's existing 50-current-sample-per-tool measurement command for normal
  read latency; the new record covers response bytes and slow-reader outcomes. A
  bounded owning-boundary fix is allowed only for a deterministic violation of
  the existing documented result, authorization, durability or size contract.

### Out of Scope

* A new public tool, Task state, result or error code; `output_limit` semantics
  for incomplete final output; new HTTP/page/content bounds or capacity policy.
* The worst-case 100-item terminal Task-summary response and whether its
  duplicated MCP text/structured wire form meets the documented 8 MiB bound;
  that public pagination/size interpretation requires a separate Gate.
* The five-second disconnected-Client message and dead/stalled classification,
  which have no current product Client owner or approved external result.
* Production network availability/backpressure, actual Runtime start, trusted
  Linux Stop Evidence, complete Issue 21/S5/G5 exit, S6 or release acceptance.

## Inputs

* AP-014 outer observation and AP-015 durable control fixtures and approved
  public results; existing 128 KiB request, maximum 100-item page, bounded
  worker observations and Technical Design's 8 MiB serialized page target.
* Synthetic Task, event and Reference data only; no ambient credentials or
  host-private paths.

## Outputs

* Deterministic official-Client and slow-reader regression fixtures proving
  authorized page counts, measured response size, event/receipt persistence and honest
  observation results under the stated pressure.
* Candidate-bound records with fixture parameters, full-response size and
  timing distributions, separate non-current outcomes, expected/actual durable
  observations and sanitized result locations.
* Explicit unresolved Client-outage, incomplete-output and Linux/G5 limits.

## Rules

* R1: `get_task`, `list_tasks` and `get_events` use their existing authorized
  projections. A maximum allowed event page contains bounded metadata only;
  near-bound legal Task instruction appears only in authorized `get_task`.
  Measure the full serialized bytes for the declared fixture against the
  documented 8 MiB target without extrapolating to every legal response;
  structured and text results agree. Unauthorized reads, errors, events, audit
  and the candidate record omit private instruction and diagnostic markers.
* R2: A slow response consumer does not make a worker observation disappear or
  hold an unrelated official-Client read or cancel behind Runtime input. A
  committed cancel receipt returns the existing `stopping` result; until
  trusted stop confirmation, the exact claim remains held and nonterminal.
  During the declared pause, current other-Client reads and cancel finish
  their full responses within the two-second fixture target before reader
  release. This demonstrates the stated fixture, not production network
  backpressure.
* R3: When storage observation cannot complete within its existing bound,
  preserve the approved stale or `observation_unavailable` result instead of
  counting it as current success. A transport timeout or Client disconnect
  cannot prove Task failure, Runtime death, cancellation or lost persistence.
* R4: Measure at least 50 current full official-Client responses per read tool,
  including serialization, under declared normal synthetic load against the
  existing two-second fixture target. Record maximum and p50/p95/p99
  separately from stale, unavailable and failed calls. Record slow-reader
  completion and byte counts separately; a slow consumer is not a
  normal-latency sample.
* R5: Any need to change public results, Task lifecycle, capacity policy,
  output truncation, Client outage semantics or trusted Stop Evidence requires
  a ForgePilot Gate before affected behavior changes.

## Expected Errors

* Existing `not_found` and `access_denied` conceal foreign and revoked targets;
  schema violations retain `validation_error`.
* Storage observation timeout retains approved stale or
  `observation_unavailable`; no transport delay is converted to a terminal
  Task result.

## Dependencies

* AP-014 and AP-015 Work Items are DONE; their contracts remain intact. Their
  approved Evidence does not establish this slow-reader or serialized-size
  result.
* A qualified designated Linux target and unresolved Issue 21 Client/output
  decisions remain prerequisites for complete G5, not this platform-neutral
  slice.

## Constraints

* Use the existing official MCP Client for product calls and label raw slow
  response consumption as test-only transport pressure.
* Do not store raw private payloads in versioned fixtures, logs or the
  sanitized record. Distinguish synthetic from actual starts and stops.
* Run focused MCP, load and affected fault checks plus `make verify` on the
  same exact candidate; use ForgePilot `--snapshot` for intentional uncommitted
  content. Inspect every Acceptance Evidence row before Human Review.

## Guidance

Relevant:

* [Engineering entry](../../../guidance/ENTRY.md): test at the owning boundary
  and keep one durable source of truth.
* [Development workflow](../../../docs/development-workflow.md): bind machine
  Evidence to the actual candidate and gate changed public semantics.

## Trust Boundary Fields

* `bearer` — credential at the loopback MCP listener.
* `principal` — current Registry membership and Agent allowlist for calls.
* `taskId` — Caller-selected protected Task and cancel target.
* `operationId` — Caller-supplied idempotent cancel key.
* `cursor` — Caller-presented event page position.
* `task.instruction` — protected Task text in authorized snapshots.
* `event.metadata` — derived bounded event identifiers, type and times.
* `execution.reference` — derived synthetic exact claim identity.
* `error.details` — derived storage or host diagnostic before projection.
* `limit.result` — derived response metrics and durable outcome record.
