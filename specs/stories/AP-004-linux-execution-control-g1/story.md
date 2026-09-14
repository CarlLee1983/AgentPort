# Story: AP-004 — Prove Linux Execution Control

## Goal

在指定 Linux target 上，以不開放 production dispatch 的受控 harness 證明
Execution Generation fencing、cgroup v2 descendant containment、可靠 Stop Evidence，
以及 bounded Runtime worker IPC，形成 S3 可依賴的 G1-L 證據。

## Context

本 Story 對應 [Implementation Plan S1／G1-L](../../../docs/implementation-plan.md)。
[AP-003](../AP-003-platform-neutral-execution-control-preparation/story.md) 已完成
platform-neutral lifecycle 與 Supervisor contract preparation，但其 scripted fixture
不可呼叫 Adapter，也不是 Stop Evidence。依 [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)，
任何 Runtime dispatch 必須先在指定 Linux target 驗證 generation 永久封閉且 Execution
Unit 為空；macOS process group、`launchd`、Docker Desktop 或 synthetic evidence 均不可替代。

本 Story 只建立指定環境中的能力與證據，不把 harness 組裝至 production MCP path。
GATE-021 將真 Claude authentication／Runtime capability 分離至後續 G1-C Story；S3 必須
同時依賴本 Story 經 Human Review 接受的 G1-L evidence 與 G1-C evidence。本 Story
單獨完成不能解除 production Runtime dispatch 的阻擋。

## Classification

- Security sensitive: yes
- Baseline conformance: no
- Task mode: mixed

## Authority

以下權限只在指定 Linux target 的 ForgePilot Gate 由 Human resolve、Work Item 為
READY，且使用者明確交辦 Start 後生效。

- plan: yes
- modify: yes
- add_dependency: no
- migration: no
- commit: no
- push: no
- deploy: no

## Architecture

- Impact: high
- Boundary: `Linux Supervisor Adapter, launcher, isolated Runtime worker and evidence harness; no production MCP dispatch`
- Contract: `Stop Evidence exists only after a persisted generation is sealed and its cgroup v2 Execution Unit is proven empty`
- Owner: `Linux Supervisor Adapter, launcher, isolated Runtime worker and evidence harness; no production MCP dispatch = AgentPort maintainers`

## Risk

- Level: high
- Reason: `privileged Linux execution containment and generation concurrency`
- Reason: `false-stop-evidence and isolated worker boundary risk`

## Scope

### In Scope

- 指定 Linux target、cgroup v2 hierarchy、專用低權限 Runtime account、受保護
  Supervisor ledger／launcher boundary 與測試 Workspace 的實際 metadata 驗證。
- `start`、`revokeAndStop`、`reconcile` 三項既有 Supervisor interface 的 Linux
  Adapter；持久 generation ledger、開始前放行點、不透明 Execution Unit ID、同 Reference
  idempotency 與 start／stop serialization。
- 取消早於 start、延遲 start、同步卡住 worker、一般／detached descendants、daemon／
  Supervisor restart、ledger-only／unit-only orphan 與 indeterminate failure tests。
- 每次 execution 的獨立 Runtime worker 與 bounded Reference-bound IPC；worker 不得取得
  核心 DB、Supervisor ledger 或 launcher privilege。
- `test:linux` 與必要 harness／fixture；保存可重現的 target、命令、event ordering、
  stop count、unit-empty 與限制證據。

### Out of Scope

- production MCP dispatcher、公開 Runtime execution、production bootstrap composition 或部署。
- AgentPort Task 的 candidate outcome、terminal result／event、claim release 或公開 result API。
- S3 的 SQLite terminal transaction、production recovery integration 與 G3。
- S4 的 Follow-up Task、Clarification Reply、完整 queue／edit／resume，以及 S5 fault matrix。
- native macOS Runtime Adapter、process-group Stop Evidence 或非 cgroup v2 等價宣告。
- 真 Claude subscription authentication、SDK `query()`、structured result、AskUserQuestion、
  回答後續行、SDK cancellation 與 Session reference；這些由後續 G1-C Story 驗證。

## Inputs

- [ADR-0001](../../../docs/adr/0001-external-observation-and-control.md) 的獨立 worker／外側控制邊界。
- [ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md) 的未知結果不自動重跑語意。
- [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md) 的 Linux-only execution 與可靠停止決策。
- [Technical Design](../../../docs/technical-design.md) 的 Supervisor、generation、Execution Unit 與 IPC contract。
- AP-003 經批准的 platform-neutral Execution Reference 與 Supervisor interface。

## Outputs

- `src/supervisor/linux/` 的最小 cgroup v2 Adapter／持久 ledger 與受保護 launcher seam。
- `src/runtime/worker/` 的最小 bounded worker IPC harness；不被 production bootstrap import。
- Linux generation／descendant／restart、worker isolation 與 IPC contract tests。
- G1-L verification evidence，綁定指定 target、toolchain、source candidate、命令與限制。

## Rules

- R1: generation 必須在任何 worker 放行前持久登記；撤銷一旦 commit，延遲或重送的
  start 永遠不得建立／進入 Execution Unit。
- R2: `revokeAndStop` 先封閉 generation，再 cooperative／forced stop；只有 generation
  不會再放行且 cgroup v2 unit 已空才能回 verified Stop Evidence。
- R3: not_found、PID 消失、signal 已送、worker cooperative cancel 已回覆或 cgroup 暫時為空均不等於
  stopped；未知狀態回 pending／indeterminate 並保留可核對 evidence。
- R4: `reconcile` 不啟動、resume 或重播 Runtime command；舊 epoch、ledger-only、unit-only
  或 reference mismatch 必須撤銷／收斂，無法確認時 fail closed。
- R5: Runtime worker 只取得該 execution 所需 Workspace 與最小固定環境，不得讀寫
  AgentPort DB、Supervisor ledger、launcher socket／token 或其他管理者 secrets。
- R6: harness、fixture 與 Adapter 不得由 production MCP composition 到達；本 Story PASS
  只證明 G1-L，不發布 S3 execution capability 或真 Claude capability。

## Expected Errors

- stale generation、Reference／epoch mismatch 或重複不同 Reference 回 conflict／indeterminate，
  不啟動 worker。
- cgroup／ledger／launcher unavailable、stop timeout 或 unit-empty 無法證明時回 unavailable／
  indeterminate，不產生 Stop Evidence。
- worker IPC ordinal／Reference／payload 不合法時拒絕並停止信任該 observation。
- target 缺少 cgroup v2、delegation、專用帳號或受保護 ledger／launcher 時拒絕執行
  privileged harness。

## Dependencies

- AP-001 的固定 Node／pnpm／SDK／SQLite compatibility baseline。
- AP-003 的 platform-neutral Supervisor contract 與 Execution Reference。
- Human 已指定並核准 `agentport-g1` Linux target；macOS host、Docker Desktop 或其他
  未核准環境不能取代該 target evidence。
- S3 Work Item 必須依賴本 Story 與後續 G1-C Story 都經 Human Review 接受，不得只依賴
  local `make verify` 或本 Story 的 Linux evidence。

## Constraints

- 不部署、不開放遠端 Task dispatch、不新增 hidden feature flag 或 production no-op Adapter。
- 不以 root Runtime worker 代替最小 launcher privilege；Supervisor 與 Runtime account 分離。
- 外部 Linux tests 缺環境時必須明確未執行或失敗；`make verify` 仍保持無 credential 的
  canonical repository gate。`test:claude` 不屬於本 Story acceptance。
- 若指定 target、launcher privilege 或 isolation policy 未定義，開
  ForgePilot Gate，不自行選擇較弱邊界。

## Guidance

- [Engineering entry](../../../guidance/ENTRY.md)：最小內聚變更、明確依賴、行為導向測試。
- [Development workflow](../../../docs/development-workflow.md)：environment evidence、Gate、candidate 與 Human Review。
- [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)：Linux execution 與 macOS development 邊界。

## Trust Boundary Fields

- `executionReference` — 由核心持久資料衍生並送入 Supervisor／worker，不接受 Caller override。
- `generation` — Supervisor ledger 中的啟動授權；只能由可信控制邊界建立／撤銷。
- `daemonEpoch` — daemon 啟動時建立並用於 fencing 舊 execution。
- `launchProfileId` — 管理者保護的 launcher／Runtime profile identity。
- `workspaceIdentity` — Registry canonical Workspace identity，不接受 worker path override。
- `executionUnitId` — Linux Adapter 回傳的不透明 cgroup identity，不接受 PID 或 Caller 值替代。
- `worker.observation` — 受限 IPC 的 Reference-bound ordinal／progress／candidate payload。
- `stopEvidence` — 只有 Linux Adapter 在 sealed generation 且 unit-empty 後產生的內部證據。
- `error.details` — launcher、cgroup 與 IPC 錯誤的 sanitized projection。
- `evidence.label` — target／fixture metadata；不得包含 credential、完整 prompt 或敏感 host path。
