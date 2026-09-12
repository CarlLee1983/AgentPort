# Implementation Plan

此檔只列依賴順序與 evidence 提示。Product requirements 在 story.md／acceptance.md；正式執行狀態與領取由 ForgePilot Work Item 管理。

## Plan

1. 固定 AgentExecutionService 的 durable-admission interface、transaction boundary 與不可到達的 execution seam；建立對應 contract tests。
2. 建立最小 SQLite migration／DB worker，先完成 Task、Context、BindingSnapshot、receipt、event 與 reserve 的 transaction／restart tests。
3. 實作 Registry、Principal／Access Scope 授權與 Workspace identity 驗證，完成跨 scope 與 override failure tests。
4. 接上六項 MCP 工具，使用官方 Client 驗證 schema、短回應、safe retry、查詢、events、queued cancellation 與 restart 後 paused cancellation；S2 submit 拒絕所有 `contextId`。
5. 注入 concurrency、response loss、commit failure、capacity exhaustion、DB blocking／timeout 與 daemon restart，確認沒有 dispatch 或部分接受。
6. 在 macOS 跑 focused platform-neutral checks 與完整 `make verify`；Linux target 可用時以同 revision 補平台中立 evidence，不執行 S1。
7. 更新 verification／operation notes，逐項對照 AC、實際 revision、命令、觀察、限制及 rollback，提交 Human Review。

## Notes

- 不建立 Runtime／Supervisor production Adapter，不啟動 Claude 或任何 execution process。
- S3 只有在 AP-002 G2 與 Linux S1 G1 都通過後才能開始。
- 已決定讓 AP-001 AC-09 保持 blocked 並延後 G0 acceptance；本 Story evidence 不可用來改寫該決定。
