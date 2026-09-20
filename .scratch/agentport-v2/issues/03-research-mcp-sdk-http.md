# Research：MCP TypeScript SDK 的 Streamable HTTP 伺服器與長輪詢

Type: research
Status: resolved
Map: ../map.md

## Question

v2 用 `@modelcontextprotocol/sdk` 提供 Streamable HTTP 服務、bearer token 認證、結構化 tool 輸出，且 `get_task` 要能 long-poll。需要確認：(1) 目前 SDK 版本的 Streamable HTTP server API 與 session 管理；(2) 官方建議的認證掛法（middleware / OAuth 之外的簡單 bearer）；(3) 主要 client（Claude Desktop、Claude Code、Cursor、Codex 的 MCP client）對單次 tool call 的逾時上限，決定 long-poll 的安全等待時間；(4) structured content / output schema 的支援現況；(5) stdio 與 HTTP 兩種 transport 是否能同一份 server 程式碼共用。

## Answer

Findings：branch `research/mcp-sdk-http`，檔案 `.scratch/agentport-v2/research/mcp-sdk-http.md`（官方 spec、SDK 2.0.0 原始碼、各 client 官方文件；未查證處已在檔內標記）。

1. SDK：`@modelcontextprotocol/sdk` 1.x 停在 1.30.0；v2 拆成 `@modelcontextprotocol/server` / `node` / `express` / `hono` / `core` / `client` 2.0.0（Node ≥ 20、zod ^4）。v1 AgentPort 已用 `server`+`node` 2.0.0，其 `loopback-server.ts`（`toNodeHandler` + Host/Origin 驗證 + bearer → `AuthInfo`）可直接搬。
2. Session：spec 2026-07-28 刪掉 `Mcp-Session-Id` 與 `initialize`；`createMcpHandler(factory)` 每個 request 建新 server，只有 `legacy: 'stateless' | 'reject'`。v2 以 `task_id` 當 handle，不碰 session。
3. 逾時（決定 long-poll）：Codex `tool_timeout_sec` 預設 60 s；Claude Code HTTP 60 s 到第一個位元組 + 5 min idle，`MCP_TOOL_TIMEOUT` 整體 ≈ 28 h；Cursor、Claude Desktop 未文件化。結論：`get_task` 伺服器端等待上限 < 60 s，建議 25–45 s。
4. Auth / header：handler 不驗 token，前置 middleware 驗完後以 `authInfo` 傳入，tool 從 `ctx.http.authInfo` 讀；`requireBearerAuth` + 自寫 `verifyAccessToken` 查靜態表即可（`expiresAt` 未設會 401）。Claude Code、Codex、Cursor 都能從設定送自訂 header 與環境變數；Claude Desktop 設定檔只有 stdio，遠端 HTTP 只走 Connectors/OAuth。
5. Structured output 與雙 transport：`outputSchema` 驗 `structuredContent` 但要同時回 `content[text]`；Claude Code 會讀並驗證，其他 client 未查證。一個 server instance 不能接兩個 transport，正確做法是同一個 factory 分別餵 `serveStdio(factory)` 與 `createMcpHandler(factory)`。v1 鎖 `supportedProtocolVersions: ["2026-07-28"]` 會拒 2025-era client，Codex 的協定版本未查證。
