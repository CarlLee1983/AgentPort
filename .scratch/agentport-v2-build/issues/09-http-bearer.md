# 09: HTTP transport 與 bearer caller

**What to build:** 管理者執行 `agentport serve`，遠端 caller 用 Streamable HTTP 加 bearer token 呼叫同一套 tool；每個 Task 記錄是哪個 caller 派的。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 同一份 server factory 以 `createMcpHandler` 掛到 Node HTTP server，stateless，不用 MCP session
- [ ] 搬 v1 loopback-server 的 Host / Origin 驗證與 bearer → `AuthInfo` 流程及其測試；token 由 `callers[].token_env` 靜態表比對
- [ ] 無 token、錯 token → 401；正確 token 的 Task 記錄 `caller` 為對應名稱
- [ ] 預設綁 `listen` 指定位址（預設 loopback）；`callers[]` 為空時 `serve` 拒絕啟動
- [ ] 已用 Claude Code 或 Codex 的 MCP 設定實際連上並跑通 `list_agents`
