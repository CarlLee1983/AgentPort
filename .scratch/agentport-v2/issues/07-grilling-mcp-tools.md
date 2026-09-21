# MCP tool 表面

Type: grilling
Status: resolved
Blocked by: 03, 05
Map: ../map.md

## Question

定案 tool 清單與各自的輸入/輸出 schema：list_agents、submit_task、get_task（long-poll）、follow_up、cancel_task、list_tasks。回傳內容的容量策略（ADR-0005）。

## Answer

以 spec 假設的形狀實作並定案（建置票 02、06–10）：`list_agents`、`submit_task`、`get_task`（`wait_seconds` long-poll，上限 `long_poll_max_seconds` ≤ 55）、`follow_up`、`cancel_task`、`list_tasks`（cursor 分頁）。輸入輸出為 zod schema，回 `structuredContent` 與同內容 `content[text]`；tool 層錯誤為 `isError` + `{ error: { code, message } }`，碼為 `not_found` / `invalid_state` / `unknown_agent`。容量依 ADR-0005：整個回應體 8 MiB，`list_tasks` 縮頁給 cursor，`final_text` 截尾附 `hints.truncated`。細節見 spec「MCP tool 表面」。
