# Story: AP-017 — Terminal Summary Wire Capacity Characterization

## Goal

Measure each observable serialization layer of maximum 100-item terminal Task
summary pages using two deterministic legal Runtime outputs, so maintainers can
decide the remaining 8 MiB response-capacity contract from candidate-bound
evidence without treating an error, truncation, or smaller fixture as success.

## Context

[Issue 21](../../../.scratch/agentport-v0-1/issues/21-load-control-latency.md)
requires message, HTTP, public-content, page, and output-pressure evidence for
S5/G5. [AP-016](../AP-016-serialized-observation-under-slow-client/story.md)
measured a legal large protected Task and a 100-event page, but explicitly did
not establish whether a 100-item terminal `list_tasks` page fits the documented
8 MiB response target after MCP duplicates structured results as JSON text.

[Technical Design](../../../docs/technical-design.md) names a maximum 100-item
page and 8 MiB response target, requires JSON escaping to be counted, and
forbids cutting a single result while presenting it as complete.
[ADR-0001](../../../docs/adr/0001-external-observation-and-control.md) keeps
observation outside Runtime work input. [ADR-0003](../../../docs/adr/0003-local-transactional-task-store.md)
keeps committed Task state in SQLite. [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)
permits platform-neutral protocol and persistence evidence without claiming
Linux Runtime acceptance.

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

* Impact: low
* Boundary: `Runtime candidate framing through durable terminal Task summaries and outer MCP serialization`
* Contract: `capacity evidence measures complete successful responses and preserves the existing authorized projection without selecting new pagination, truncation, lifecycle, or error semantics`
* Owner: `Runtime candidate framing through durable terminal Task summaries and outer MCP serialization = AgentPort protocol and persistence boundaries`

## Risk

* Level: high
* Signal: `bounded-capacity`
* Reason: `public-response-capacity`
* Reason: `serialized-private-result`
* Reason: `false-completeness-evidence`

## Capacity

* Bounded resource: `one authorized outer MCP Task-summary page represented as structured content, JSON text, JSON-RPC response body and HTTP transport output`
* Limit: `documented maximum 100 items and 8 MiB response target; the authoritative byte layer remains unresolved and is not selected by this Story`
* Saturation behavior: `measure current successful complete responses without changing the existing page, transport, truncation or result behavior`
* Failure projection: `record transport, parse, JSON-RPC, MCP, schema, count, cursor or completeness failure as a failed sample; never classify it as a smaller successful response`
* Evidence AC: `AC-03`

## Scope

### In Scope

* Two deterministic terminal summaries derived at the actual Runtime worker
  message and candidate bounds: one private marker followed by repeated U+6F22
  (`漢`) for UTF-8 byte pressure, and one private marker followed by repeated
  U+0022 (`"`) for JSON-escape pressure. For each fixture, binary search the
  greatest repeat count accepted by production framing and prove one additional
  repeated code point is rejected at the owning validator.
* One hundred terminal Tasks per fixture created and completed through existing
  service, worker-observation, SQLite, and verified-stop boundaries, then read
  through the official MCP Client and the existing loopback HTTP transport.
* Exact default 50-item first and second pages, maximum 100-item page, cursor
  behavior, structured and JSON text agreement, the complete loopback response
  body and its constituent JSON layers, and a sanitized candidate-bound record
  containing numeric comparisons with the documented 8 MiB target.
* Authorized projection and privacy checks proving Task summaries omit
  instruction and that result markers do not enter events, errors, audit, or
  the sanitized record.

### Out of Scope

* Changing page defaults or maximums, truncating results, introducing dynamic
  byte pagination, or adding an `output_limit` result, error, Task state, or
  lifecycle transition.
* Choosing which serialization or transport layer the documented 8 MiB target
  governs, declaring capacity compliance, or choosing how a Caller should
  recover from a legal response above any measured layer. Those public capacity
  decisions require a ForgePilot Gate and a separately approved
  behavior-changing candidate.
* The five-second disconnected-Client message, production network
  backpressure, actual Runtime start, trusted Linux Stop Evidence, complete
  Issue 21/S5/G5 exit, S6, or release acceptance.

## Inputs

* Existing worker framing, candidate validation, terminal commit, Task summary,
  list pagination, authorization, and MCP serialization contracts.
* Synthetic identifiers and result content only; no ambient credentials,
  Workspace content, vendor transcript, or host-private path.

## Outputs

* Deterministic UTF-8-byte and JSON-escape acceptance fixtures exercised by the
  production framing path and separate 100-item terminal pages.
* Candidate-bound records containing both fixture derivations, per-item logical
  bytes, worker-frame bytes, structured-result bytes, JSON-text bytes,
  JSON-RPC response-body bytes, page counts, cursor outcomes, platform/tool
  versions, layer-by-layer arithmetic comparisons, and sanitized result
  locations. The record does not name any layer as the public capacity
  authority.
* Explicit residual response-interpretation and behavior decisions, without a
  false capacity, S5/G5, or release claim.

## Rules

* R1: For both `private marker + U+6F22 repetitions` and `private marker +
  U+0022 repetitions`, binary search the greatest repeat count accepted by the
  existing Runtime worker encoding, ingress and storage candidate validators,
  then prove that one additional repeated code point is rejected. Do not inject
  terminal rows directly or bypass legal framing to manufacture a larger
  result.
* R2: A measured response counts only when HTTP, JSON-RPC, MCP tool result,
  output schema, structured/text agreement, authorization, exact page count,
  and complete per-item result summaries all succeed. An MCP error, parse
  failure, short page, omitted summary, or transport abort is not a bounded
  success.
* R3: For each fixture, a no-limit first page returns exactly 50 items and a
  non-null `nextCursor`; its continuation returns exactly 50 items and a null
  `nextCursor`; `limit: 100` returns exactly 100 items and a null `nextCursor`.
  Record bytes for each named serialization layer and its arithmetic relation
  to 8 MiB. Do not select an authoritative layer or declare the product target
  satisfied or violated.
* R4: Instruction remains absent from `list_tasks`; authorized result summary
  stays in the protected Task summary only. Foreign and revoked reads, events,
  audit, errors, logs, and the sanitized record omit private result content.
* R5: Any implementation that changes public pagination, size limits, result
  completeness, error projection, Task lifecycle, or output semantics must stop
  and open a ForgePilot Gate before changing behavior.

## Expected Errors

* Existing `not_found` and `access_denied` conceal foreign and revoked targets.
* An invalid cursor retains the existing bounded validation or concealment
  result; it does not expose result content.
* Characterization must surface transport, parsing, schema, and MCP errors as
  failed samples rather than recasting them as a small successful response.

## Dependencies

* AP-016 / WI-017 is DONE and supplies the approved raw-response and
  candidate-record patterns. Its declared fixture does not answer this Story.
* A later behavior Story depends on this measurement plus a human Gate decision
  that selects the authoritative response layer and any behavior required when
  a legal response exceeds it.

## Constraints

* Keep production tools, schemas, states, codes, page limits, storage schema,
  and Runtime behavior unchanged.
* Do not write raw result payloads to versioned files, logs, audit, or the local
  sanitized record.
* Run focused MCP and affected fault checks plus `make verify` on the same exact
  candidate. Use ForgePilot `--snapshot` for intentional uncommitted content
  and inspect every Acceptance Evidence row before Human Review.

## Guidance

Relevant:

* [Engineering entry](../../../guidance/ENTRY.md): test the owning boundary and
  report limitations honestly.
* [Development workflow](../../../docs/development-workflow.md): bind machine
  Evidence to the actual candidate and gate public semantic changes.

## Trust Boundary Fields

* `bearer` — credential at the loopback MCP listener.
* `principal` — current Registry membership and Agent allowlist for calls.
* `taskId` — protected terminal Task identity.
* `cursor` — Caller-presented Task page position.
* `task.instruction` — protected input omitted from Task summaries.
* `task.result.summary` — protected terminal result visible only in authorized
  Task projections.
* `execution.reference` — synthetic exact claim identity used to reach a
  verified terminal state.
* `limit.result` — derived byte counts and per-layer arithmetic comparisons in
  the sanitized candidate record.
