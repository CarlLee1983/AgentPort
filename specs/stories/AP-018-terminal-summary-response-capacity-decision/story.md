# Story: AP-018 — Terminal Summary Response Capacity Decision

## Goal

Select the authoritative 8 MiB application-response layer and Caller recovery
contract for terminal `agentport_list_tasks` pages, using AP-017's
candidate-bound measurements without silently changing public behavior.

## Context

[Issue 21](../../../.scratch/agentport-v0-1/issues/21-load-control-latency.md)
requires page, HTTP, public-content and backpressure limits to be explicit
before S5/G5 exit. [AP-017](../AP-017-terminal-summary-wire-capacity/story.md)
proved that legal terminal pages can remain below 8 MiB at one serialization
layer while exceeding it at an enclosing layer, and deliberately left the
authoritative layer, pagination and `output_limit` semantics unresolved.

The current MCP adapter publishes the same successful payload as structured
content and JSON TextContent. The technical design also names a default of 50
items, a maximum of 100 items and an 8 MiB response target. Those declarations
do not identify whether the target governs the structured payload or the
uncompressed JSON-RPC response body. Selecting either interpretation changes
the public capacity contract and therefore requires a ForgePilot Gate and an
architecture record before any behavior candidate is authorized.

[ADR-0005](../../../docs/adr/0005-terminal-summary-response-capacity.md)
records the selected contract: the complete AgentPort-generated uncompressed
UTF-8 JSON-RPC response body is authoritative, and capacity-safe cursor
pagination preserves complete items when a requested count does not fit.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: architecture

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: no
* push: no
* deploy: no

## Architecture

* Impact: high
* Boundary: `terminal agentport_list_tasks application response`
* Contract: `terminal agentport_list_tasks uses the complete AgentPort-generated uncompressed UTF-8 JSON-RPC body as the inclusive 8 MiB authority and returns a complete capacity-safe prefix plus nextCursor before a separate behavior Story changes pagination`
* Owner: `terminal agentport_list_tasks application response = AgentPort MCP protocol boundary`

## Risk

* Level: high
* Signal: `bounded-capacity`
* Reason: `public-contract`
* Reason: `private-result-amplification`
* Reason: `cursor-recovery-compatibility`

## Capacity

* Bounded resource: `one authorized terminal agentport_list_tasks application response`
* Limit: `8,388,608 bytes inclusive for the complete AgentPort-generated uncompressed UTF-8 JSON-RPC response body`
* Saturation behavior: `treat limit as an upper bound and return a capacity-safe prefix of complete Task summaries with a non-null nextCursor sealed after the final returned Task; this Story changes no runtime behavior`
* Failure projection: `no page-level output_limit is introduced; truncation, omitted summaries, skipped cursor items or a terminal cursor with undisclosed remaining items are forbidden`
* Evidence AC: `AC-03`

## Scope

### In Scope

* The terminal `agentport_list_tasks` page measured by AP-017, including its
  structured result, equivalent JSON TextContent and enclosing uncompressed
  UTF-8 JSON-RPC response body.
* The selected complete-body authority, capacity-safe cursor pagination and
  rejected alternatives recorded by ForgePilot and ADR-0005.
* An accepted `ADR-0005` and matching technical-design wording after the Gate
  is resolved, including compatibility, security, rollback and follow-on
  implementation consequences.
* Requirements for a separately approved behavior Story if the selected
  contract differs from current behavior.

### Out of Scope

* Product code, tests that change expected product behavior, page-limit or
  cursor implementation, new public errors, schema, storage or lifecycle
  changes in this architecture-only Story.
* Extending the decision to `agentport_get_task`, `agentport_get_events` or the
  other seven tools without their own worst-case evidence.
* Five-second Client outage messaging, TLS/proxy/on-wire bytes, compression,
  production network backpressure, actual Runtime start, trusted Linux Stop
  Evidence, complete Issue 21/S5/G5, S6 or release readiness.

## Inputs

* AP-017 Story, Acceptance Evidence, ForgePilot evidence and latest sanitized
  terminal-summary capacity record.
* Current MCP adapter result shape, list input schema, cursor ownership and the
  technical-design capacity declarations.

## Outputs

* One human-resolved ForgePilot Gate that records the chosen authoritative
  layer, saturation behavior and Caller recovery contract.
* `docs/adr/0005-terminal-summary-response-capacity.md` with the decision,
  rationale, rejected alternatives and non-obvious consequences.
* Consistent capacity language in `docs/technical-design.md` and an explicit
  boundary for the later behavior Story, without a behavior implementation in
  this Work Item.

## Rules

* R1: The complete AgentPort-generated uncompressed UTF-8 JSON-RPC response
  body is the authoritative layer. It includes the JSON-RPC envelope,
  `structuredContent`, equivalent JSON TextContent and all bounded envelope
  fields including the echoed request ID; it excludes HTTP headers, transfer
  framing, compression, TLS and proxy-specific encoding.
* R2: The inclusive maximum is 8,388,608 bytes. The later behavior Story must
  prove the response bound against every legal terminal summary and bounded
  envelope field rather than infer it from AP-017's two measurements.
* R3: A cursor-pagination decision must define `limit` as an upper bound, apply
  the safe count before the cursor is sealed, and preserve every complete item
  exactly once. Adapter-side slicing after a cursor for a larger page has been
  created is forbidden because it can skip undisclosed items.
* R4: Default 50 and maximum 100 remain requested item-count upper bounds, not
  guaranteed response cardinalities. Capacity recovery uses the existing
  cursor and introduces no page-level `output_limit` result or error.
* R5: No option permits truncating a result summary, omitting a legal item while
  returning a terminal cursor, weakening authorization, copying private result
  text into decision evidence, or claiming HTTP proxy/backpressure acceptance.
* R6: After the human resolves the Gate, record the exact decision in ADR-0005
  and the technical design. Any required behavior change belongs to a new,
  separately approved execution Story and Work Item.

## Expected Errors

* While unresolved, the ForgePilot Gate blocks decision recording and all
  affected behavior work until a human resolution exists.
* Missing or inconsistent AP-017 candidate evidence prevents acceptance of the
  architecture record; it is not replaced by an estimate copied into this
  Story.
* If the later implementation cannot prove that one legal Task summary plus
  the bounded response envelope fits, it must stop and open a new Gate rather
  than truncate the item or invent an unapproved failure contract.

## Dependencies

* AP-017 / WI-018 is DONE and supplies the candidate-bound serialization-layer
  characterization; its evidence does not select this decision.
* The later behavior Story depends on this Work Item's human Gate resolution
  and accepted ADR. It must not become implementation authorization unless both
  exist.

## Constraints

* Preserve the existing ten public tools, schemas, codes, Task lifecycle,
  storage schema, Runtime behavior and page behavior during this Work Item.
* Do not copy raw terminal summaries or private markers into versioned files,
  ForgePilot rationale, audit, logs or decision records.
* Run the Story contract check and `make verify` on the exact documentation
  candidate after the Gate resolution is recorded; use ForgePilot snapshot
  verification for intentional uncommitted content.

## Guidance

Relevant:

* [Engineering entry](../../../guidance/ENTRY.md): approved intent remains
  authoritative and acceptance stays at the owning boundary.
* [Development workflow](../../../docs/development-workflow.md): a public API
  semantic decision requires a human-resolved ForgePilot Gate.
* [Domain model](../../../CONTEXT.md): Caller and Protocol Adapter remain
  distinct from Runtime and transport deployment concerns.

## Trust Boundary Fields

* `limit` — Caller-selected maximum item count at MCP input.
* `cursor` — Caller-presented authorized pagination position.
* `task.result.summary` — protected terminal result amplified by serialization.
* `result.structuredContent` — public authorized structured MCP result.
* `result.content[0].text` — public authorized JSON TextContent duplicate.
* `jsonrpc.responseBody` — derived uncompressed UTF-8 application response.
* `error.code` — proposed public saturation result if the Gate selects failure.
* `decision.evidence` — sanitized measurements and rationale admitted to the ADR.
