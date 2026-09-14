# Acceptance Criteria

## Happy Path

- [ ] AC-01: production dispatcher 只在 current authorization／binding、Execution Reference、
      generation、Workspace claim 與 starting intent 原子 commit 後呼叫 G1-L Supervisor；同一 Task／
      Workspace 並行 dispatch 只建立一個 Execution Unit，MCP control path 保持可回應。
- [ ] AC-02: 真 Claude non-interactive execution 的連續 observations、candidate outcome 與
      finalOrdinal 先持久；同 Reference verified Stop Evidence 到達後，單一 terminal transaction
      發布 completed result／event／safe Session reference 並釋放 Workspace claim。

## Failure Cases

- [ ] AC-03: cancel-before-start、running cancel 與 completion race 由 durable commit order 裁定；
      cancel API 先回 stopping，只有 generation sealed＋unit empty 後才發布 canceled／failed 並釋放 claim。
- [ ] AC-04: daemon／Supervisor／worker crash 或 restart 將未確認 execution 轉 recovering／
      quarantine；reconcile 不 start、resume、重播 Runtime command 或以 PID／EOF 推測結果，unknown
      狀態保留 claim。
- [ ] AC-05: stale revision／generation／Reference、重複 claim、ordinal gap、candidate mismatch、
      Supervisor／launcher／SDK timeout 或 unavailable 回穩定 conflict／indeterminate／unavailable；
      不發布 synthetic success／stopped／terminal result。
- [ ] AC-06: Caller／worker 提供 executionId、generation、launch profile、Workspace path／identity、
      Driver options、Stop Evidence、terminal result 或跨 scope Task 一律拒絕，沒有 Runtime／持久副作用或資料洩漏。

## Business Rules

- [ ] AC-07: AgentExecutionService 是唯一 lifecycle owner；dispatcher 不保存第二份狀態機，
      storage 只原子持久化，MCP 只做 bounded protocol projection，worker／Supervisor 不發布 Task 終態。
- [ ] AC-08: Human-resolved public MCP lifecycle contract 以單一 core projection 提供 authorized
      bounded starting／running／stopping／completed／failed／canceled／recovering／interrupted、
      progress／liveness／tool activity／result，並固定 AP-003 lifecycle tool 的相容處理；未接入的
      AskUserQuestion 安全停止／中斷，不假回答且不提供 S4 reply 語意。
- [ ] AC-09: production worker 無 DB、Supervisor ledger 或 launcher privilege；Runtime credential
      僅注入該 execution，log／event／result／error／audit 不包含 credential、未遮罩 host path 或跨 scope identity。

## Regression Requirements

- [ ] AC-10: `make verify` 在固定工具鏈、無 vendor credential的 fresh checkout 通過 AP-001～
      AP-005 local tests；同 candidate 的指定 Linux `test:linux`、真 Claude `test:claude` 與 S3
      basic `test:faults` 全部執行且失敗傳遞 nonzero，沒有 skipped-all PASS。
- [ ] AC-11: S3 verification 明確記錄 candidate、target、命令、transaction／Runtime／stop counts、
      crash windows、result location 與限制；不宣稱 S4 interaction、S5 exhaustive reliability、S6
      packaging／deployment 或 production readiness。

## Acceptance Evidence

<!-- prettier-ignore -->
| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/integration/s3-dispatch-transaction.test.ts` | `real SQLite, production composition, competing Task and Workspace dispatch attempts` | `persisted authorization and one claim/reference precede exactly one Supervisor start` |
| `AC-02` | test | `tests/e2e/s3-controlled-execution.test.ts` | `designated Linux target, real Claude worker, candidate/final ordinal and verified Stop Evidence` | `one bounded completed result/event/session commit and claim release after trusted stop` |
| `AC-03` | test | `tests/integration/s3-cancellation-races.test.ts` | `cancel-before-start, running cancel and completion race with real SQLite and controllable Supervisor` | `durable order, immediate stopping projection, no release before verified stop` |
| `AC-04` | test | `tests/integration/s3-recovery.test.ts` | `claim-launch, running, candidate-stop and stop-terminal restart fixtures` | `recovering/quarantine without replay; evidence-based convergence or retained claim` |
| `AC-05` | test | `tests/integration/s3-failures.test.ts` | `stale references, claim/ordinal/candidate conflicts and unavailable dependencies` | `stable errors; no synthetic terminal state, result, Stop Evidence or release` |
| `AC-06` | test | `tests/acceptance/s3-authorization.test.ts` | `official MCP Client, two Access Scopes and Caller/worker override payloads` | `indistinguishable authorization/schema rejection with no dispatch or disclosure` |
| `AC-07` | human | `S3 architecture transaction trace review` | `core, dispatcher, storage, MCP, worker and Supervisor call/commit trace` | `one lifecycle owner and no adapter-owned Task terminal state` |
| `AC-08` | test | `tests/acceptance/s3-lifecycle-results.test.ts` | `Human-resolved public lifecycle contract and official MCP Client over running, terminal, recovering and unexpected-question executions` | `one authorized bounded core projection with the approved compatibility treatment; no S4 reply or synthetic success` |
| `AC-09` | test | `tests/linux/s3-runtime-isolation.test.ts` | `production worker account and protected DB, ledger, launcher and credential sources` | `only assigned Workspace/credential reachable; sensitive markers absent from outputs` |
| `AC-10` | command | `make verify && pnpm run test:linux && pnpm run test:claude && pnpm run test:faults` | `fixed local toolchain plus designated Linux target and credential for external suites` | `all required suites execute and exit 0; any missing prerequisite or failure is nonzero` |
| `AC-11` | human | `G3 evidence and scope-limit review` | `candidate-bound local, Linux, Claude and crash evidence` | `S3/G3 claims supported; S4–S6 and production-readiness limits remain explicit` |

## Security Fixture Matrix

<!-- prettier-ignore -->
| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `operationId` | `cancel-operation-reused-with-different-task` | reject | `sanitized receipt conflict` | `tests/integration/s3-cancellation-races.test.ts` |
| `taskId` | `task-outside-access-scope` | reject | `indistinguishable not_found` | `tests/acceptance/s3-authorization.test.ts` |
| `executionReference` | `caller-or-worker-selected-reference` | reject | `sanitized schema or IPC error` | `tests/acceptance/s3-authorization.test.ts` |
| `worker.observation` | `ordinal-gap-or-oversized-payload` | reject | `bounded failure event without raw payload` | `tests/integration/s3-failures.test.ts` |
| `candidateOutcome` | `unbound-success-shaped-candidate` | reject | `bounded failure without terminal result` | `tests/integration/s3-failures.test.ts` |
| `stopEvidence` | `scripted-or-cross-generation-stopped` | reject | `sanitized Supervisor result` | `tests/integration/s3-failures.test.ts` |
| `terminalResult` | `worker-supplied-terminal-result` | reject | `sanitized IPC error` | `tests/acceptance/s3-authorization.test.ts` |
| `launchProfile` | `caller-selected-profile` | reject | `sanitized schema error` | `tests/acceptance/s3-authorization.test.ts` |
| `workspaceIdentity` | `caller-selected-host-path` | reject | `sanitized schema error` | `tests/acceptance/s3-authorization.test.ts` |
| `vendorCredential` | `credential-shaped-marker` | omit | `no DB event result audit log or error location` | `tests/linux/s3-runtime-isolation.test.ts` |
| `error.details` | `raw-sdk-cgroup-path-and-cross-scope-id` | redact | `bounded application error` | `tests/acceptance/s3-authorization.test.ts` |

## Verification Notes

本 Story 只有在 AP-004 G1-L、AP-007 G1-C、既有 G2 與本 candidate 的
local／Linux／Claude／basic fault evidence 同時通過時才能宣稱 S3／G3。official MCP Client
的成功路徑必須到達真 SQLite、AgentExecutionService、production dispatcher、G1-L Linux
Adapter 與 G1-C 真 Claude worker；fake／scripted
fixture 只可提供 deterministic failure／race coverage，不可滿足 Stop Evidence、real Claude 或 G3。
