# 08: list_tasks 分頁與容量上限

**What to build:** Caller 用 `list_tasks` 依 agent / context / state 篩選並翻頁找回歷史 Task；任何單次回應都不超過 8 MiB。

**Blocked by:** 02

**Status:** done

- [x] `list_tasks({ agent?, context_id?, state?, limit?, cursor? })` 回摘要（不含 `final_text`）與 `next_cursor`；依 cursor 走完能拿到每筆恰一次
- [x] 整個 JSON-RPC 回應體以 8 MiB 為上限：超過時縮頁並給 cursor，不截斷單筆摘要（ADR-0005）
- [x] `get_task` 的 `final_text` 超過上限時截尾並附 `hints.truncated`，完整內容在 `raw_log_path`
- [x] `invalid_state`、`not_found` 等 tool 層錯誤碼有測試（`invalid_state` 隨票 10 的 `cancel_task` 一起補）
