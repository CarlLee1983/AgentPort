# Acceptance Criteria

## Happy Path

* [ ] AC-001: An authorized Caller requesting a normal terminal Task page receives the existing complete ordered summaries, structured/text agreement, and cursor behavior when the requested 50 or 100 items fit the 8 MiB complete response bound.
* [ ] AC-002: For each legal high-amplification terminal summary fixture and legal bounded request-envelope value, a requested default or maximum page returns a non-empty capacity-safe prefix of complete summaries, a non-null `nextCursor` when authorized items remain, and an emitted uncompressed UTF-8 JSON-RPC body of at most 8,388,608 bytes.

## Business Rules

* [ ] AC-003: Draining every capacity-reduced page through its returned cursor yields each authorized matching Task exactly once, in stable order, with no omitted items, duplicate items, summary truncation, or terminal cursor before the authorized set is exhausted.
* [ ] AC-004: Capacity selection occurs before cursor sealing and treats `limit` as an upper bound while preserving the existing tool name, schemas, public codes, cursor encoding, filter binding, retention binding, storage schema, and Task lifecycle.

## Failure Cases

* [ ] AC-005: Foreign, malformed, filter-mismatched, expired, and revoked reads retain their existing concealment or error outcomes and reveal neither protected terminal summaries nor capacity-specific state.
* [ ] AC-006: The implementation proves one legal terminal summary plus every bounded success-envelope field fits the selected authority; otherwise it stops for a ForgePilot Gate rather than truncating content or introducing a page-level `output_limit` error.

## Regression Requirements

* [ ] AC-007: The remaining nine public tools retain their current successful and error projections, and normal `agentport_list_tasks` pages that fit retain their current requested-count behavior.
* [ ] AC-008: The focused capacity, authorization, retention, and MCP tests plus `make verify` pass on the same candidate, and technical/operations documentation accurately limits the implemented contract to terminal `agentport_list_tasks` pages.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | test | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` | `authorized-fitting-terminal-page` | `complete-page-preserves-cardinality-and-structured-text-agreement` |
| `AC-002` | test | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` | `legal-amplified-terminal-page-and-bounded-request-id` | `response-body-at-most-8388608-and-reduced-page-has-cursor` |
| `AC-003` | test | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` | `authorized-filtered-terminal-drain-above-capacity` | `cursor-drain-is-complete-ordered-and-exactly-once` |
| `AC-004` | test | `tests/unit/agent-execution-service.test.ts` | `scope-filter-retention-and-capacity-page-fixtures` | `cursor-sealed-after-prefix-with-compatible-contract` |
| `AC-005` | test | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` | `foreign-malformed-expired-and-revoked-page-fixtures` | `existing-concealment-outcomes-without-private-disclosure` |
| `AC-006` | test | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` | `maximum-legal-single-summary-and-envelope-fixture` | `complete-single-item-fits-without-output-limit-projection` |
| `AC-007` | test | `tests/acceptance/durable-admission.test.ts` | `existing-ten-tool-and-fitting-terminal-page-fixture` | `unaffected-tools-and-fitting-pages-preserve-projection` |
| `AC-008` | command | `pnpm run test:terminal-summary-capacity-safe-pagination && pnpm run test:mcp && pnpm run test:faults && make verify` | `one-exact-implementation-candidate` | `focused-checks-and-repository-gate-exit-zero` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `bearer` | `ap019-invalid-bearer` | reject | `bounded HTTP/auth audit metadata` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |
| `principal` | `ap019-revoked-before-terminal-page` | reject | `bounded MCP error and sanitized audit result` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |
| `cursor` | `ap019-foreign-or-malformed-terminal-cursor` | reject | `bounded MCP error` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |
| `task.instruction` | `AP019-PRIVATE-INSTRUCTION-MARKER` | omit | `protected Task only; absent from summary, body inspection, audit, and record` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |
| `task.result.summary` | `AP019-PRIVATE-RESULT-MARKER` | preserve | `authorized complete Task summaries only` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |
| `jsonrpc.id` | `ap019-bounded-request-id` | preserve | `complete JSON-RPC body only` | `tests/acceptance/s5-mcp-terminal-summary-capacity.test.ts` |

## Verification Notes

Measure the exact response bytes emitted by the loopback MCP handler, not a
reconstructed payload or a compressed transport. The evidence must demonstrate
the complete body arithmetic for all legal terminal summary shapes and every
bounded success-envelope field. If a legal single summary cannot fit, stop and
open a ForgePilot Gate; do not weaken the accepted contract.
