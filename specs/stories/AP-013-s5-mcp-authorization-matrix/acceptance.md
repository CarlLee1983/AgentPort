# Acceptance Criteria

## Happy Path

* [ ] AC-01: all ten existing MCP tools enforce current Access Scope membership
      and Agent allowlist for their reads and mutations. Two distinct authorized
      Principals in one Scope can perform permitted handoffs, and bounded audit
      records the actual actor without replacing either identity.

## Business Rules

* [ ] AC-02: foreign or unknown Task, Agent, Context, Question and cursor values
      do not enumerate protected records. Membership revocation or Agent binding
      change before a mutation commit rejects it without a new receipt, Task
      side effect or Runtime generation; stale pre-dispatch authority remains
      blocked. Existing stable error and audit contracts are preserved.

## Failure Cases

* [ ] AC-03: missing or invalid bearer returns HTTP 401, unknown tool or invalid
      schema creates no Task or receipt, and business conflicts keep their
      existing stable application code. Querying a failed Task remains a
      successful bounded tool response with its existing protected instruction
      and Question fields for an authorized Caller. Synthetic private prompt,
      answer, credential, host-path and foreign-identity markers are absent from
      unauthorized responses, errors, events, sanitized audit records and logs.

## Regression Requirements

* [ ] AC-04: the ten-tool matrix names candidate, fixture, expected and actual
      result, durable state and audit location for each row. `make verify`,
      `pnpm run test:mcp` and affected fault checks pass on the same candidate;
      the existing tool inventory and public error codes remain unchanged.
* [ ] AC-05: Human Review checks the full matrix, any owning-boundary fixes,
      final diff, authorization races and residual issue-20/G5 limits. This
      partial Story does not claim complete authorization, Linux evidence,
      S5/G5 or S6 acceptance.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/acceptance/s5-mcp-authorization-matrix.test.ts` | `official MCP Client, real SQLite, ten existing tools and two Principals in one Access Scope` | `permitted reads and mutations use current membership/allowlist and persist bounded audit under the actual actor` |
| `AC-02` | test | `tests/acceptance/s5-mcp-authorization-matrix.test.ts; tests/integration/registry-revision-fence.test.ts` | `two Access Scopes, foreign protected identifiers and pre-commit membership/binding race barriers` | `indistinguishable bounded rejection, no unauthorized receipt or Task side effect and no new generation` |
| `AC-03` | test | `tests/acceptance/s5-mcp-authorization-matrix.test.ts; tests/acceptance/authorization.test.ts` | `synthetic bearer, unknown tool, invalid schema, failed Task, conflict and private-marker fixtures` | `401/protocol/application results preserve existing codes; authorized snapshots retain protected fields while unauthorized/error/event/audit/log sinks omit private markers` |
| `AC-04` | command | `make verify && pnpm run test:mcp && pnpm run test:faults` | `same exact candidate, recorded ten-tool matrix and unchanged public tool/error inventory` | `required checks exit zero and every row records expected/actual durable and audit evidence` |
| `AC-05` | human | `ForgePilot Human Review record` | `current candidate, complete matrix, final diff and remaining issue-20/G5 gaps` | `security findings and residual limits are assessed without a G5 or S6 completion claim` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `bearer` | `synthetic-missing-or-wrong-bearer` | reject | `bounded protocol audit metadata` | `tests/acceptance/s5-mcp-authorization-matrix.test.ts` |
| `principal` | `revoked-scope-member` | reject | `sanitized authorization audit code` | `tests/acceptance/s5-mcp-authorization-matrix.test.ts` |
| `agentId` | `foreign-agent-id` | reject | `bounded application error` | `tests/acceptance/s5-mcp-authorization-matrix.test.ts` |
| `taskId` | `foreign-task-id` | reject | `bounded application error` | `tests/acceptance/s5-mcp-authorization-matrix.test.ts` |
| `contextId` | `foreign-context-id` | reject | `bounded application error` | `tests/acceptance/s5-mcp-authorization-matrix.test.ts` |
| `questionId` | `foreign-question-id` | reject | `bounded application error` | `tests/acceptance/s5-mcp-authorization-matrix.test.ts` |
| `cursor` | `foreign-event-cursor` | reject | `bounded application error` | `tests/acceptance/s5-mcp-authorization-matrix.test.ts` |
| `operationId` | `same-key-conflicting-input` | reject | `sanitized operation receipt or conflict` | `tests/acceptance/s5-mcp-authorization-matrix.test.ts` |
| `registry.binding` | `stale-agent-binding-revision` | reject | `sanitized authorization audit code` | `tests/integration/registry-revision-fence.test.ts` |
| `question.answer` | `synthetic-private-answer-marker` | preserve | `protected durable Question record and authorized Task snapshot only` | `tests/acceptance/s5-mcp-authorization-matrix.test.ts` |
| `error.details` | `synthetic-prompt-credential-path-and-foreign-identity` | redact | `bounded unauthorized error, event, audit and log` | `tests/acceptance/s5-mcp-authorization-matrix.test.ts` |

## Verification Notes

The named S5 matrix fixture is required candidate-bound Evidence. Reuse the
S4 authorization, Registry revision-fence and product-audit fixtures rather
than duplicating their implementation. Record first failures and later passing
runs separately. No Linux Runtime-account or external HTTPS Evidence follows
from a local MCP Client pass.
