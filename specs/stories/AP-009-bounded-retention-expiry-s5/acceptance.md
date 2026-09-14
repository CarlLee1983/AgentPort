# Acceptance Criteria

## Happy Path

* [ ] AC-01: an administrator-configured terminal retention policy defaults to 30 days and starts only when the
      terminal Task commit is durable; an in-period authorized result, receipt and event projection remain
      queryable across cleanup scheduling and restart.
* [ ] AC-02: terminal cleanup atomically writes the minimum authorized Task/operation replay marker and
      scope/filter cursor tombstone before removing private prompt, answer and result payload; the expired
      operation never reopens, redispatches or invokes a Runtime.
* [ ] AC-03: a Context remains durable while any related Task is nonterminal or queryable, then retires only after
      its final unprotected Task expires; AgentPort cleanup leaves the vendor transcript untouched.

## Business Rules

* [ ] AC-04: nonterminal, paused, recovering, stopping, stop-unknown, held and quarantined Tasks are never
      retention-expired, and neither their control/recovery records nor their protecting Context are removed.
* [ ] AC-05: an authorized scope/filter cursor whose referenced history has expired returns `cursor_expired` and
      requires a fresh snapshot; list/events never silently skip deleted history or broaden the original filter.
* [ ] AC-06: as selected by ForgePilot `GATE-027`, an authorized `get_task` and identical operation retry return
      `result_expired`, expired Tasks are omitted from lists, and Context retirement follows the
      final-Task/nonterminal-dependency rule.

## Failure Cases

* [ ] AC-07: cleanup, terminal commit, identical retry, cursor read and Context-protection races linearize in one
      durable-store transaction; restart preserves the single winner and never exposes private payload after a
      committed expiry marker or reopens the operation.
* [ ] AC-08: at 100,000 general tombstones or a 2 GiB combined SQLite database/WAL admission budget, `submit`,
      `edit` and `resume` are rejected without evicting in-period results, while reserved `reply`, `cancel` and
      `acknowledge_interruption` paths remain usable; physical storage failure follows the existing unavailable/
      quarantine safety contract.
* [ ] AC-09: cross-scope or malformed Task IDs, operation IDs, cursors, filters, retention values, clocks and
      error details are rejected or redacted without disclosing tombstone existence, private payload, raw SQLite/
      WAL diagnostics, another scope’s history, or causing cleanup/Runtime side effects.

## Regression Requirements

* [ ] AC-10: no new public cleanup tool, MCP Adapter retention state, Runtime command or vendor transcript side
      effect is introduced; existing bounded result/page/response limits remain valid for in-period results.
* [ ] AC-11: additive migration preserves pre-S5 live and in-period Task, Context, receipt, event, Question,
      claim and recovery records; restart resumes no expired operation, preserves tombstone/cursor semantics, and
      the repository, MCP and fault suites pass for the checked candidate.

## Acceptance Evidence

<!-- prettier-ignore -->
| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/integration/s5-retention-expiry.test.ts` | `real SQLite controllable clock with terminal durable commit at retention boundary` | `30-day default/configured window retains in-period authorized result, receipt and events across restart` |
| `AC-02` | test | `tests/integration/s5-retention-expiry.test.ts` | `terminal result with private payload and identical operation retry` | `tombstone commits before payload deletion; expired retry has no execution or Runtime side effect` |
| `AC-03` | test | `tests/integration/s5-context-retention.test.ts` | `related terminal, queryable and nonterminal Tasks with vendor transcript fixture` | `Context remains while protected and retires after final expiry; vendor transcript is unchanged` |
| `AC-04` | test | `tests/integration/s5-context-retention.test.ts` | `paused recovering stopping stop-unknown held quarantined and nonterminal Task fixtures` | `no protected Task, control record or Context is selected for expiry` |
| `AC-05` | test | `tests/integration/s5-retention-expiry.test.ts` | `scope/filter-bound event and list cursors crossing expired history` | `cursor_expired requires a fresh snapshot with no silent skip, filter change or scope disclosure` |
| `AC-06` | test | `tests/acceptance/s5-retention-mcp.test.ts` | `official MCP Client with GATE-027 expiry semantics and expired Task markers` | `get/retry/list/Context projections match approved expiry semantic and expose no payload` |
| `AC-07` | test | `tests/integration/s5-retention-races.test.ts` | `real SQLite barriers for cleanup terminal commit retry cursor and Context-protection races plus restart` | `one durable winner survives restart; no payload leak, reopen, redispatch or Runtime call` |
| `AC-08` | test | `tests/integration/s5-retention-capacity.test.ts` | `100000 tombstones and 2 GiB DB-plus-WAL saturation with reserved control operations` | `new-work mutations reject, in-period results remain, and reply/cancel/acknowledgement reserve works` |
| `AC-09` | test | `tests/acceptance/s5-retention-authorization.test.ts` | `official MCP Client with two Access Scopes and malformed retention/clock/cursor/error inputs` | `sanitized reject/redact result with no disclosure, persistence mutation, cleanup or Runtime side effect` |
| `AC-10` | test | `tests/acceptance/s5-retention-mcp.test.ts` | `MCP tool inventory, Adapter seam and vendor transcript sentinel` | `no cleanup tool/state/Runtime command is added; bounded in-period projections remain intact` |
| `AC-11` | command | `make verify && pnpm run test:mcp && pnpm run test:faults` | `pre-S5 SQLite migration fixture and checked implementation candidate` | `migration preservation, restart retention behavior, MCP and fault suites complete successfully` |

## Security Fixture Matrix

<!-- prettier-ignore -->
| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `taskId` | `task-outside-access-scope` | reject | `sanitized application error` | `tests/acceptance/s5-retention-authorization.test.ts` |
| `operationId` | `expired-operation-reused-with-different-input` | reject | `sanitized receipt conflict` | `tests/integration/s5-retention-races.test.ts` |
| `cursor` | `cross-scope-expired-cursor` | reject | `sanitized cursor error` | `tests/acceptance/s5-retention-authorization.test.ts` |
| `filters` | `filter-mismatch-on-retained-cursor` | reject | `unchanged cursor binding` | `tests/integration/s5-retention-expiry.test.ts` |
| `private payloads` | `prompt-answer-result-after-expiry` | omit | `minimal authorized tombstone` | `tests/integration/s5-retention-expiry.test.ts` |
| `retentionDays` | `caller-supplied-negative-or-unbounded-days` | reject | `sanitized policy error` | `tests/acceptance/s5-retention-authorization.test.ts` |
| `asOf` | `caller-supplied-cleanup-timestamp` | reject | `sanitized validation error` | `tests/acceptance/s5-retention-authorization.test.ts` |
| `error.details` | `sqlite-path-wal-size-prompt-or-cross-scope-id` | redact | `bounded application error/event` | `tests/acceptance/s5-retention-authorization.test.ts` |

## Verification Notes

This Story is the first issue-17 S5 slice and does not claim G5. Run the declared command against the actual
candidate after implementing the migration and focused tests. ForgePilot `GATE-027` selected the minimal expiry
marker, `result_expired`, list omission and final-Task Context-retirement semantics. Do not reinterpret that
decision or record ForgePilot verification, Human Review, commit, push or deployment without authorization.
