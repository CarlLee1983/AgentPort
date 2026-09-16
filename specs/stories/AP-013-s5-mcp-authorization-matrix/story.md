# Story: AP-013 — S5 MCP Authorization and Non-Enumeration Matrix

## Goal

Give authorized Callers consistent access to the ten existing MCP tools while
preventing foreign or revoked Callers from learning about or changing accepted
work during normal calls and authorization races.

## Context

This is a bounded part of [historical issue 20](../../../.scratch/agentport-v0-1/issues/20-authorization-policy-verification.md)
and a prerequisite to [issue 21's S5/G5 load exit](../../../.scratch/agentport-v0-1/issues/21-load-control-latency.md).
AP-008 established the ten-tool inventory and S4 authorization fixtures;
AP-002 established current Registry membership, Agent allowlist and revision
fences. This Story extends those fixtures with one candidate-bound adversarial
matrix. It does not close all of issue 20 or claim G5.

[ADR-0001](../../../docs/adr/0001-external-observation-and-control.md)
keeps query and cancel independent of Runtime input.
[ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md)
forbids replay of uncertain execution. The current Protocol Adapter, core
authorization and SQLite receipt/audit boundaries own the behavior under test.

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

* Impact: high
* Boundary: `MCP Protocol Adapter to core Registry authorization and SQLite receipts/audit`
* Contract: `Every existing tool uses current Principal and Agent authorization; a revoked or foreign request cannot create a durable side effect or reveal protected identifiers`
* Owner: `MCP Protocol Adapter to core Registry authorization and SQLite receipts/audit = AgentPort protocol and persistence boundaries`

## Risk

* Level: high
* Reason: `security-authorization`
* Reason: `concurrent-revocation`
* Reason: `private-data-projection`

## Scope

### In Scope

* Candidate-bound official MCP Client and real SQLite adversarial fixtures for
  all ten existing tools, with two distinct Principals in one Access Scope and
  a second foreign Access Scope.
* Current Registry membership, Agent allowlist and binding revision checks at
  reads, mutations and pre-dispatch; race barriers before durable commit.
* Foreign Task, Agent, Context, Question and cursor identifiers, stable bearer,
  protocol and application errors, bounded public projections and sanitized
  product audit records.
* Bounded fixes only where a stable fixture demonstrates a violation at the
  existing owning boundary, with regression coverage for affected sibling tools.

### Out of Scope

* Completing issue 20's Linux Runtime-account, protected vendor credential,
  native AskUserQuestion policy or external HTTPS ingress evidence.
* Issue 21's load and latency measurements, AP-012's worker-entrypoint deadline
  and designated Linux Stop Evidence, G5, S6 operational acceptance or G6.
* New MCP tools, public error codes, Task/Context semantics, privilege topology,
  network trust policy, schema, dependency or migration.

## Inputs

* AP-002 and AP-008 authorization contracts and current ten-tool inventory.
* Existing `tests/acceptance/s4-authorization.test.ts`,
  `tests/acceptance/authorization.test.ts`,
  `tests/integration/registry-revision-fence.test.ts` and real SQLite fixture.
* Bounded synthetic identifiers, prompts and answers; no ambient credential or
  private host path enters versioned fixtures.

## Outputs

* One traceable ten-tool security matrix with expected/actual authorization,
  durable side-effect, public-error and audit observations.
* Focused regression coverage and only necessary owning-boundary fixes.
* Sanitized candidate evidence and explicit remaining issue-20/G5 limitations.

## Rules

* R1: Every tool checks the current Principal's Access Scope membership and
  Agent allowlist at the operation's authorized boundary. Same-scope Principals
  may act under their own identity; audit records the actual actor.
* R2: Foreign and unknown protected identifiers are indistinguishable to the
  Caller. Revocation or binding change before commit rejects the pending
  mutation; pre-dispatch cannot launch a new generation under stale authority.
* R3: Bearer authentication stays distinct from application authorization.
  Protocol/schema rejection creates no Task or receipt; failed Task lookup
  remains a bounded successful query of a Task, not a tool failure.
* R4: Authorized Task and Question snapshots retain their existing protected
  instruction, schema and answer fields. Unauthorized responses, errors,
  events, audit and logs expose only approved bounded metadata; synthetic
  private markers never appear in those sinks.
* R5: Exercise existing contracts only. A different public result, Runtime
  isolation, ingress trust or lifecycle semantic requires a ForgePilot Gate
  before the affected change.

## Expected Errors

* Missing or invalid bearer returns HTTP 401 before tool processing.
* Unknown or foreign targets return the existing bounded `not_found` result;
  conflicting operations keep their existing stable application code.
* A stale Registry revision rejects a mutation before its durable side effect
  or new Runtime generation. The matrix records actual result and audit code.

## Dependencies

* AP-002 and AP-008 contracts remain available; their completed Work Items do
  not substitute for this candidate-bound matrix.
* This partial authorization slice precedes issue 21's complete S5/G5 exit.
  Unavailable qualified Linux credential evidence remains a separate blocker.

## Constraints

* Do not alter approved public semantics or create a production stopgap.
* Run `make verify`, `pnpm run test:mcp` and affected fault checks on the exact
  candidate. Record dirty-tree evidence only with ForgePilot `--snapshot`.
* No commit, push, deployment, Gate resolution or Human Review approval is
  authorized by this Story.

## Guidance

Relevant:

* [Engineering entry](../../../guidance/ENTRY.md): test behavior at the
  owning boundary and preserve one durable source of truth.
* [Development workflow](../../../docs/development-workflow.md): verify the
  actual candidate and open a Gate for semantic decisions.

## Trust Boundary Fields

* `bearer` — Caller-presented credential at the MCP listener.
* `principal` — authenticated Caller identity and current Registry membership.
* `agentId` — Caller-selected Logical Agent looked up under its allowlist.
* `taskId` — Caller-supplied Task identifier for query, mutation or retry.
* `contextId` — Caller-supplied Context identifier for follow-up or resume.
* `questionId` — Caller-supplied Question identifier for a reply.
* `cursor` — Caller-supplied pagination or event cursor.
* `operationId` — Caller-supplied idempotency key for a mutation.
* `registry.binding` — administrator-controlled Agent/Workspace/runtime policy
  revision read at authorization and pre-dispatch.
* `question.answer` — private Caller reply committed only to protected storage.
* `error.details` — derived protocol, Registry, SQLite or worker diagnostic
  material before public and audit projection.
