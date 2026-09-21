# Task 狀態模型與 follow-up 語意

Type: grilling
Status: resolved
Blocked by: 04
Map: ../map.md

## Question

定義 Task 的狀態集合（含 needs_input）、Context 與 Runtime Session 的對應、follow-up 在 session 無法延續時的行為、同一 agent 的序列化佇列、服務重啟後未完成 task 的處置（v1 的 recovery 砍掉後要留什麼）。更新 CONTEXT.md。

票 04 定案後新增：兩個 runtime 都永不等待、提問只會是最終回覆的文字，`needs_input` 是否還需要是獨立狀態？若砍掉，caller 如何辨識「這輪其實在問我」（只靠文字？由服務層用 heuristic 標記？不標記）？

## Answer

2026-09-21 grilling，十二題全數依建議定案。

### 狀態集合與轉移

`queued → running → completed | failed | cancelled`。**沒有 `needs_input`**：Turn 結束時 runtime 已退出，提問只是 `final_text` 的內容。`completed` 結果附非權威的 `hints`（`permission_denied[]` 原樣轉交 Claude 的 `permission_denials`；`git` 摘要失敗原因），不做問句 heuristic。

| 從 | 到 | 觸發 |
|---|---|---|
| — | queued | `submit_task` / `follow_up` 立即建立 |
| queued | running | 該 agent 的序列 worker 取出 |
| queued | cancelled | `cancel_task`，直接移出佇列 |
| running | completed | Driver `completed` 事件，之後服務層跑 `git diff --stat` + commit 清單；git 失敗仍 completed，`diff_stat`/`commits` 為 null 並附 `hints.git` |
| running | failed | Driver `failed`；resume 失敗 → `error.code = session_unresumable`；服務重啟時所有 running → `failed{interrupted}` |
| running | cancelled | 票 10 定義 |

### Context 與 Runtime Session

- Context id 由 AgentPort 發（ULID），`submit_task` 時建立並回傳，綁定一個 agent 不可換；`runtime_session_id` 存在 Context 上，第一個 Task 完成後回填。
- Follow-up 帶 `context_id`。前一個 Task 仍 queued/running → 排在同 agent 佇列後（Context 內嚴格線性）；前一個 failed/cancelled → 仍允許，有 `runtime_session_id` 就 resume，沒有就當首個 Task 起新 session。
- resume 失敗 → Task `failed{session_unresumable}`，不靜默退化為新對話。

### 佇列與重啟

- 每 agent 一條 FIFO，不同 agent 並行；不設佇列上限。
- 重啟：running → `failed{interrupted}`（不從 JSONL 回填 partial）；queued → 照常自動執行。**偏離 ADR-0002 第二段**（v1 要求佇列暫停等 caller 確認），理由：queued 無副作用、單操作者。修訂與票 08 的憑證 ADR 一併出。

### 持久化

Task 表：`task_id`、`context_id`、`agent`、`caller`、`prompt`（存原文）、`state`、`created_at/started_at/finished_at`、`final_text`、`diff_stat`、`commits[]`、`usage`、`hints`、`error{code,message}`、`raw_log_path`。Context 表：`context_id`、`agent`、`runtime_session_id`、`created_at`。原始 JSONL 只在磁碟。永久保留，不清理；不做 submit 去重。

### 詞彙

`CONTEXT.md`：刪 Clarification Reply；Follow-up Task 改為「回答提問的唯一方式」，標 `needs_input` 為 avoid；Context 補「AgentPort 發 id、綁定 agent、延續失敗明確失敗」。

進 fog：佇列上限、`idempotency_key`、Task 保留期限清理。
