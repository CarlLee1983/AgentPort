# Acceptance Criteria

## Happy Path

* [ ] AC-01: deterministic fixtures binary-search the greatest repeat count
      accepted through existing Runtime worker encoding, ingress and storage
      candidate validators for `private marker + U+6F22 repetitions` and
      `private marker + U+0022 repetitions`, and prove one additional repeated
      code point is rejected at the owning production validator. Each fixture
      completes 100 Tasks through real SQLite and verified synthetic stop
      evidence without direct terminal-row injection or validator bypass.
* [ ] AC-02: for each fixture, an authorized official MCP Client obtains an
      `agentport_list_tasks` first default page of exactly 50 items with a
      non-null `nextCursor`, a continuation page of exactly 50 items with a null
      `nextCursor`, and a `limit: 100` page of exactly 100 items with a null
      `nextCursor`. Every returned summary is complete, structured and JSON text
      results agree, and instruction is absent.

## Business Rules

* [ ] AC-03: raw loopback requests for the same declared pages verify successful
      HTTP, JSON-RPC, MCP tool, schema, structured/text, count, cursor, and
      per-item-summary outcomes before measuring full response bytes. The
      candidate record reports for each fixture logical summary bytes,
      worker-frame bytes, structured-result bytes, JSON-text bytes, complete
      JSON-RPC response-body bytes, the 8 MiB target, and the arithmetic
      relation of every named layer to that target. It does not select an
      authoritative layer or declare capacity compliance. Errors and incomplete
      pages cannot count as small successes.

## Failure Cases

* [ ] AC-04: a foreign Principal cannot read the terminal page or reuse its
      cursor; revocation denies a fresh read. Private instruction and result
      markers are absent from foreign/revoked/error/event/audit projections,
      command output, and the sanitized record. Any named layer above 8 MiB is
      recorded as an observation under an unresolved response interpretation
      and triggers no truncation, invented `output_limit`, lifecycle change,
      silent page-policy change, or product-compliance verdict.

## Regression Requirements

* [ ] AC-05: focused candidate-bound commands record source-before/source-after
      identity, base revision, platform and pinned tool versions, fixture
      parameters, expected/actual page and byte outcomes, and sanitized result
      locations. Focused MCP and affected fault checks plus `make verify` pass
      on the same candidate with the existing ten tools, schemas, public codes,
      authorization, persistence, terminalization, and control contracts.
* [ ] AC-06: Human Review examines the deterministic fixtures, record, final
      diff, per-layer measurements, and remaining response interpretation,
      pagination/`output_limit`,
      five-second Client outage, production backpressure, Linux Stop Evidence,
      G5, S6, and release gaps. This characterization does not by itself claim
      that the 8 MiB target or Issue 21 is satisfied.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` | `production worker encoding and ingress, U+6F22 and U+0022 binary-search fixtures, real SQLite, 100 synthetic terminal Tasks per fixture, verified synthetic stop evidence` | `greatest accepted repeat counts and one-code-point rejection boundaries are proven; every terminal result follows legal framing and durable lifecycle without direct terminal-row injection` |
| `AC-02` | test | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` | `official MCP Client, authorized scope, exactly 100 completed terminal Tasks per fixture, omitted limit then cursor continuation and limit 100` | `50/non-null cursor, 50/null cursor and 100/null cursor complete pages; structured/text agreement, summaries preserved and instruction omitted` |
| `AC-03` | test | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` | `raw loopback requests matching the official-Client pages, unresolved 8 MiB response interpretation, candidate-bound local record` | `only fully successful responses are measured; every named serialization layer and numeric target relation is recorded without selecting capacity authority or compliance` |
| `AC-04` | test | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` | `foreign and revoked principals, foreign cursor, private synthetic instruction/result markers, product audit` | `concealed or denied reads and no private disclosure; above-target outcome changes no public behavior` |
| `AC-05` | command | `pnpm run test:terminal-summary-capacity && pnpm run test:mcp && pnpm run test:faults && make verify` | `same exact candidate, sanitized local record, unchanged public inventory and storage schema` | `commands exit zero and record source identity, versions, deterministic fixtures, exact pages, byte layers and arithmetic target comparisons` |
| `AC-06` | human | `ForgePilot Human Review record` | `current candidate, measurement record, final diff and explicit residual Issue 21/Linux decisions` | `reviewer judges characterization evidence without inferring capacity compliance, behavior selection, G5, S6, or release readiness` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `bearer` | `ap017-synthetic-invalid-bearer` | reject | `bounded HTTP/auth audit metadata` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |
| `principal` | `ap017-revoked-before-fresh-page` | reject | `bounded MCP error and sanitized audit result` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |
| `cursor` | `ap017-foreign-terminal-page-cursor` | reject | `bounded MCP error` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |
| `task.instruction` | `AP017-PRIVATE-INSTRUCTION-MARKER` | omit | `protected Task only; absent from summary page and record` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |
| `task.result.summary` | `AP017-PRIVATE-RESULT-MARKER` | preserve | `authorized terminal Task summaries only` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |
| `execution.reference` | `ap017-synthetic-terminal-reference` | preserve | `protected SQLite execution and stop evidence only` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |
| `limit.result` | `ap017-terminal-summary-capacity-outcome` | preserve | `sanitized local candidate record without raw summary` | `pnpm run test:terminal-summary-capacity` |

## Verification Notes

These fixtures and commands are required future Evidence, not historical
passes. A named byte layer may be numerically above 8 MiB because this Story
characterizes current legal responses; the Story does not choose which layer
defines the public target or make a capacity verdict. A behavior-changing
follow-up must open and resolve a ForgePilot Gate before selecting the
authoritative response layer or pagination, truncation, lifecycle, or
`output_limit` semantics. No macOS synthetic Reference proves Linux Stop
Evidence, credential isolation, complete Issue 21/S5/G5, S6, or release
acceptance.
