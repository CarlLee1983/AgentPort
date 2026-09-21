# 07: Context 與 Follow-up

**What to build:** Caller 用 `follow_up({ context_id, prompt })` 在同一段脈絡追加要求，runtime 記得前面的對話；session 無法延續時得到明確的 `session_unresumable`。

**Blocked by:** 04, 05

**Status:** done

- [x] 第一個 Task 的 `started` 事件回填 Context 的 `runtime_session_id`
- [x] Claude 以 `--resume <session_id>`、Codex 以 `codex exec resume <thread_id>` 續接；真 CLI 測試證明第二輪記得第一輪內容
- [x] Context 不存在 → `not_found`；Context 綁定的 agent 不可換
- [x] 前一個 Task 仍 queued / running → follow-up 排在其後；前一個 failed / cancelled → 仍允許，有 session id 就 resume，否則起新 session
- [x] resume 失敗 → Task `failed`、`error.code = session_unresumable`，不靜默退化為新對話
