# Story: AP-019 — Enforce Terminal Summary Capacity-safe Pagination

## Goal

An authorized Caller can drain terminal `agentport_list_tasks` summaries through
the existing cursor without any complete uncompressed UTF-8 JSON-RPC response
body exceeding 8 MiB, even when a requested 50- or 100-item page does not fit.

## Context

[AP-017](../AP-017-terminal-summary-wire-capacity/story.md) characterized the
actual serialization layers for legal terminal pages. [AP-018](../AP-018-terminal-summary-response-capacity-decision/story.md), its human-resolved Gate,
and [ADR-0005](../../../docs/adr/0005-terminal-summary-response-capacity.md)
selected the complete AgentPort-generated uncompressed UTF-8 JSON-RPC response
body as the inclusive 8,388,608-byte authority.

The current `AgentExecutionService.listTasks` seals a cursor after an
item-count slice. This Story moves capacity selection to the owning terminal
Task-page response seam before that cursor is sealed. It implements only the
selected terminal `agentport_list_tasks` contract; it does not generalize the
rule to other tools or claim Issue 21/S5/G5, proxy/backpressure, Linux, S6, or
release acceptance.

## Classification

* Security sensitive: yes
* Baseline conformance: yes
* Task mode: execution

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
* Contract: `the complete AgentPort-generated uncompressed UTF-8 JSON-RPC response body is at most 8,388,608 bytes and capacity selection precedes terminal Task cursor sealing`
* Owner: `terminal agentport_list_tasks application response = AgentPort MCP protocol boundary`

## Risk

* Level: high
* Signal: `bounded-capacity`
* Reason: `public-response-capacity`
* Reason: `cursor-recovery-compatibility`
* Reason: `authorized-result-disclosure`

## Capacity

* Bounded resource: `one authorized terminal agentport_list_tasks complete uncompressed UTF-8 JSON-RPC response body`
* Limit: `8,388,608 bytes inclusive, counting the JSON-RPC envelope, structuredContent, equivalent JSON TextContent, echoed request ID, cursor and every other AgentPort-generated bounded envelope field`
* Saturation behavior: `treat requested/default limit as an upper bound and return the greatest capacity-safe prefix of complete authorized summaries plus a non-null cursor sealed after its final item`
* Failure projection: `a page never truncates a summary, omits an authorized item behind a terminal cursor, slices an already-sealed larger page, or introduces a page-level output_limit error`
* Evidence AC: `AC-003`

## Scope

### In Scope

* The terminal `agentport_list_tasks` path from its authorized page query,
  through successful MCP result construction and the complete JSON-RPC body
  emitted by the loopback HTTP handler.
* Capacity-aware selection of a prefix before the existing cursor is encoded,
  preserving default 50 and maximum 100 as requested upper bounds.
* Tests that exercise all legal terminal summary shapes and relevant bounded
  JSON-RPC envelope values, then drain capacity-reduced, filtered, and normal
  pages through the existing cursor exactly once.
* Regression coverage for authorization, foreign/revoked concealment,
  retention cursor expiry, structured/text agreement, and the unchanged nine
  other product tools.

### Out of Scope

* Page-capacity behavior for `agentport_get_task`, `agentport_get_events`, or
  any tool other than terminal `agentport_list_tasks`.
* New tool names, schemas, public result or error codes, cursor format, storage
  schema, Task lifecycle, HTTP-header, compression, TLS, proxy, or transport
  framing limits.
* Five-second disconnected-Client messaging, production backpressure evidence,
  real Runtime dispatch, trusted Linux Stop Evidence, complete Issue 21/S5/G5,
  S6, deployment, publication, or release acceptance.

## Inputs

* The AP-017 candidate-bound serialization characterization.
* AP-018/WI-019's accepted ADR-0005 capacity and recovery decision.
* Existing Task summary projection, authorization, filter/retention cursor
  binding, MCP result construction, and loopback JSON-RPC handler.

## Outputs

* A single owning module at the terminal Task-page response seam that selects
  the complete safe prefix and seals a continuation cursor only after it.
* Candidate-bound tests proving complete-body size, safe cursor recovery, and
  authorization/concealment under legal high-amplification summaries.
* Updated technical design and operations-facing compatibility wording that
  identifies the implemented upper-bound pagination behavior without extending
  it to other tools.

## Rules

* R1: Measure the same complete uncompressed UTF-8 JSON-RPC response that
  AgentPort emits, including JSON-RPC fields, `structuredContent`, equivalent
  JSON TextContent, cursor, and echoed request ID. HTTP headers, transfer
  framing, compression, TLS, and proxy encoding remain excluded.
* R2: Authorize, validate filters, and validate/conceal any presented cursor
  before capacity selection. Capacity logic cannot disclose private content,
  turn foreign `not_found` into a different result, or turn revoked
  `access_denied` into a successful page.
* R3: Select only complete summaries, then encode `nextCursor` after the final
  selected Task. A non-null cursor must lead to every remaining authorized Task
  exactly once; a null cursor is valid only when no authorized Task remains.
* R4: The default 50 and maximum 100 remain requested upper bounds. When all
  requested items fit, normal pages preserve their existing cardinality and
  cursor behavior; when they do not, a smaller non-empty safe prefix is
  returned without a new page-level error.
* R5: If the implementation cannot prove that one legal terminal summary plus
  all bounded response fields fits, stop affected work and open a ForgePilot
  Gate. Do not truncate the summary or invent an unapproved projection.
* R6: No adapter may trim an already-created larger page. The module that owns
  capacity selection must receive enough authorized ordered candidates to
  construct the emitted result and seal the cursor for that exact prefix.

## Expected Errors

* Existing foreign and malformed cursor handling remains `not_found`; retention
  expiry remains `cursor_expired`; revoked membership remains `access_denied`.
* Invalid list input remains `validation_error`. No terminal page-capacity
  `output_limit` result or error is added.
* An impossible legal one-item response pauses this work for a human Gate; it
  is not silently made smaller or projected as successful.

## Dependencies

* AP-018 / WI-019 is DONE with the accepted ADR-0005 decision.
* The implementation Work Item depends on WI-019 in ForgePilot.

## Constraints

* Preserve the existing ten tool names, input/output schemas, public codes,
  storage schema, Task lifecycle, authorization and cursor format.
* Do not copy raw terminal summaries or private markers to committed files,
  audit, logs, or test records.
* Test the actual product serialization seam; estimates based only on summary
  bytes or adapter-local payloads are insufficient.
* Run focused checks and `make verify` against the exact candidate, then bind
  the matching clean revision or snapshot through ForgePilot before review.

## Guidance

Relevant:

* [ADR-0005](../../../docs/adr/0005-terminal-summary-response-capacity.md):
  capacity authority and cursor recovery contract.
* [Engineering entry](../../../guidance/ENTRY.md): verify behavior at its
  owning seam and do not promote guidance to unapproved product scope.
* [Development workflow](../../../docs/development-workflow.md): bind machine
  evidence to the exact candidate and obtain Human Review for completion.

## Trust Boundary Fields

* `bearer` — credential at the MCP listener.
* `principal` — current Registry membership and Agent allowlist.
* `agentId`, `state`, and `limit` — Caller-selected Task-page filters and
  upper bound.
* `cursor` — Caller-presented authorized Task-page position.
* `jsonrpc.id` — echoed request field included in the response capacity bound.
* `task.instruction` — protected Task input omitted from summaries.
* `task.result.summary` — protected terminal result disclosed only to an
  authorized Task-page reader.

## Superseded Behavior

* `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` — the prior
  characterization fixture requires exact 50/100 successful terminal page
  cardinality even when a legal complete response exceeds the selected 8 MiB
  authority. AP-019 retains those cardinalities only when they fit and replaces
  them with capacity-safe upper-bound pagination otherwise.
