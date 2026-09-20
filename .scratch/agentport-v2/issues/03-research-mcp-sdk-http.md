# Research：MCP TypeScript SDK 的 Streamable HTTP 伺服器與長輪詢

Type: research
Status: open
Map: ../map.md

## Question

v2 用 `@modelcontextprotocol/sdk` 提供 Streamable HTTP 服務、bearer token 認證、結構化 tool 輸出，且 `get_task` 要能 long-poll。需要確認：(1) 目前 SDK 版本的 Streamable HTTP server API 與 session 管理；(2) 官方建議的認證掛法（middleware / OAuth 之外的簡單 bearer）；(3) 主要 client（Claude Desktop、Claude Code、Cursor、Codex 的 MCP client）對單次 tool call 的逾時上限，決定 long-poll 的安全等待時間；(4) structured content / output schema 的支援現況；(5) stdio 與 HTTP 兩種 transport 是否能同一份 server 程式碼共用。
