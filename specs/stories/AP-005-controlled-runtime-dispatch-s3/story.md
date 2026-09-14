# Story: AP-005 — Deliver S3-B Controlled Runtime Dispatch and Basic Recovery

## Goal

將已授權的持久 Task 經 AgentExecutionService、真 SQLite preparation／terminal transactions、
已分別通過 G1-L 與 G1-C 的 Linux Supervisor 與 Claude worker 安全執行，使 MCP Caller 能從外側查詢進度、
取消並取得最終結果；daemon restart 不重跑未知 execution，Workspace claim 只在可信停止與
terminal commit 後釋放。

## Context

本 Story 對應 [Implementation Plan S3-B／G3](../../../docs/implementation-plan.md)。
[AP-002](../AP-002-platform-neutral-durable-admission/story.md) 已完成 G2 durable admission，
[AP-003](../AP-003-platform-neutral-execution-control-preparation/story.md) 已完成不可由 production
composition 到達的 prepared／recovering／quarantine core；
[AP-006](../AP-006-s3-predispatch-preparation/story.md) 只先完成無 Runtime ingress 的 S3-A
schema v3、candidate／recovery 與 projection。AP-004 必須先在指定 Linux target
完成 G1-L、AP-007 必須完成真 Claude G1-C，兩者都經 Human Review 接受，且 AP-006
必須完成，S3-B 才能把 execution boundary 接入 production composition。

S3 只完成無互動工作、結果／取消與基本 recovery。AP-007 的 AskUserQuestion evidence 證明
Runtime 能力，但公開 Clarification Reply、Follow-up Task、完整 queue／edit／resume 仍屬 S4。

## Classification

- Security sensitive: yes
- Baseline conformance: no
- Task mode: execution

## Authority

以下權限只在 AP-004 G1-L 與 AP-007 G1-C Work Items 都為 DONE、兩者 evidence 都由
Human Review 接受、AP-006 Work Item 為 DONE 且經 Human Review、本 Story
Work Item 為 READY，且使用者明確交辦 Start 後生效。

- plan: yes
- modify: yes
- add_dependency: no
- migration: yes
- commit: no
- push: no
- deploy: no

## Architecture

- Impact: high
- Boundary: `production Task-to-Execution dispatch, Runtime observation, terminal commit and basic recovery`
- Contract: `AgentExecutionService is the sole lifecycle owner; Runtime side effects occur only after persisted authorization and claims release only with verified Stop Evidence in the terminal transaction`
- Owner: `production Task-to-Execution dispatch, Runtime observation, terminal commit and basic recovery = AgentPort maintainers`

## Risk

- Level: high
- Reason: `production dispatch concurrency and persistent terminal outcome`
- Reason: `authorization, Runtime isolation and reliable claim release`

## Scope

### In Scope

- production dispatcher 將 eligible queued／paused Task 經短交易重新核對 current Registry
  revision／binding、建立或承接唯一 Workspace claim 與 Execution Reference、標 prepared／
  starting，commit 後才呼叫 Supervisor／launcher。
- `starting`、`running`、`stopping`、`completed`、`failed`、`canceled`、`recovering`、
  `interrupted` state、連續 worker ordinal、bounded progress、candidate outcome、finalOrdinal、
  safe Session reference、verified Stop Evidence 與 terminal result persistence。
- worker candidate outcome 先持久化並轉 stopping；Supervisor 證明 generation sealed＋unit empty
  後，單一 terminal transaction 發布 Task result／event／Context reference 並釋放 claim。
- cancel intent 先持久化並立即回 stopping；Supervisor cooperative cancel、bounded forced stop／
  reconcile 在外側執行，不阻塞 MCP control request。
- daemon restart 將未確認 execution 轉 recovering／quarantine，呼叫 reconcile 而不自動 start、
  resume、重播 Runtime command 或重送未知副作用。
- production bootstrap 明確組裝 dispatcher、G1 Linux Adapter 與 Claude worker；fail-closed
  readiness 確認 target／ledger／launcher／credential／migration 可用。
- 依 Human resolve 的 public-lifecycle Gate 擴充 MCP Task／event projection，提供 bounded
  execution state、progress、liveness、tool activity、result／failure 與停止中狀態；維持
  授權後讀取與 sanitized errors，且不得維護兩份 lifecycle truth。
- 真 SQLite transaction/race/restart tests、Linux／Claude end-to-end、基本 crash-window fixture
  與 no-synthetic-evidence regression。

### Out of Scope

- Follow-up Task、Clarification Reply、公開 reply、edit_task、resume_context、完整多 Task queue
  與 Runtime Session continuation；這些屬 S4。
- S5 的完整 fault matrix、極限容量／保留期／效能驗收與 repeated-crash coverage。
- S6 packaging、部署、非 loopback production network exposure 或 production readiness 宣告。
- native macOS Runtime execution、process-group Stop Evidence、其他 Runtime Driver 或遠端 scheduler。
- 未經 G1-L 驗證的 Adapter、未經 G1-C 驗證的 Claude worker、scripted／fake Stop Evidence、
  EOF／exit 0 單獨判定成功。

## Inputs

- AP-002 經批准的 G2 durable admission／authorization／capacity evidence。
- AP-003 經批准的 Execution Reference、prepared／recovering／quarantine 與 no-dispatch contracts。
- AP-006 經批准的 schema v3、bounded nonterminal candidate／recovery 與單一 lifecycle projection。
- AP-004 經批准的指定 Linux G1-L Supervisor／Runtime／IPC evidence。
- AP-007 經批准的指定 Linux G1-C Claude Runtime capability evidence。
- [Technical Design](../../../docs/technical-design.md) 的 execution ordering、completion、cancel、restart、security 與 MCP projection contract。
- [ADR-0001](../../../docs/adr/0001-external-observation-and-control.md)、[ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md)、[ADR-0003](../../../docs/adr/0003-local-transactional-task-store.md)、[ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)。

## Outputs

- AgentExecutionService-owned production lifecycle commands／projections 與 dispatcher coordination。
- additive S3 SQLite migration、atomic preparation／observation／candidate／terminal／release operations。
- production bootstrap composition for the accepted G1 Linux Adapter and Claude worker, with readiness checks。
- official MCP Client integration、真 SQLite concurrency／restart tests、Linux／Claude G3 e2e 與 basic fault evidence。
- S3 operations／rollback and candidate-bound verification evidence，明示 S4–S6 limits。

## Rules

- R1: AgentExecutionService 是 Task／Execution lifecycle 唯一事實來源；dispatcher 只協調，
  storage 原子持久化，MCP 只轉譯，worker／Supervisor 不可直接發布 Task 終態。
- R2: 任何 Runtime side effect 前必須 commit current authorization／binding、Execution Reference、
  generation、Workspace claim 與 starting intent；不得以跨 Runtime I/O 的 DB transaction 包住 launch。
- R3: worker observations 必須綁定完整 Reference 且 ordinal 連續；EOF、exit 0、SDK result 或
  candidate outcome 都不是 terminal success／claim release。
- R4: terminal transaction 只有在 candidate／finalOrdinal 已持久且 Supervisor 提供同 Reference
  verified Stop Evidence 後，才能同時發布 result／終態 event／Context reference 並釋放 claim。
- R5: cancel 先 commit intent／stopping 再 revoke generation；API 立即回停止中。未確認 sealed＋
  unit empty 時保持 claim／quarantine，不投影 canceled／failed completed。
- R6: restart／reconcile 不自動執行或重送 Runtime command；unknown／timeout／mismatch 保持
  recovering／quarantine，直到可信 evidence 或 Human interruption decision 可用。
- R7: 每次 dispatch 前重新驗證 current Registry revision、membership、Agent allowlist、binding
  與 Workspace identity；Caller／worker 不得覆寫 executionId、generation、profile、path、Driver
  options、Stop Evidence 或 terminal result。
- R8: S3 不公開 S4 interaction；若真 Claude 產生尚未接入的 AskUserQuestion，execution 必須
  安全停止／中斷並保留可查狀態，不可自動回答或假成功。

## Expected Errors

- concurrent dispatch／cancel／completion 依 transaction commit order 只有一個合法結果；stale
  revision／generation／Reference／claim 回 conflict，不產生第二 execution 或釋放 claim。
- Supervisor／launcher／worker／SDK timeout 或 unavailable 回 stopping／recovering／interrupted／
  unavailable；無 Stop Evidence 不發布 terminal success／canceled／failed。
- worker ordinal gap、candidate mismatch、oversized／unbound observation 拒絕並 quarantine。
- daemon／Supervisor／worker crash 在 claim→launch、candidate→stop、stop→terminal 任何窗口都不
  自動重跑；已知 candidate 也須再次取得可信 Stop Evidence 才可 terminal commit。
- authorization／binding 在 preparation commit 前變更時 revocation wins；commit 後依已持久
  Reference 安全停止，不把新設定套到既有 execution。
- migration／ledger／readiness 不相容時 production composition fail closed，不接受新 dispatch。

## Dependencies

- AP-002／G2 與 AP-003 Work Items 已 DONE；AP-006／S3-A Work Item 也必須 DONE 且 Human Review 接受。
- AP-004／G1-L 與 AP-007／G1-C Work Items 必須 DONE，且 Human Review 分別接受指定
  Linux control 與真 Claude capability evidence。
- 本 Story 的 ForgePilot Work Item 必須以 dependency 或 blocking Gate 保留，直到 AP-004、
  AP-006 與 AP-007 都完成且經 Human Review。不得因 AP-003／AP-004／AP-006 local tests
  或 scripted fixture 繞過 G1-C 變 READY；目前狀態只由 ForgePilot 投影。
- 需要同一指定 Linux target、受保護 launcher／ledger、專用 Runtime account 與 vendor credential source。
- Human 必須在實作前 resolve S3 public MCP lifecycle 與 v3 rollout／rollback Gates。

## Constraints

- migration additive 且不得刪除 execution／outcome／Stop Evidence／claim records；舊 binary
  的相容政策與 rollback 路徑由 Human resolve 的 v3 schema Gate 固定，未決前不實作降版。
- 不新增另一份 lifecycle state machine、in-memory truth、hidden fallback、no-op Adapter 或 macOS execution path。
- Runtime worker 不持有 DB／Supervisor ledger／launcher privilege；核心不信任 worker 自報停止。
- `make verify` 是 canonical local gate；G3 另需同 candidate 的指定 Linux／Claude／fault evidence。
- production network exposure、deploy、commit、push 與 Human Review 仍需各自明確授權。
- 新 public state／result／error projection 與 AP-003 `agentport_get_execution_lifecycle` 的相容
  處理必須由 Human resolve 的 public-lifecycle Gate 固定，並具 official MCP Client compatibility evidence。

## Guidance

- [Engineering entry](../../../guidance/ENTRY.md)：最小內聚垂直切片、明確依賴與行為導向測試。
- [Development workflow](../../../docs/development-workflow.md)：candidate、environment evidence、Gate 與 Human Review。
- [ADR-0003](../../../docs/adr/0003-local-transactional-task-store.md)：SQLite 短交易與不承諾 exactly-once。
- [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)：Linux-only production execution 與 Stop Evidence。

## Trust Boundary Fields

- `operationId` — Caller mutation idempotency key；cancel retry 必須綁定相同 intent／target。
- `taskId` — Caller 查詢／取消 identity；每次依 current Access Scope／Agent allowlist 授權。
- `instruction` — Caller 持久內容；只在受控 worker 中依 binding snapshot 執行。
- `executionReference` — 核心內部建立並持久傳遞，Caller／worker 不可選擇或改寫。
- `worker.observation` — Runtime IPC 的 Reference-bound ordinal／progress／candidate／session payload。
- `candidateOutcome` — worker 外部衍生且未可信終態；bounded 驗證後先持久，不直接公開 success。
- `stopEvidence` — G1 Linux Adapter 的內部 verified evidence；必須綁定完整 Reference／unit／sealed generation。
- `terminalResult` — 核心在 terminal transaction 衍生的 bounded public result／failure。
- `sessionReference` — SDK 外部衍生、bounded 且綁定 execution；S3 只保存，不提供公開續接。
- `launchProfile` — 管理者配置；Caller／worker override 一律拒絕。
- `workspaceIdentity` — Registry canonical identity；不得接受任意 cwd／host path。
- `authorization.registryRevision` — preparation transaction 的 current protected revision fence。
- `error.details` — Runtime／Supervisor／storage 外部錯誤的 sanitized bounded projection。
- `evidence.label` — target／fixture metadata；不得含 credential、完整 instruction／result 或 host secret。
