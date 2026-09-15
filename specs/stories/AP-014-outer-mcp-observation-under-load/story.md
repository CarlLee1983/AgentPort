# Story: AP-014 — Outer MCP Observation Under Synthetic Load

## Goal

Let an authorized Caller query accepted work through the existing MCP tools
while controlled execution and storage pressure is present, and measure whether
current query responses meet the documented two-second target on a recorded
platform-neutral candidate.

## Context

[Issue 21](../../../.scratch/agentport-v0-1/issues/21-load-control-latency.md)
requires reproducible outer-query measurements before S5/G5 exit. AP-013
covered the ten-tool authorization matrix, but did not measure loaded queries.
[ADR-0001](../../../docs/adr/0001-external-observation-and-control.md)
requires query and cancel to stay outside Runtime work input.
[ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)
allows macOS core, MCP and SQLite evidence without treating it as Linux Runtime
or trusted Stop Evidence. The tested OrbStack account/unit combinations have
not passed the required non-root transient `systemd LoadCredential` boundary;
no qualifying target Evidence is currently recorded.

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
* Boundary: `MCP outer observation through core authorization and the SQLite worker`
* Contract: `get_task, list_tasks and get_events remain authorized, bounded reads independent of Runtime work input; their public results retain existing semantics`
* Owner: `MCP outer observation through core authorization and the SQLite worker = AgentPort protocol, core and persistence boundaries`

## Risk

* Level: high
* Reason: `loaded-query-timing`
* Reason: `stale-private-snapshot`
* Reason: `synthetic-evidence-overclaim`

## Scope

### In Scope

* Official MCP Client through the existing loopback Streamable HTTP listener,
  core `get_task`, `list_tasks` and `get_events`, and real SQLite worker.
* Four scripted, held Execution References on different Workspaces, a queued
  same-Workspace successor and a bounded queue condition. These are synthetic
  contention fixtures, not four Linux Runtime starts.
* Controlled stalled synthetic ingress, SQLite read/write delay, bounded event
  and response pressure, concurrent polling, and fresh reads begun after
  authorization revocation with a previously warmed cache.
* Candidate-bound timings of current successful query responses, recorded
  separately from stale, unavailable and failed responses; narrow owning-read
  fixes only if a stable fixture demonstrates a violation.

### Out of Scope

* Issue 21's complete loaded cancel/reply/ack, five-second Client outage,
  production backpressure and S5/G5 exit.
* AP-012's protected production worker-entrypoint live deadline, nonempty exact
  Linux Execution Unit, restart claim release and no-skip designated Linux suite.
* New MCP tools, public error codes, Task/queue/capacity policy, Runtime
  isolation or credential topology, schema, migration, release or deployment.
* In-flight read/revocation ordering, which requires a separate security-policy
  decision before any change to the existing read authorization boundary.

## Inputs

* AP-013 authorization fixtures and existing official MCP Client/SQLite test
  helpers; current three read tools and Registry revision behavior.
* The documented two-second normal outer-query target and initial four-active,
  one-per-Workspace and bounded queue values in `docs/technical-design.md`.
* Bounded synthetic Task, event, credential and private-marker values only.

## Outputs

* Deterministic query/claim/authorization regression fixtures and one
  reproducible MCP timing command for the exact candidate.
* A sanitized observation record naming platform, versions, fixture load,
  sample counts, maximum and percentiles, current/stale/unavailable/failure
  counts, expected/actual results and result locations.
* Explicit residual issue-21, AP-012, Linux and S6 limitations.

## Rules

* R1: Outer queries use committed bounded projections and current Registry
  authorization; they do not wait for Runtime work input or a held synthetic
  callback to finish. If the single SQLite worker is occupied by a long write,
  the existing read timeout yields safe stale or unavailable rather than
  promising a fresh result while that write is held.
* R2: A fresh read begun after revocation, or a read by a foreign Caller,
  cannot obtain a current or cached protected Task, event or cursor. This
  Story preserves the existing read authorization boundary and does not decide
  in-flight read/revocation ordering. A timed-out storage read retains the
  existing honest `stale` or `observation_unavailable` result and never claims
  current progress.
* R3: Measure elapsed time from official Client tool-call start until its full
  result resolves. For each read tool, record at least 50 current successful
  observations under the declared normal synthetic load, maximum, p50, p95 and
  p99, and whether every current response meets two seconds. Count stale,
  unavailable and tool failures separately; none count as successful current
  reads or turn a missed target into a PASS.
* R4: A scripted Execution Reference, macOS timer or fake worker is not a
  Linux Runtime start, credential-isolation proof or trusted Stop Evidence.
  Changed public observation semantics, queue policy, Runtime isolation or
  Stop Evidence claims require a ForgePilot Gate before affected work.

## Expected Errors

* Foreign or unknown protected targets keep the existing bounded `not_found`;
  a fresh read begun after membership revocation keeps `access_denied` after
  valid bearer authentication.
* Storage observation timeout returns an authorized stale snapshot only when
  one is safely available, otherwise the existing `observation_unavailable`.
* A loaded query failure remains a tool failure with its stable code and is
  recorded separately from current-read latency.

## Dependencies

* AP-013 authorization contracts and current SQLite/MCP fixture remain intact;
  their completed Work Item does not supply AP-014 timing Evidence.
* A qualified Linux credential/cgroup-v2 target is still needed for AP-012
  and full issue-21/G5 evidence, but is not a prerequisite to this bounded
  platform-neutral slice.

## Constraints

* Do not infer production latency from synthetic load. Record hardware, OS,
  Node, pnpm, candidate, load parameters and result location with each run.
* Run `make verify`, MCP and affected fault checks for the same candidate;
  use ForgePilot `--snapshot` for intentional uncommitted content.
* No ambient secret, actual credential value or private host path enters a
  versioned fixture or timing log.

## Guidance

Relevant:

* [Engineering entry](../../../guidance/ENTRY.md): test at the owning boundary
  and preserve a single durable source of truth.
* [Development workflow](../../../docs/development-workflow.md): bind machine
  evidence to the actual candidate and gate changed product semantics.

## Trust Boundary Fields

* `bearer` — official MCP Client authentication at the listener.
* `principal` — current Registry membership and Agent allowlist at each read.
* `taskId` — Caller-selected protected Task target or query filter.
* `agentId` — Caller-selected Agent list filter under its current allowlist.
* `cursor` — Caller-presented Task or event pagination position.
* `task.instruction` — Caller-supplied protected text omitted from events and
  measurement records.
* `event.projection` — bounded derived public event metadata under page pressure.
* `snapshot.observationStatus` — derived current/stale status under storage delay.
* `error.details` — derived SQLite, worker or host diagnostic before projection.
* `timing.result` — derived candidate-bound status and latency observation.
