# Acceptance Criteria

## Happy Path

- [ ] AC-01: without changing AP-009's limits, queue/general saturation and the
      exact 2 GiB admission plus 256 MiB physical-control split reject new load
      while accepted Tasks retain their pre-reserved first reply, exact reply
      replay, cancel, recovery acknowledgement and terminal receipt/event capacity.
- [ ] AC-02: capacity evidence includes actual SQLite database plus WAL bytes,
      pages, JSON/audit overhead, checkpoint effects and same-filesystem physical
      reserve reconciliation; expected quota rejection neither evicts in-period
      data nor triggers global stopping.

## Business Rules

- [ ] AC-03: injected commit failure, physical full or I/O error, write lock or
      timeout ambiguity, worker loss, or control-reserve failure latches new
      admission and dispatch closed before another Runtime start and never
      reports an unproven mutation as durably accepted or rejected.
- [ ] AC-04: every active exact Execution Reference in the current composition
      is revoked and stopped through the independent Supervisor; without trusted
      Stop Evidence or recovered durable commit, the Task remains unavailable or
      recovering and its Workspace claim remains quarantined.

## Failure Cases

- [ ] AC-05: waiting-for-answer, accepted-answer-before-ack, cancellation,
      candidate outcome and terminal-commit storage failures preserve one durable
      winner, never redeliver an answer, start a new generation, fabricate a
      terminal state or release a claim before trusted stop and durable commit.
- [ ] AC-06: an authorized query returns `stale` only from a previously committed
      snapshot still authorized by the current Registry; without it the result is
      `observation_unavailable`, mutation failures use the existing sanitized
      unavailable projection, and no storage/Supervisor/cross-scope detail escapes.
- [ ] AC-07: after storage and reserve recovery, a new controlled composition
      reconciles receipts, claims, exact References and Supervisor evidence before
      reopening dispatch, without automatically replaying a Task or answer.

## Regression Requirements

- [ ] AC-08: AP-009 retention/expiry, existing MCP inventory and errors, the
      three-operation Supervisor interface, generation fencing and Linux Stop
      Evidence remain unchanged; repository, MCP, S5 fault and Linux suites pass
      for the checked candidate without skipped-all environment evidence.

## Acceptance Evidence

<!-- prettier-ignore -->
| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/integration/s5-retention-capacity.test.ts; tests/integration/storage-reserve.test.ts; tests/integration/s5-capacity-storage-failure.test.ts` | `real SQLite at configured logical physical and per-Task reserve boundaries` | `new load rejects while every reserved existing-Task control path remains bounded and usable` |
| `AC-02` | test | `tests/integration/s5-retention-capacity.test.ts; tests/integration/storage-reserve.test.ts; tests/integration/s5-capacity-storage-failure.test.ts` | `DB WAL page JSON audit checkpoint and same-filesystem reserve fixtures with an in-period result` | `physical accounting remains within the split and expected rejection neither evicts data nor trips convergence` |
| `AC-03` | test | `tests/integration/s5-storage-failure-convergence.test.ts; tests/integration/s5-storage-failure-recovery.test.ts` | `controlled composition with commit full I/O lock mutation-timeout worker-loss and reserve-failure hooks plus start counter and same-operation retry` | `incident closes admission and dispatch before another start while an ambiguous mutation resolves only through its durable receipt` |
| `AC-04` | test | `tests/integration/s5-storage-failure-convergence.test.ts; tests/linux/s5-storage-failure-stop.test.ts` | `durable claims and withheld terminal commits under injected storage failure plus designated cgroup-v2 target with multiple exact active References` | `claims stay held without a terminal commit while each generation is revoked and each Execution Unit is proven empty` |
| `AC-05` | test | `tests/integration/s5-storage-failure-convergence.test.ts` | `awaiting-input accepted-pending-ack cancel candidate and terminal-commit storage-failure barriers` | `one durable winner and no answer redelivery new generation synthetic terminal or premature claim release` |
| `AC-06` | test | `tests/acceptance/s5-storage-failure-mcp.test.ts` | `official MCP Client with two Access Scopes current committed cache and sanitized internal fault markers` | `authorized stale or observation_unavailable projection contains no private storage Supervisor or foreign-scope detail` |
| `AC-07` | test | `tests/integration/s5-storage-failure-recovery.test.ts; tests/integration/s4-migration-recovery.test.ts` | `controlled-composition restart with reopened real SQLite restored control reserve retained receipts claims and Supervisor evidence plus an accepted-answer restart fixture` | `reconciliation precedes dispatch reopening and performs no Task Runtime replay while a committed answer remains accepted and undeliverable` |
| `AC-08` | command | `make verify && pnpm run test:mcp && pnpm run test:faults && pnpm run test:linux` | `fixed local toolchain plus designated Linux cgroup-v2 target for the same candidate` | `all required suites execute and exit zero while existing public and Supervisor contracts remain compatible` |

## Security Fixture Matrix

<!-- prettier-ignore -->
| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `operationId` | `timed-out-operation-reused-with-different-input` | reject | `sanitized receipt conflict or unavailable result` | `tests/integration/s5-storage-failure-recovery.test.ts` |
| `taskId` | `foreign-scope-task-requested-during-storage-incident` | reject | `indistinguishable authorized error projection` | `tests/acceptance/s5-storage-failure-mcp.test.ts` |
| `questionId and answer` | `accepted-private-answer-after-delivery-failure` | omit | `authorized durable Question only without logs or repeated delivery` | `tests/integration/s5-storage-failure-convergence.test.ts` |
| `executionReference` | `foreign-or-stale-generation-reference` | reject | `bounded safety-set and Supervisor metadata only` | `tests/unit/storage-incident-coordinator.test.ts; tests/integration/s3a-observation-failures.test.ts; tests/linux/execution-supervisor-reconcile.test.ts` |
| `worker.observation` | `candidate-shaped-payload-during-store-failure` | reject | `no synthetic terminal result` | `tests/integration/s5-storage-failure-convergence.test.ts` |
| `stopEvidence` | `cross-generation-or-unit-not-empty-evidence` | reject | `quarantined claim without terminal commit` | `tests/integration/s3a-observation-failures.test.ts; tests/linux/execution-supervisor-reconcile.test.ts` |
| `cachedSnapshot` | `foreign-scope-committed-result-marker` | reject | `no stale response for unauthorized scope` | `tests/acceptance/s5-storage-failure-mcp.test.ts` |
| `storageFailure` | `database-path-and-worker-exit-diagnostics` | redact | `internal bounded incident reason only` | `tests/acceptance/s5-storage-failure-mcp.test.ts` |
| `error.details` | `raw-storage-supervisor-and-cross-scope-identifiers` | redact | `stable public error without diagnostic payload` | `tests/acceptance/s5-storage-failure-mcp.test.ts` |

## Verification Notes

This Story is the issue-18 storage-failure convergence slice, not issue 19's
complete crash matrix or G5. `pnpm run test:faults` must include the new S5
storage-failure integration fixtures. Local deterministic tests may prove
ordering and error projection, but only the designated Linux cgroup-v2 suite
may prove generation revocation and Execution Unit emptiness. Missing Linux
prerequisites remain an explicit environment blocker rather than a skipped PASS.
