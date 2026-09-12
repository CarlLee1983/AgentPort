# Story: AP-003 — Prepare Platform-neutral Execution Control

## Goal

在不啟動 Runtime 或建立可到達 dispatcher 的前提下，完成之後 S3 所需的
execution lifecycle core、SQLite transaction／recovery 語意、Supervisor contract
與可查詢 lifecycle projection；讓 Linux S1 之後只需接入已驗證的 Linux Adapter
與真 Claude evidence。

## Context

此 Story 是 [Implementation Plan S1-P](../../../docs/implementation-plan.md) 的
pre-G1 preparation lane。它沿用 [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)
的 Linux-only execution 決策，沒有放寬 G1 或讓 fake／scripted fixture 成為 Stop Evidence。
AP-002 已完成 durable admission；本 Story 只能擴展不可由 production composition
到達的 lifecycle Module，S3 仍必須同時依賴 G1 與 G2。

## Classification

- Security sensitive: yes
- Baseline conformance: no
- Task mode: mixed

## Authority

以下權限只在 Human resolve 本 Story的 ForgePilot Gate、Work Item 為 READY，且使用者明確交辦 Start 後生效。

- plan: yes
- modify: yes
- add_dependency: no
- migration: yes
- commit: no
- push: no
- deploy: no

## Architecture

- Impact: high
- Boundary: `platform-neutral execution lifecycle and Supervisor seam; no production dispatch`
- Contract: `AgentExecutionService remains the sole lifecycle owner; only a verified Linux Adapter may produce production Stop Evidence`
- Owner: `platform-neutral execution lifecycle and Supervisor seam; no production dispatch = AgentPort maintainers`

## Risk

- Level: high
- Reason: `execution lifecycle concurrency`
- Reason: `runtime isolation and false-stop-evidence risk`

## Scope

### In Scope

- Execution Reference、generation、daemon epoch、quarantine 與 prepared／recovering
  lifecycle 的 platform-neutral core types、state transitions、SQLite transaction／restart
  semantics。candidate outcome 在本 Story 一律是 `null`。
- 唯一 Workspace claim、prepare／cancel race 與 restart→recovering／quarantine 的真 SQLite
  tests。claim 取得後保留到 S3 的真 Stop Evidence，不在本 Story 釋放。
- 既有三項 Supervisor interface：`start`、`revokeAndStop`、`reconcile`；其 scripted
  contract fixture、bounded Reference-bound worker observation schema 與 MCP lifecycle read
  projection。fixture 只表達 pending／indeterminate。
- 加強 no-dispatch composition／process tripwire，確保 admission bootstrap 不可到達
  dispatcher、Runtime Driver、worker launcher 或 Supervisor Adapter。

### Out of Scope

- Linux Supervisor Adapter、cgroup、Execution Unit、container、subprocess、Runtime
  worker、Claude SDK `query()` 或任何 production dispatcher composition。
- 真 Stop Evidence、generation fencing 的環境證據、descendant cleanup、G1、G3、
  deployment 或 production readiness。
- candidate outcome persistence、terminal commit、terminal result、claim release 或以
  non-production abstraction 假裝的可信 Stop Evidence；這些由 GATE-012 明確延後至 G1 後的 S3。
- 真 Claude 問題／回答、取消、Session continuation，以及 S4–S6 的公開工具。

## Inputs

- [Technical Design](../../../docs/technical-design.md) 的 Supervisor contract 與
  execution transaction ordering。
- [ADR-0001](../../../docs/adr/0001-external-observation-and-control.md)、
  [ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md)、
  [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)。
- AP-002 的完成 Work Item 與 durable admission core。

## Outputs

- 未組裝至 production bootstrap 的 execution lifecycle Module、SQLite migration
  與 contract fixtures。
- AP-003 verification evidence，逐項標示 core/model evidence 與未驗證 Linux limits。
- 更新後的 no-dispatch reachability contract；不宣稱 G1 或 S3 完成。

## Rules

- R1: AgentExecutionService 是 Task／Execution lifecycle 的唯一事實來源；MCP、storage
  與 fixture 不得建立第二份狀態機。
- R2: Execution Reference 必須綁定 executionId、immutable generation、daemon epoch、
  administrator launch profile 與 canonical Workspace identity；外部 Caller 不得提供或覆寫。
- R3: `start` 對同一 Reference 必須 idempotent；revoke 後不得放行 start；`revokeAndStop`
  只可投影 stopped、pending 或 indeterminate，not_found 不等於 stopped。
- R4: scripted fixture 只可回 pending／indeterminate，不得成為 Stop Evidence、寫入 candidate
  outcome、觸發 terminal commit 或 claim release；未知或 indeterminate 保留 claim 並 quarantine Workspace。
- R5: production bootstrap／MCP mutation path 不得 import 或呼叫 dispatcher、Runtime
  Driver、worker launcher、Supervisor Adapter 或 Claude SDK。

## Expected Errors

- stale generation、Reference mismatch 或 duplicated Workspace claim 回穩定 conflict，
  不建立第二個 Execution 或釋放既有 claim。
- start／stop timeout、ledger mismatch 或 reconcile unknown 回 indeterminate／unavailable，
  保留 quarantine，不假定已停止。
- Caller supplied executionId、generation、launch profile、Workspace identity 或 Stop
  Evidence 以 schema／authorization error 拒絕，沒有持久化或 Runtime side effect。

## Dependencies

- AP-002 G2 已完成；本 Story 必須在 Gate 的 Human decision 後才能開始。
- S1/G1 可延後，但仍是 S3 dispatch、G3 與 release 的必要前提。

## Constraints

- 不建立 dormant／feature-flagged production dispatcher 或 no-op／macOS Supervisor Adapter。
- migration 必須是 additive；rollback 不得刪除持久資料或將 synthetic evidence 視為真實。
  `migrations/002_execution_control_rollback.sql` 只移除 version-2 marker，保留 AP-003
  tables/records，讓 AP-002 binary 可在 version 1 開啟資料庫。
- `make verify` 是 canonical local gate；macOS evidence 只能描述 platform-neutral contract。

## Guidance

- [Engineering entry](../../../guidance/ENTRY.md)：最小內聚變更、明確依賴、行為導向測試。
- [Development workflow](../../../docs/development-workflow.md)：Gate、candidate、verification 與 Human Review。

## Trust Boundary Fields

- `taskId` — Caller 查詢或取消的既有 Task identity。
- `executionId` — 僅由核心建立；Caller 提供值一律拒絕。
- `generation` — 僅由 Supervisor contract 與持久核心建立；Caller 提供值一律拒絕。
- `launchProfile` — 受保護管理者設定；Caller 提供值一律拒絕。
- `workspaceIdentity` — 受保護 Registry binding；Caller 提供值一律拒絕。
- `worker.observation` — 受限 IPC 輸入，必須綁定目前 Execution Reference 與 bounded payload。
- `stopEvidence` — 只接受已驗證 Supervisor Adapter 的內部輸入，絕不由 Caller 或 scripted fixture 提供。
