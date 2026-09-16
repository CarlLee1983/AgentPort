# Acceptance Criteria

## Happy Path

* [ ] AC-01: with a real SQLite store and official MCP Client, legal near-bound
      UTF-8/JSON-escaped Task instruction plus a maximum 100-item event page
      return current-authorized `get_task`, `list_tasks` and `get_events`
      projections. Structured and text results agree; each full serialized
      response is measured against the documented 8 MiB page target, page
      counts stay bounded, `list_tasks` summaries and events omit instruction,
      and private instruction appears only in its authorized protected Task
      field. Diagnostic markers are absent from public results, audit and the
      candidate record. This declared fixture does not establish the bound
      for every legal terminal Task-summary page.

## Business Rules

* [ ] AC-02: while a test-only HTTP reader pauses consumption of a legal
      authorized `get_task` response of at least 128 KiB serialized bytes for
      at least 2.5 seconds, with at least 64 KiB withheld after its first
      chunk, a held scripted worker
      observation commits to SQLite before reader release,
      other official Clients obtain current full read responses within the
      two-second fixture target before release, and an authorized loaded
      cancel commits
      its receipt and returns `stopping` without waiting for that reader or
      held Runtime input within that target. Identical cancel replay finds the same durable
      outcome; the exact Workspace claim remains held and Task nonterminal
      while stop confirmation is unknown. Foreign or revoked reads remain
      concealed and event/audit/error projections omit private markers.

## Failure Cases

* [ ] AC-03: the existing AP-014 delayed/unavailable storage fixture rerun on
      the same candidate returns the existing current or stale Task snapshot, or
      `observation_unavailable`; `list_tasks` and `get_events` return current
      pages or bounded errors, never invented stale pages. A disconnected
      AP-016 test reader is not reported as Runtime death, terminal Task failure,
      canceled Task, or proof of lost event persistence. An unavailable-only
      measurement cannot pass as a current-query observation.

## Regression Requirements

* [ ] AC-04: focused candidate-bound commands record platform/tool versions,
      legal page/content pressure and response byte counts, and reuse the
      AP-014 measurement for at least 50 current full official-Client
      responses per read tool with maxima/p50/p95/p99 and actual result against the
      existing two-second fixture target. It separates stale, unavailable,
      failed and slow-reader samples, and records expected/actual Task, event,
      receipt and claim outcomes in sanitized local result locations.
      `test:mcp`, affected fault checks and `make verify` pass on the same
      exact candidate with unchanged public tools, codes, authorization,
      control reserve and durable claim contracts.
* [ ] AC-05: Human Review examines the record, deterministic fixture, final
      diff and remaining worst-case 8 MiB wire bound, five-second Client-outage,
      `output_limit`, production
      backpressure, Linux Stop Evidence and G5 gaps. This slice does not claim
      complete S5/G5, S6, production latency or release acceptance.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/acceptance/s5-mcp-serialized-observation-load.test.ts` | `official MCP Client, loopback endpoint, real SQLite, legal near-bound UTF-8/escaped Task instruction, 100-event metadata page, authorized and foreign actors` | `structured/text agreement, current authorized bounded projections and recorded full bytes against 8 MiB for the declared fixture; private markers absent from unauthorized/error/event/audit sinks` |
| `AC-02` | test | `tests/acceptance/s5-mcp-serialized-observation-load.test.ts` | `test-only reader paused >=2.5 seconds on legal >=128 KiB get_task response with >=64 KiB withheld, official Client current poll/cancel, held scripted ingress, real SQLite receipt/event/claim, foreign and revoked reads` | `observation and cancel receipt persist before reader release; other-Client full current read/cancel responses meet two seconds, stopping replay and held claim remain honest, with no private disclosure` |
| `AC-03` | test | `tests/acceptance/s5-outer-mcp-observation-load.test.ts; tests/acceptance/s5-mcp-serialized-observation-load.test.ts` | `same-candidate AP-014 controlled storage delay/unavailability and AP-016 disconnected test reader on accepted Task` | `get_task current/stale/unavailable and list/events current/error paths remain distinct; no transport-derived terminal or lost-persistence claim` |
| `AC-04` | command | `pnpm run test:serialized-load && pnpm run test:observation-load && pnpm run test:mcp && pnpm run test:faults && make verify` | `same exact candidate, serialized-pressure fixture and reused 50-current-sample observation fixture, sanitized local records and existing tool inventory` | `commands exit zero; records name response size/timing, separate non-current outcomes, durable expected/actual state, versions and result locations` |
| `AC-05` | human | `ForgePilot Human Review record` | `current candidate, load record, deterministic fixture, final diff and residual Issue 21/Linux gap` | `reviewer assesses serialized observation and slow-reader persistence without a Client-outage, output-limit, G5, S6 or release claim` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `bearer` | `ap016-synthetic-invalid-bearer` | reject | `bounded HTTP/auth audit metadata` | `tests/acceptance/s5-mcp-serialized-observation-load.test.ts` |
| `principal` | `ap016-revoked-before-fresh-read` | reject | `bounded MCP error and sanitized audit result` | `tests/acceptance/s5-mcp-serialized-observation-load.test.ts` |
| `taskId` | `ap016-foreign-protected-task` | reject | `bounded MCP error` | `tests/acceptance/s5-mcp-serialized-observation-load.test.ts` |
| `operationId` | `ap016-identical-cancel-retry` | preserve | `protected scoped operation receipt` | `tests/acceptance/s5-mcp-serialized-observation-load.test.ts` |
| `cursor` | `ap016-foreign-event-cursor` | reject | `bounded MCP error` | `tests/acceptance/s5-mcp-serialized-observation-load.test.ts` |
| `task.instruction` | `AP016-PRIVATE-INSTRUCTION-MARKER` | preserve | `protected Task and authorized snapshot only` | `tests/acceptance/s5-mcp-serialized-observation-load.test.ts` |
| `event.metadata` | `ap016-bounded-event-page` | preserve | `authorized bounded event page; absent from audit/metrics` | `tests/acceptance/s5-mcp-serialized-observation-load.test.ts` |
| `execution.reference` | `ap016-held-synthetic-reference` | preserve | `protected SQLite claim; omitted from audit/metrics` | `tests/acceptance/s5-mcp-serialized-observation-load.test.ts` |
| `error.details` | `AP014-PRIVATE-DIAGNOSTIC-MARKER` | redact | `bounded MCP error, audit and sanitized record` | `tests/acceptance/s5-outer-mcp-observation-load.test.ts; tests/acceptance/s5-mcp-serialized-observation-load.test.ts` |
| `limit.result` | `ap016-serialized-pressure-outcome` | preserve | `sanitized local candidate record` | `pnpm run test:serialized-load` |

## Verification Notes

These fixtures and commands are required future Evidence, not historical
passes. Keep deterministic durability and security assertions separate from
wall-clock distributions. Record first failures and later passing results,
measure full official-Client responses with a monotonic clock, and report
slow-reader and unavailable results separately. A test-only disconnected
reader does not implement the product's five-second Client message. No macOS
scripted Reference proves Linux Stop Evidence, credential isolation or
complete Issue 21/S5/G5 acceptance.
