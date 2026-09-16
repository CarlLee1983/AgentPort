# Acceptance Criteria

## Happy Path

* [ ] AC-01: a reproducible real-SQLite fixture holds four scripted Execution
      References on distinct Workspaces, leaves a same-Workspace FIFO successor
      queued and exercises documented active/queue bounds. Under configured
      general-receipt saturation, new work is rejected while per-Task reply,
      cancel and interruption-acknowledgement control capacity remains reserved.
      An eligible call for each tool commits and replays its durable receipt
      while saturated; acknowledgement uses only a labeled scripted stopped
      precondition. Claim/Task state and synthetic start count are recorded
      without Runtime or trusted Stop Evidence claims.

## Business Rules

* [ ] AC-02: official MCP Client `cancel_task` on an active Task under configured
      general-receipt saturation, held synthetic ingress, concurrent polling and
      bounded event/audit pressure
      commits one cancel intent and returns `stopping` without waiting for the
      held stop callback. The exact Workspace claim remains held and the Task
      does not become terminal while stop confirmation is unknown; identical
      operation replay returns the same committed outcome.
* [ ] AC-03: loaded official Client `reply` under configured general-receipt
      saturation commits the first valid Question
      answer/receipt, preserves pending or unknown delivery until acknowledged
      and replays identical input without answer redelivery. Loaded
      `acknowledge_interruption` under the same saturation rejects before the
      existing same-Reference
      stopped precondition, then commits/replays `interrupted` only after a
      clearly labeled scripted precondition. All three tools retain current
      authorization and conceal foreign/revoked targets and private markers.
      With the SQLite worker available under the stated load, full official-
      Client responses for reply, cancel and acknowledgement each meet a
      two-second fixture target; their sample counts, maxima and percentiles
      are recorded separately from unavailable/ambiguous storage outcomes.

## Failure Cases

* [ ] AC-04: controlled SQLite delay, write timeout and physical storage fault
      fixtures distinguish committed success from ambiguous/unavailable control
      responses. An identical-operation retry after worker recovery discovers
      the durable winner without a second answer, cancel intent, terminal
      result or Runtime start; classified physical failure closes new dispatch
      and does not release an unconfirmed claim.

## Regression Requirements

* [ ] AC-05: `pnpm run test:control-load`, `pnpm run test:mcp`, affected fault
      checks and `make verify` pass on the same exact candidate. A sanitized
      control record names platform/tool versions, fixture load, separate full-
      response timing distributions for all three controls, synthetic vs actual
      start counts, expected/actual Task/Question/receipt/claim outcomes and
      result location. The ten existing tools, public codes, authorization,
      reserve and durable claim contracts remain compatible.
* [ ] AC-06: Human Review checks the control record, deterministic invariants,
      final diff and residual issue-21/AP-012/Linux limits. This slice does not
      claim the five-second Client outage, production backpressure, trusted Stop
      Evidence, complete G5, S6 or production acceptance.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/integration/s5-outer-control-load.test.ts` | `real SQLite, four distinct scripted held Workspace claims, FIFO successor, documented queue bound, configured general-receipt saturation and eligible reply/cancel/ack targets (ack uses a labeled scripted stopped precondition)` | `new admission rejects while all three eligible controls commit and replay durable receipts from their per-Task reserves; claim/Task states and synthetic start count remain durable, with no trusted Stop Evidence claim` |
| `AC-02` | test | `tests/acceptance/s5-outer-mcp-control-load.test.ts` | `official MCP Client, loopback endpoint, real SQLite, configured general-receipt saturation, held synthetic ingress/stop callback, concurrent polling and bounded event/audit pressure` | `one committed cancel intent and replayed stopping snapshot resolve before callback release despite saturation; exact claim remains held without terminal or false stop` |
| `AC-03` | test | `tests/acceptance/s5-outer-mcp-control-load.test.ts` | `official MCP Client, general-receipt saturation, durable Question and receipt, uncertain delivery, scripted same-Reference stopped precondition, foreign and post-revocation actors; worker available under stated load` | `one answer/replay and existing interruption-ack branches commit despite saturation and preserve authorization, private data and honest delivery/stop state; full Client responses for all three controls meet two-second fixture target with separate counts, maxima and percentiles` |
| `AC-04` | test | `tests/integration/s5-control-storage-pressure.test.ts` | `real SQLite worker delay, write timeout, physical failure, same-operation retry and active held claim` | `actual receipt resolves ambiguity; failure closes dispatch and never duplicates control, invents terminal status or frees an unconfirmed claim` |
| `AC-05` | command | `pnpm run test:control-load && pnpm run test:mcp && pnpm run test:faults && make verify` | `same exact candidate, focused fixtures, unchanged public inventory and sanitized local result record` | `required commands exit zero; record names fixture load, versions, separate full-response distributions and unavailable outcomes, expected/actual durable outcomes and result location` |
| `AC-06` | human | `ForgePilot Human Review record` | `current candidate, control record, deterministic fixtures, final diff and residual G5/Linux gap` | `reviewer assesses loaded control without a Client-outage, Linux Stop Evidence, G5, S6 or release claim` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `bearer` | `ap015-invalid-bearer` | reject | `bounded HTTP/auth audit metadata` | `tests/acceptance/s5-outer-mcp-control-load.test.ts` |
| `principal` | `ap015-revoked-before-fresh-control` | reject | `bounded application error and sanitized audit outcome` | `tests/acceptance/s5-outer-mcp-control-load.test.ts` |
| `agentId` | `ap015-foreign-agent-admission` | reject | `bounded application error` | `tests/acceptance/s5-outer-mcp-control-load.test.ts` |
| `taskId` | `ap015-foreign-protected-task` | reject | `bounded application error` | `tests/acceptance/s5-outer-mcp-control-load.test.ts` |
| `questionId` | `ap015-foreign-question` | reject | `bounded application error` | `tests/acceptance/s5-outer-mcp-control-load.test.ts` |
| `operationId` | `ap015-identical-control-retry` | preserve | `protected scoped operation receipt` | `tests/acceptance/s5-outer-mcp-control-load.test.ts; tests/integration/s5-control-storage-pressure.test.ts` |
| `expectedRevision` | `ap015-stale-ack-revision` | reject | `bounded application error` | `tests/acceptance/s5-outer-mcp-control-load.test.ts` |
| `question.answer` | `AP015-PRIVATE-ANSWER-MARKER` | preserve | `protected durable Question/authorized snapshot only` | `tests/acceptance/s5-outer-mcp-control-load.test.ts` |
| `cursor` | `ap015-foreign-event-cursor` | reject | `bounded application error` | `tests/acceptance/s5-outer-mcp-control-load.test.ts` |
| `execution.reference` | `ap015-held-synthetic-reference` | preserve | `protected SQLite claim, omitted from audit/control record` | `tests/integration/s5-outer-control-load.test.ts; tests/acceptance/s5-outer-mcp-control-load.test.ts; pnpm run test:control-load` |
| `stop.precondition` | `ap015-scripted-stopped-before-ack` | preserve | `test-only core/SQLite branch, no Linux proof claim` | `tests/acceptance/s5-outer-mcp-control-load.test.ts` |
| `event.projection` | `ap015-bounded-control-page` | preserve | `bounded public Task events` | `tests/acceptance/s5-outer-mcp-control-load.test.ts` |
| `error.details` | `AP015-PRIVATE-DIAGNOSTIC-MARKER` | redact | `bounded public error and sanitized audit` | `tests/integration/s5-control-storage-pressure.test.ts` |
| `control.result` | `ap015-synthetic-control-outcome` | preserve | `sanitized local candidate record` | `pnpm run test:control-load` |

## Verification Notes

These named fixtures and command are required future Evidence, not historical
passes. Measure full official-Client responses with a monotonic clock and keep
durable control assertions separate from wall-clock distributions. Record first
failures and later passing observations, bind all automated results to the exact
ForgePilot candidate and distinguish synthetic
starts/stopped preconditions from actual Runtime and trusted Stop Evidence.
Configured saturation is not physical storage failure; a timeout is not proof
of rejection. No macOS or fake-worker fixture establishes AP-012 Linux deadline,
credential isolation, issue-21/G5 exit, S6 or production readiness.
