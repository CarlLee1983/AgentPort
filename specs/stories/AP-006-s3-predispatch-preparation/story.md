# Story: AP-006 — Prepare S3 Persistence and Projection Without Runtime Dispatch

## Goal

在 G1 尚未證明時先完成 S3 可安全獨立驗收的 platform-neutral 部分：schema v3、
bounded worker observation／candidate persistence、取消排序、restart recovery 與唯一
`agentport_get_task` lifecycle projection；production composition 仍物理上無法啟動 Runtime，
因此不宣稱 S3、G3、可靠停止或 Runtime readiness。

## Context

本 Story 是 [Implementation Plan S3-A](../../../docs/implementation-plan.md) 的
pre-dispatch preparation lane。[AP-003](../AP-003-platform-neutral-execution-control-preparation/story.md)
已建立 prepared／recovering／quarantine 與不可達的 Supervisor seam；GATE-014 決定
`agentport_get_task` 是唯一產品 lifecycle projection，GATE-015 決定 schema v3 的舊 binary
拒絕與 v3-aware recovery／offline restore rollback。GATE-016 明確保留 G1 未證明及真正 S3
dispatch blocked 的事實。

本 Story 不修改 [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)：
任何 Runtime dispatch、Stop Evidence、terminal commit 與 Workspace claim release 仍須等待
指定 Linux target 的 G1。原 [AP-005](../AP-005-controlled-runtime-dispatch-s3/story.md) 保留為
S3-B／G3 production dispatch，且不因本 Story 完成而解除其 AP-004 dependency。

## Classification

- Security sensitive: yes
- Baseline conformance: yes
- Task mode: mixed

## Authority

以下權限只在 Human resolve 本 Story 的 ForgePilot Gate、Work Item 為 READY，且使用者
明確交辦 Start 後生效。

- plan: yes
- modify: yes
- add_dependency: no
- migration: yes
- commit: no
- push: no
- deploy: no

## Architecture

- Impact: high
- Boundary: `platform-neutral S3 persistence and MCP projection; no production Runtime ingress`
- Contract: `untrusted candidate data may reach stopping or recovering only; terminalization and claim release require future verified G1 Stop Evidence`
- Owner: `platform-neutral S3 persistence and MCP projection; no production Runtime ingress = AgentPort maintainers`

## Risk

- Level: high
- Reason: `persistent lifecycle compatibility and candidate ordering`
- Reason: `runtime isolation and false-terminal-evidence risk`

## Scope

### In Scope

- additive schema v3 migration for Reference-bound observation ordinals, bounded progress,
  untrusted candidate outcome／final ordinal, stop reason, recovery metadata and projection fields。
- schema v3 startup compatibility: AP-002／AP-003 binaries reject v3; rollback preserves DB／WAL、
  execution／candidate／claim evidence and uses a v3-aware recovery binary or offline restore only
  after reconciliation。
- exact-Reference contiguous observation persistence; identical duplicate idempotency, ordinal gap、
  conflicting duplicate、oversized or unbound candidate quarantine。
- candidate-versus-cancel durable commit ordering up to `stopping`；restart 將未確認 execution
  轉 `recovering`／quarantine，不 start、resume、replay 或自動 terminalize。
- 將 bounded execution lifecycle 合併進 `agentport_get_task`，移除 preparation-only
  `agentport_get_execution_lifecycle`；維持 authorization、Access Scope 與 sanitized errors。
- readiness 明確投影 `blocked`／`g1_unproven`，並以 import／composition／process tripwire
  證明 production 無 Linux Adapter、launcher、Runtime worker、Driver 或 credential ingress。

### Out of Scope

- `Supervisor.start`、production dispatcher、process／container／cgroup、Claude SDK `query()`、
  vendor credential injection 或任何 Runtime side effect。
- production `revokeAndStop`／`reconcile` composition、Stop Evidence 產生或接受、Execution
  terminal completed／failed／canceled／interrupted commit、result publication 或 claim release。
- Linux／Claude／fault e2e、G1、完整 S3／G3、可靠取消、production readiness 或 deployment。
- S4 Follow-up Task、Clarification Reply、queue／edit／resume 與 Runtime Session continuation。
- dormant feature flag、no-op Adapter、fake／scripted／PID／EOF／exit-code stopped evidence。

## Inputs

- AP-002／G2 與 AP-003 已完成的 durable admission、execution preparation 與 no-dispatch contracts。
- GATE-014 的單一 lifecycle projection 決策、GATE-015 的 schema v3 rollout／rollback 決策、
  GATE-016 的 G1-unproven／S3-blocked 決策。
- [Technical Design](../../../docs/technical-design.md) 的 lifecycle、transaction、recovery、
  projection 與 Stop Evidence ordering。
- [ADR-0001](../../../docs/adr/0001-external-observation-and-control.md)、
  [ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md)、
  [ADR-0003](../../../docs/adr/0003-local-transactional-task-store.md)、
  [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)。

## Outputs

- schema v3 migration、v3-aware compatibility／rollback checks 與真 SQLite transaction tests。
- AgentExecutionService-owned observation／candidate／cancel／recovery persistence up to nonterminal
  `stopping`／`recovering`。
- `agentport_get_task` 的唯一 bounded lifecycle projection 與 preparation-only tool removal。
- 強化的 no-production-dispatch tripwire 與 S3-A candidate-bound local verification evidence。

## Rules

- R1: AgentExecutionService 是唯一 Task／Execution lifecycle owner；storage 只原子持久化，
  MCP 只做 authorized bounded projection。
- R2: worker observation 與 candidate outcome 是不可信輸入；必須綁定完整 Execution Reference、
  ordinal 連續、payload bounded，且不得直接成為 terminal result 或 Stop Evidence。
- R3: 先 commit 的 candidate 或 cancel intent 決定 stop reason；兩者都只能進入 `stopping`，
  無 verified G1 Stop Evidence 不得 terminalize 或釋放 Workspace claim。
- R4: restart 將未確認 execution 轉 recovering／quarantine；不得 start、resume、replay、
  自動 terminalize 或套用終態 retention。
- R5: `agentport_get_task` 是唯一產品 lifecycle projection；不得保留第二份 lifecycle truth
  或 preparation-only public tool compatibility alias。
- R6: production bootstrap／MCP mutation path 不得 import 或呼叫 dispatcher、Linux Adapter、
  launcher、Runtime worker、Driver、Claude SDK 或 credential source；readiness fail closed。
- R7: schema v3 舊 binary 必須拒絕；rollback 保存所有 evidence，且不得以降版 binary
  重新開啟 v3 database。

## Expected Errors

- stale Reference、ordinal gap、conflicting duplicate、oversized payload 或 candidate mismatch
  回穩定 conflict／invalid observation，保留 claim 並 quarantine，不發布 raw payload。
- candidate／cancel race 只有一個持久 ordering；遲到資料不能改變 stop reason、terminalize
  execution 或釋放 claim。
- restart、DB／migration mismatch 或 unknown evidence 回 recovering／unavailable；不重播 Runtime。
- Caller／worker 提供 executionId、generation、profile、Workspace path／identity、Stop Evidence
  或 terminal result 一律拒絕，沒有 Runtime side effect 或跨 scope disclosure。
- schema v3 遇到 AP-002／AP-003 binary 明確拒絕；缺少 v3-aware recovery 路徑時 fail closed。

## Dependencies

- AP-002／G2 與 AP-003 Work Items 已 DONE；新 Work Item 只依賴已完成的 AP-003 WI-004。
- Human 必須 resolve 本 Story 的 Gate，接受「可持久 untrusted candidate 至 stopping，
  但 terminalization／claim release 仍等 G1」，並明確只 supersede GATE-012 的
  candidate-timing 部分後才能開始。
- AP-004／G1 可保持未證明；這只允許 S3-A preparation，不解除 AP-005／S3-B dependency。
- ForgePilot 0.2.1 無法修改既有 dependency；WI-006 必須保持 blocking Gate，
  直到本 Story Work Item 完成並經 Human Review，且 AP-004／G1 另外完成。

## Constraints

- migration additive，不刪除 Task、Execution、candidate、claim、event、receipt 或 evidence records。
- 不建立 hidden／dormant dispatcher、production Supervisor fallback、macOS Runtime path 或
  synthetic Stop Evidence。
- `make verify` 是唯一 automated repository gate；S3-A evidence 只宣稱 local pre-dispatch contract。
- commit、push、deploy 與 Human Review 仍需各自明確授權。

## Guidance

- [Engineering entry](../../../guidance/ENTRY.md)：最小內聚垂直切片、單一事實來源與行為導向測試。
- [Development workflow](../../../docs/development-workflow.md)：candidate、Gate、verification 與 Human Review。

## Trust Boundary Fields

- `taskId` — Caller 查詢 identity；每次依 current Access Scope／Agent allowlist 授權。
- `executionReference` — 核心建立並持久；Caller／worker 不可選擇或改寫。
- `worker.observation` — 外部衍生的 Reference-bound ordinal／progress／candidate payload。
- `candidateOutcome` — 不可信、bounded、nonterminal 資料；不能直接投影為 result。
- `stopEvidence` — 本 Story 沒有 production ingress；Caller／worker／fixture 提供一律拒絕。
- `terminalResult` — 本 Story 不接受或發布；只能由未來 verified-stop terminal transaction 衍生。
- `workspaceIdentity` — Registry canonical identity，不接受任意 cwd／host path。
- `authorization.registryRevision` — preparation／observation transaction 的 current revision fence。
- `error.details` — storage／protocol 外部錯誤的 sanitized bounded projection。
- `evidence.label` — candidate／fixture metadata，不得包含 credential、完整 instruction／result 或 host secret。

## Superseded Behavior

- `src/mcp/protocol.ts` — 移除 AP-003 preparation-only `agentport_get_execution_lifecycle`，改由 `agentport_get_task` 提供唯一 lifecycle projection。
- `src/storage/sqlite-durable-admission-store.ts` — 將 AP-003 固定 `candidateOutcome: null` 擴充為 bounded、Reference-bound、nonterminal candidate persistence。
- `specs/stories/AP-003-platform-neutral-execution-control-preparation/story.md` — 依 Human Gate 只 supersede GATE-012 「candidate outcome 延後至 G1 後 S3」的 timing；不 supersede Stop Evidence、terminal commit 或 claim release 禁止。
- `migrations/002_execution_control.sql` — 由 schema v2 preparation model 前進至 GATE-015 核准的 additive schema v3；不回寫或刪除 v2 evidence。
