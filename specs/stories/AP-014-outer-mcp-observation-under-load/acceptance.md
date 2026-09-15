# Acceptance Criteria

## Happy Path

* [ ] AC-01: a reproducible platform-neutral fixture holds four scripted
      Execution References on distinct Workspaces, leaves a same-Workspace
      successor queued in FIFO order and exercises the documented queue bound.
      It records claim/Task state and synthetic start count without claiming
      actual Runtime starts or Stop Evidence.

## Business Rules

* [ ] AC-02: official MCP Client `get_task`, `list_tasks` and `get_events`
      remain current-authorized and bounded while synthetic ingress is held,
      SQLite reads/writes are delayed, event pages approach their bounds and Clients
      poll concurrently. They do not wait for Runtime input; when the single
      SQLite worker is occupied by a long write, the existing read timeout
      bounds the wait with safe stale or unavailable instead of promising a
      fresh result. Foreign targets and fresh reads begun after revocation
      with a warmed cache remain concealed, without false current progress.

## Failure Cases

* [ ] AC-03: a candidate-bound run records at least 50 current successful
      full-response timings per read tool under declared normal synthetic load,
      the maximum, p50, p95 and p99, and the actual result against the two-second
      target. It records stale, unavailable and failed calls separately, plus
      hardware, OS, versions, fixture load and result location. A missed target
      or unavailable-only run cannot be reported as a passing current-query
      observation.

## Regression Requirements

* [ ] AC-04: the focused observation command, `test:mcp`, affected fault checks
      and `make verify` pass on the same exact candidate; the three existing
      tool contracts, public error codes, authorization and durable claim
      behavior remain unchanged.
* [ ] AC-05: Human Review checks the measured distribution, deterministic
      invariants, final diff and remaining issue-21/AP-012/Linux limits. This
      slice does not claim complete G5, S6 or production latency acceptance.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/integration/s5-outer-observation-load.test.ts` | `real SQLite, four distinct scripted held Workspace claims, queued successor and bounded queue fixture` | `claim and FIFO state remain durable; synthetic start count is labeled and no trusted Stop Evidence is claimed` |
| `AC-02` | test | `tests/acceptance/s5-outer-mcp-observation-load.test.ts` | `official MCP Client, loopback endpoint, real SQLite, held synthetic ingress, delayed read/write, event and polling pressure, foreign actor and fresh post-revocation read with warmed cache` | `bounded current/stale/unavailable read and current authorization; no Runtime-input wait, cross-scope data or false current progress` |
| `AC-03` | command | `pnpm run test:observation-load` | `same candidate, recorded macOS host, at least 50 current successful responses per tool under declared normal synthetic load` | `record sample counts, maximum, p50/p95/p99, two-second result, separate non-current counts and sanitized result location` |
| `AC-04` | command | `make verify && pnpm run test:mcp && pnpm run test:faults && pnpm run test:observation-load` | `same exact candidate, focused fixtures and unchanged public read/error inventory` | `all required commands exit zero and existing authorization, receipt, claim and error contracts remain compatible` |
| `AC-05` | human | `ForgePilot Human Review record` | `current candidate, timing record, deterministic fixtures, final diff and residual G5/Linux gap` | `reviewer assesses observation target and risk without a Linux, G5, S6 or release claim` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `principal` | `ap014-revoked-before-fresh-read` | reject | `bounded MCP application error and sanitized audit outcome` | `tests/acceptance/s5-outer-mcp-observation-load.test.ts` |
| `taskId` | `ap014-foreign-protected-task` | reject | `bounded MCP application error` | `tests/acceptance/s5-outer-mcp-observation-load.test.ts` |
| `agentId` | `ap014-foreign-agent-filter` | reject | `bounded MCP application error` | `tests/acceptance/s5-outer-mcp-observation-load.test.ts` |
| `cursor` | `ap014-foreign-event-cursor` | reject | `bounded MCP application error` | `tests/acceptance/s5-outer-mcp-observation-load.test.ts` |
| `task.instruction` | `AP014-PRIVATE-INSTRUCTION-MARKER` | omit | `protected Task record; absent from event projection, audit and timing record` | `tests/acceptance/s5-outer-mcp-observation-load.test.ts` |
| `snapshot.observationStatus` | `ap014-stale-after-read-delay` | preserve | `authorized bounded MCP Task snapshot` | `tests/acceptance/s5-outer-mcp-observation-load.test.ts` |
| `error.details` | `AP014-PRIVATE-DIAGNOSTIC-MARKER` | redact | `bounded public error, sanitized audit and timing record` | `tests/acceptance/s5-outer-mcp-observation-load.test.ts` |
| `timing.result` | `ap014-current-read-sample` | preserve | `sanitized candidate observation record` | `pnpm run test:observation-load` |

## Verification Notes

The named fixtures and timing command are required future Evidence, not
historical passes. Keep deterministic claim, authorization and observation
assertions separate from wall-clock distributions. Bind all automated results
to the exact candidate, retain first failures and later passing observations,
and report unavailable samples separately from current successful reads. No
macOS synthetic fixture establishes Linux Stop Evidence, protected credential
isolation or complete issue-21/G5 acceptance.
