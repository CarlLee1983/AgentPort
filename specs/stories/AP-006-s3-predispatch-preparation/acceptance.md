# Acceptance Criteria

## Happy Path

- [ ] AC-01: additive schema v3 在真 SQLite 將既有 AP-003 prepared／recovering execution、
      Workspace claim 與 evidence 無損保留，並加入 bounded observation、candidate、stop reason
      與 recovery 欄位；AP-002／AP-003 binary 對 v3 明確拒絕。
- [ ] AC-02: 同一 Execution Reference 的連續 ordinal observations 與 bounded candidate outcome
      原子持久化；完全相同的重送 idempotent，不建立第二份 lifecycle truth。
- [ ] AC-03: candidate 與 cancel intent 競爭由第一個成功 commit 決定 stop reason，execution
      只進 `stopping`；沒有 verified G1 Stop Evidence 時 result 不發布且 Workspace claim 不釋放。

## Failure Cases

- [ ] AC-04: stale／cross-execution Reference、ordinal gap、conflicting duplicate、oversized payload、
      candidate mismatch 或 Caller／worker supplied Stop Evidence／terminal result 一律拒絕並 quarantine，
      不洩漏 raw payload 或產生 Runtime side effect。
- [ ] AC-05: daemon restart、migration mismatch 或 evidence unknown 將未確認 execution 保持
      `recovering`／quarantine；不 start、resume、replay、auto-terminalize 或釋放 claim。

## Business Rules

- [ ] AC-06: `agentport_get_task` 是唯一 authorized bounded lifecycle projection，包含 preparation、
      stopping／recovering、progress、candidate availability 與 `readiness=blocked`／`g1_unproven`；
      `agentport_get_execution_lifecycle` 從 product tools 與 protocol 移除。
- [ ] AC-07: production composition／MCP mutation path 對 dispatcher、Linux Adapter、launcher、
      Runtime worker、Driver、Claude SDK、credential source、process／container／cgroup creation皆
      零可達；不存在 dormant flag、no-op Adapter 或 synthetic Stop Evidence path。

## Regression Requirements

- [ ] AC-08: `make verify` 在固定工具鏈、無 Linux target／vendor credential 的 fresh checkout
      通過 schema v3、transaction、authorization、MCP compatibility、recovery 與 no-dispatch tests；
      verification 明示 G1、完整 S3／G3、Runtime cancellation 與 production readiness 仍未證明。
- [ ] AC-09: schema v3 rollback 在禁止新 dispatch 且 reconciliation 完成或 fail-closed 後，
      以 v3-aware query／control recovery binary 或 offline backup restore 保留 DB／WAL、execution、
      candidate、claim 與 evidence；舊 AP-002／AP-003 binary 不得開啟 v3 database。

## Acceptance Evidence

<!-- prettier-ignore -->
| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/integration/s3a-migration.test.ts` | `real schema-v2 SQLite database with prepared and recovering executions plus held and quarantined claims` | `additive v3 migration preserves records; legacy binaries reject v3; v3-aware reopen succeeds` |
| `AC-02` | test | `tests/integration/s3a-observation-transactions.test.ts` | `current Execution Reference with contiguous, duplicate-identical and candidate observations` | `one durable ordinal sequence and one bounded nonterminal candidate; identical retry is idempotent` |
| `AC-03` | test | `tests/integration/s3a-candidate-cancel-races.test.ts` | `real SQLite concurrent candidate and cancel commits without Stop Evidence` | `one durable stop reason; state remains stopping; result absent and claim retained` |
| `AC-04` | test | `tests/integration/s3a-observation-failures.test.ts` | `stale and cross-execution references, gaps, conflicting duplicates, oversized payloads and spoofed terminal fields` | `stable rejection and quarantine with no raw disclosure, terminal result, release or Runtime side effect` |
| `AC-05` | test | `tests/integration/s3a-recovery.test.ts` | `reopened v3 database with prepared, stopping and incomplete candidate records` | `recovering or quarantine persists without replay, terminalization or claim release` |
| `AC-06` | test | `tests/acceptance/s3a-task-lifecycle-projection.test.ts` | `official MCP Client with authorized and cross-scope task reads across prepared, stopping and recovering records` | `one bounded get_task projection with g1_unproven readiness; preparation-only tool is absent` |
| `AC-07` | test | `tests/contracts/s3a-no-production-dispatch.test.ts` | `all production composition variants plus import and process-creation tripwires` | `zero Runtime, Supervisor Adapter, launcher, credential or process reachability` |
| `AC-08` | command | `make verify` | `fresh checkout, fixed Node and pnpm, no Linux target or vendor credential` | `all local checks exit 0 and evidence claims only S3-A pre-dispatch preparation` |
| `AC-09` | test | `tests/integration/s3a-rollback-recovery.test.ts` | `schema-v3 database and WAL with executions, candidates, claims and evidence plus dispatch disabled` | `reconciliation gates v3-aware query/control recovery or offline restore; all records remain; legacy binaries reject` |

## Security Fixture Matrix

<!-- prettier-ignore -->
| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `taskId` | `task-outside-access-scope` | reject | `sanitized application error` | `tests/acceptance/s3a-task-lifecycle-projection.test.ts` |
| `executionReference` | `cross-execution-reference` | reject | `sanitized observation error and quarantine state` | `tests/integration/s3a-observation-failures.test.ts` |
| `worker.observation` | `ordinal-gap-or-oversized-payload` | reject | `bounded observation error without raw payload` | `tests/integration/s3a-observation-failures.test.ts` |
| `candidateOutcome` | `unbound-success-shaped-candidate` | reject | `bounded candidate error without terminal result` | `tests/integration/s3a-observation-failures.test.ts` |
| `stopEvidence` | `scripted-or-worker-supplied-stop` | reject | `sanitized input error without evidence record` | `tests/integration/s3a-observation-failures.test.ts` |
| `terminalResult` | `worker-supplied-terminal-result` | reject | `sanitized input error without result record` | `tests/integration/s3a-observation-failures.test.ts` |
| `workspaceIdentity` | `caller-selected-host-path` | reject | `sanitized schema error` | `tests/integration/s3a-observation-failures.test.ts` |
| `authorization.registryRevision` | `stale-registry-revision` | reject | `sanitized conflict and unchanged execution record` | `tests/integration/s3a-observation-failures.test.ts` |
| `error.details` | `credential-path-and-cross-scope-id` | redact | `bounded application error` | `tests/integration/s3a-observation-failures.test.ts` |

## Verification Notes

本 Story 只有 platform-neutral S3-A preparation：測試不得啟動 process、Runtime、Linux Adapter
或 Claude，也不得製造可被 production 接受的 Stop Evidence。任何 candidate、EOF、exit code、PID
消失或 scripted fixture 都不能 terminalize Execution 或釋放 claim。完成本 Story不代表 G1、S3、
G3、可靠取消或 production readiness；AP-005／WI-006 的 G1 dependency 保持不變。
