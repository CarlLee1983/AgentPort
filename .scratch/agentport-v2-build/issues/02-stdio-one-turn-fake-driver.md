# 02: stdio 單輪派工（假 Driver）

**What to build:** 在主機上用 Claude Code 之類的 MCP client 以 stdio 連上 `agentport stdio`，呼叫 `list_agents` 看到設定檔的 agent，`submit_task` 立刻拿到 `task_id` 與 `context_id`，`get_task`（不等待）看到 Task 從 queued 走到 running 再到 completed，`final_text` 是假 Driver 回的文字。這張建立 server factory、SQLite Task / Context 表、單 worker、`hints` 與 `raw_log_path`。

**Blocked by:** 01

**Status:** done

- [x] 一份 server factory，`agentport stdio` 以 `serveStdio` 啟動；caller 記為 `local`
- [x] SQLite 表含 spec 列出的 Task / Context 欄位；`prompt` 原文入庫；重開服務後 `get_task` 仍查得到
- [x] Driver 介面與六種事件依 spec 定義；假 Driver 可由測試腳本指定事件序列、延遲與失敗
- [x] `get_task` 在 Driver `failed` 時回 `failed` 與 `error{code: runtime_failed}`；`permission_denied` 事件原樣進 `hints.permission_denied[]`
- [x] 原始事件 JSONL 寫到 `log_dir`，路徑記在 Task 的 `raw_log_path`
- [x] 三個 tool 皆有 zod input / output schema，回 `structuredContent` 與同內容 `content[text]`；`unknown_agent`、`not_found` 錯誤碼
- [x] 測試透過 in-memory transport 的 MCP client 呼叫 tool，不碰網路
