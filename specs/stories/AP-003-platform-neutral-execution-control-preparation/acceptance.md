# Acceptance Criteria

## Happy Path

- [ ] AC-01: AgentExecutionService 在單一 platform-neutral Module 內保存並投影
      Execution Reference、generation、prepared／recovering lifecycle state 與 quarantine；
      candidate outcome 一律是 `null`，MCP 只能讀取已授權的 bounded lifecycle snapshot。
- [ ] AC-02: 真 SQLite transaction 對同一 canonical Workspace 只建立一個 claim；
      prepare／cancel race 以一個可觀察順序裁定，取得 claim 後的取消回明確 conflict，
      不建立 terminal commit 或釋放 claim。
- [ ] AC-03: daemon restart 將未確認的 execution 轉入 recovering／quarantine；
      `reconcile` 不啟動、resume 或重播 Runtime command，直到真 Supervisor evidence 可用。

## Failure Cases

- [ ] AC-04: stale generation、Reference mismatch、重複 claim、Supervisor timeout 或
      unknown reconcile 回明確 conflict／indeterminate／unavailable；claim 保留且不發布
      synthetic stopped／success，也不寫入 candidate outcome 或 terminal result。
- [ ] AC-05: MCP Caller 提供 executionId、generation、launch profile、Workspace identity
      或 Stop Evidence 一律拒絕；cross-scope lifecycle projection 不洩漏資料。
- [ ] AC-06: 任一 AP-003 production composition variant 都不可到達 dispatcher、Runtime
      Driver、worker launcher、Supervisor Adapter、Claude SDK、process/container/cgroup creation
      或 Execution Unit；scripted fixture 只在 test composition 可達。

## Business Rules

- [ ] AC-07: `start`、`revokeAndStop`、`reconcile` 是唯一 Supervisor interface；
      start idempotent、revoke 先於／晚於 start 都封閉 generation，not_found 不等於 stopped，
      platform-neutral scripted fixture 一律只可回 pending／indeterminate，不得產生 Stop
      Evidence、釋放 production claim 或滿足 terminal commit。
- [ ] AC-08: AgentExecutionService 仍是唯一 lifecycle owner；storage 只原子持久化，
      MCP 只轉譯協定，不建立第二份 Task／Execution state machine。

## Regression Requirements

- [ ] AC-09: `make verify` 在 fixed toolchain、無 vendor credential 的 fresh checkout
      通過所有 AP-001、AP-002 與 AP-003 local checks；任一 no-dispatch 或 transaction test
      failure 必須 nonzero。
- [ ] AC-10: AP-003 verification 明確列為 platform-neutral contract evidence，沒有宣稱
      Linux cgroup containment、descendant cleanup、real Claude、G1、G3 或 production readiness。

## Acceptance Evidence

<!-- prettier-ignore -->
| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/acceptance/execution-lifecycle-projections.test.ts` | `authorized MCP lifecycle reads and bounded prepared/recovering records` | `one authorized lifecycle projection; candidate outcome stays null; no mutation or Runtime reachability` |
| `AC-02` | test | `tests/integration/execution-lifecycle-transactions.test.ts` | `real SQLite, competing Workspace claim and prepare/cancel races` | `one durable ordering; no duplicate claim, terminal commit or release` |
| `AC-03` | test | `tests/integration/execution-lifecycle-recovery.test.ts` | `reopened real SQLite database with incomplete execution records` | `recovery/quarantine persists; no Runtime replay or auto start` |
| `AC-04` | test | `tests/integration/execution-supervisor-failures.test.ts` | `stale generation, mismatched reference, duplicate claim and scripted indeterminate responses` | `stable error; retained claim/quarantine; no stopped, success, candidate or terminal projection` |
| `AC-05` | test | `tests/acceptance/execution-lifecycle-authorization.test.ts` | `two Access Scopes and Caller override payloads` | `overrides and cross-scope data reject without persistence or disclosure` |
| `AC-06` | test | `tests/contracts/execution-control-no-dispatch.test.ts` | `all production composition variants and process-creation tripwire` | `zero dispatcher, Adapter, Runtime, process, container, cgroup or Execution Unit reachability` |
| `AC-07` | test | `tests/contracts/execution-supervisor-contract.test.ts` | `scripted protocol fixture and ordered Reference operations` | `contract ordering holds; scripted fixture cannot yield Stop Evidence or terminal release` |
| `AC-08` | human | `final architecture review` | `core, storage, MCP and fixture transaction trace` | `one lifecycle authority; adapters translate and storage persists only` |
| `AC-09` | command | `make verify` | `fresh checkout, fixed Node/pnpm, no vendor credential` | `all local checks pass; failures propagate nonzero` |
| `AC-10` | human | `specs/stories/AP-003-platform-neutral-execution-control-preparation/verification.md` | `final evidence and Linux-limit audit` | `all environmental limits visible; no G1/G3/production claim` |

## Security Fixture Matrix

<!-- prettier-ignore -->
| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `taskId` | `task-outside-scope` | reject | `sanitized application error` | `tests/acceptance/execution-lifecycle-authorization.test.ts asserts indistinguishable not_found` |
| `executionId` | `caller-selected-execution` | reject | `sanitized schema error` | `tests/acceptance/execution-lifecycle-authorization.test.ts asserts core-only identity allocation` |
| `generation` | `999` | reject | `sanitized schema error` | `tests/acceptance/execution-lifecycle-authorization.test.ts asserts Caller cannot select generation` |
| `launchProfile` | `unsafe-caller-profile` | reject | `sanitized schema error` | `tests/acceptance/execution-lifecycle-authorization.test.ts asserts protected configuration only` |
| `workspaceIdentity` | `caller-selected-workspace` | reject | `sanitized schema error` | `tests/acceptance/execution-lifecycle-authorization.test.ts asserts Registry binding only` |
| `worker.observation` | `unbound-observation` | reject | `sanitized IPC result` | `tests/contracts/execution-supervisor-contract.test.ts asserts Reference-bound bounded input` |
| `stopEvidence` | `synthetic-stop-evidence` | reject | `sanitized fixture result` | `tests/contracts/execution-supervisor-contract.test.ts asserts no production claim release` |

## Verification Notes

This Story is a preparation lane, not S1 or S3. Gate `GATE-012` selected the
safe preparation scope: only prepared/recovering/quarantine and their failure
contracts are in scope. Candidate outcome, terminal commit, claim release and
any Stop Evidence remain S3 work after G1. Its scripted contract fixture is
model evidence only; it must never satisfy G1, G3, Linux Stop Evidence, real
Claude behavior, or deployment readiness. S3 remains blocked until both G1 and
G2 have independent accepted evidence.
