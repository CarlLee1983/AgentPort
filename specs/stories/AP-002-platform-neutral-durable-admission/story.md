# Story: AP-002 — Build Platform-neutral Durable Admission

## Goal

在不啟動 Runtime 的前提下，建立可於 macOS 或 Linux 開發與驗證的持久 Task admission 切片，讓相容 MCP Caller 能取得穩定 Task ID、跨重啟查詢，並取消尚未啟動的工作。

## Context

對應 [Implementation Plan S2 / G2](../../../docs/implementation-plan.md)。AP-001 repository evidence 記錄 immutable revision `e1076f0ba4e7e3b2a345a9e23a3ed2e22447738b`／`EV-001` 的 local PASS，但指定 Linux target 缺席使 AC-09／G0 保持 blocked。依 [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)，S2 可使用 platform-neutral development evidence 獨立進行；任何 Runtime dispatch、可靠停止或 Linux production 宣告仍依賴 S1／G1。

產品語意遵循 [CONTEXT](../../../CONTEXT.md)、[Technical Design](../../../docs/technical-design.md) 與既有 ADR。此 Story 不重新解釋 AP-001 AC-09，也不變更 Linux-only v0.1 deployment target。

## Classification

- Security sensitive: yes
- Baseline conformance: no
- Task mode: execution

## Authority

以下權限只在使用者明確交辦 Start AP-002 且 ForgePilot Work Item 為 READY 後生效。

- plan: yes
- modify: yes
- add_dependency: no
- migration: yes
- commit: no
- push: no
- deploy: no

Migration 僅限本 Story 的初始 SQLite schema；沒有既有 product data 可轉換，rollback 是移除未發布的 development database 與本切片程式。

## Architecture

- Impact: high
- Boundary: `durable admission across core, storage, Registry and MCP Adapter; no Runtime execution`
- Contract: `accepted Tasks are committed before response, retain identity across restart, and cannot reach an Execution boundary in this Story`
- Owner: `durable admission across core, storage, Registry and MCP Adapter; no Runtime execution = AgentPort maintainers`

## Risk

- Level: high
- Reason: `persistent task identity and authorization boundary`
- Reason: `concurrent idempotency and capacity reservation`

## Scope

### In Scope

- AgentExecutionService 的 Task／Context／BindingSnapshot／receipt／event 公開核心型別與 durable-admission 操作。
- SQLite 初始 migration、短交易、唯一約束、revision、scope-global event cursor、restart pause 與專用 DB worker。
- 管理者 Registry、Principal／Access Scope 分離、固定 Agent → Workspace／Runtime／policy binding 與 Workspace identity 驗證。
- `agentport_list_agents`、只建立新 Context 且拒絕 `contextId` 的 `agentport_submit_task`、`agentport_get_task`、`agentport_list_tasks`、`agentport_get_events`，以及可取消未啟動 queued／paused Task 的 `agentport_cancel_task`。
- operationId receipt／fingerprint、回應遺失重試、同鍵並行提交、跨重啟去重與授權後查詢。
- 一般 admission 與既有 Task 控制／結案 reserve 分離，以及 DB unavailable／capacity failure 的明確結果。
- macOS 與 Linux 上不含 Runtime 的 unit、integration、official MCP Client 與 fake-worker contract tests。

### Out of Scope

- 建立 Execution、取得 Workspace claim、dispatcher、Runtime worker／Driver、Execution Supervisor 或任何 launcher Adapter。
- 啟動 Claude Code、Claude Agent SDK `query()`、子程序、container、cgroup、process group 或 `launchd` service。
- running／stopping／completed／failed／recovering／interrupted 的 execution lifecycle 與 Stop Evidence。
- 問題／回答、追加佇列、edit、resume、acknowledge_interruption、Runtime Session continuation，以及 S3–S6 工具。
- Linux G1、AP-001 AC-09、native macOS Runtime／deployment 或 production readiness evidence。

## Inputs

- [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md) 的平台與 sequencing 決策。
- [Technical Design](../../../docs/technical-design.md) 的授權、Task admission、持久化、事件、容量與錯誤契約。
- [AP-001 compatibility record](../../../docs/toolchain-compatibility.md) 與 local verification evidence；blocked Linux metadata 不是本 Story 的替代輸入。
- [Local transactional store ADR](../../../docs/adr/0003-local-transactional-task-store.md)；實作若證實選擇成立，才由 Human Review 決定是否接受該 ADR。

## Outputs

- 最小 `src/core/`、`src/storage/`、`src/mcp/` 與必要 bootstrap 組裝，沒有 `src/runtime/` 或 `src/supervisor/` production implementation。
- 初始 SQLite migration、官方 MCP Client fixture、真 SQLite integration tests、authorization／concurrency／restart／capacity tests。
- 本 Story 的 `verification.md`，逐項保存 AC、命令、source revision、OS、fixture、實際觀察與限制。
- 更新 Technical Design／Implementation Plan／operations notes，明示此切片不會 dispatch 且不是 production-ready AgentPort。

## Rules

- R1: submit 必須在 Task、Context、BindingSnapshot、receipt 與 accepted event 原子 commit 後才回 Task ID；commit 失敗不得留下 execution 或外部副作用。
- R2: operationId 在 Access Scope 內唯一，相同初始 fingerprint 回原 receipt，不同 fingerprint 回 conflict；後續 Task 變更不改寫原 fingerprint。
- R3: MCP Adapter 只做協定、schema、Principal 與結果轉譯；AgentExecutionService 是 Task lifecycle 唯一事實來源，storage 不重播 Runtime 命令。
- R4: 每個讀取與 mutation 都重新驗證當前 membership、scope 與 Agent allowlist；Client 不得指定 host path、binary、Driver options、policy、Principal 或 Access Scope。S2 submit 只建立新 Context，任何 `contextId` 都以 schema error 拒絕，不提供 Follow-up Task 語意。
- R5: daemon restart 將從未啟動的 queued Task 轉 paused 並保留 Task ID／順序／receipt；本 Story 沒有任何自動 dispatch 或 resume path。
- R6: accepted Task 預留取消、receipt、event 與結案所需容量；一般 admission 容量不足先拒絕新工作，不淘汰或假接受既有 Task。
- R7: AP-002 diff 不得新增 dormant 或 feature-flagged production dispatcher、Runtime Driver、worker launcher 或 production／test Supervisor Adapter；S2 build／import／composition graph 的每種配置都不得到達可能由 S1 平行交付的 execution artifacts。test-only tripwire 必須在任何程序建立嘗試時失敗；fake worker 只能驗證訊息 contract，不可成為隱藏 launcher 或 Stop Evidence 來源。

## Expected Errors

- 缺少／無效 credential 回 HTTP 401；不存在與未授權資源使用相同 not_found，不洩漏跨 scope 身份。
- operationId fingerprint 或 schema（包含任何 `contextId`）衝突回穩定 error code、safe-retry 資訊及授權後快照，不建立第二個 Task。
- queue／一般 tombstone／storage admission 容量不足拒絕新 submit；既有 Task 的 get／cancel 保持保留容量。
- SQLite commit／worker 不可用時不回 accepted；已知快照可標 stale，無可靠快照回 unavailable。
- 任何嘗試建立 Execution 或啟動 Runtime 都明確失敗且沒有程序副作用。

## Dependencies

- 使用 AP-001 repository verification 記錄的 `e1076f0ba4e7e3b2a345a9e23a3ed2e22447738b`／`EV-001` local compatibility evidence；AP-001 AC-09／G0 可保持 blocked，不能因本 Story PASS 而改列通過。
- S1 可在指定 Linux target 可用後平行進行；S3 必須同時依賴 G1 與本 Story G2，不得由依賴順序或 fake Adapter 繞過。
- 不需要 vendor credential、Linux cgroup 或 production data directory；需要 repository 固定的 Node、pnpm、MCP SDK 與 SQLite binding。

## Constraints

- 不建立 hypothetical Execution Supervisor Adapter；platform-neutral interface 由 Technical Design 固定，本 Story 不實作 production 或 test Supervisor Adapter。
- 不發布或部署服務，不對非 loopback 網路暴露 development fixture。
- 不以 in-memory fake 代替真 SQLite 的 transaction、restart 或 concurrency evidence。
- `make verify` 是 canonical local gate；macOS PASS 只證明列出的 platform-neutral 行為。
- public tool 只發布本 Story 已實作且具有正確語意的六項操作，不為後續工具建立空成功結果。

## Guidance

- [Engineering entry](../../../guidance/ENTRY.md)：最小內聚變更、明確依賴、行為導向測試。
- [Development workflow](../../../docs/development-workflow.md)：Story authority、Gate、verification 與 Human Review。
- [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)：Linux execution 與 macOS development 的界線。

## Trust Boundary Fields

- `Authorization` — MCP HTTP credential，只在入口解析為 Principal，不保存 token。
- `protocolVersion` — 每請求外部 MCP revision。
- `clientInfo` — 每請求外部 Client identity metadata。
- `capabilities` — 每請求外部 Client capability metadata。
- `operationId` — Caller 提供的 mutation 去重識別。
- `agentId` — Caller 選擇的管理者配置 Agent。
- `taskId` — Caller 查詢或取消的 Task identity。
- `contextId` — Caller 嘗試提供的既有 Context identity；S2 一律拒絕。
- `instruction` — Caller 提供的工作文字，保存但不執行。
- `executionLimitSeconds` — Caller 請求值，只能在管理者允許範圍內保存。
- `inputWaitSeconds` — Caller 請求值，只能在管理者允許範圍內保存。
- `cursor` — Caller 提供且綁定 Access Scope／filter 的事件或分頁位置。
- `filter.agentId` — Caller 提供的列表篩選值。
- `filter.state` — Caller 提供的列表篩選值。
- `limit` — Caller 提供且受上限約束的頁面大小。
- `principalId` — Caller 嘗試提供的身份 override；一律拒絕。
- `accessScopeId` — Caller 嘗試提供的 scope override；一律拒絕。
- `workspacePath` — Caller 嘗試提供的 host path override；一律拒絕。
- `runtimeBinary` — Caller 嘗試提供的 binary override；一律拒絕。
- `driverOptions` — Caller 嘗試提供的 Driver override；一律拒絕。
- `policy` — Caller 嘗試提供的 execution policy override；一律拒絕。
- `authorization.membership` — 受保護配置衍生的當前 membership；每次操作重新讀取。
- `authorization.agentAllowlist` — 受保護配置衍生的當前 Agent 權限；每次操作重新讀取。
- `error.details` — 外部輸入衍生的安全錯誤內容，不得含 credential、host path 或跨 scope identity。
- `evidence.label` — 外部 metadata 衍生的測試標籤，不得含 credential 或 instruction 全文。
