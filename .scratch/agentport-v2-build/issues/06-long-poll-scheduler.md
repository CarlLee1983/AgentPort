# 06: long-poll 與 Scheduler

**What to build:** Caller 呼叫 `get_task({ wait_seconds })` 會等到狀態改變才回，不必自己輪詢；對同一 agent 連派三個 Task 依序執行，對兩個 agent 各派一個則同時跑。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] `wait_seconds` 為 0 立即回；否則等到狀態改變或 `min(wait_seconds, long_poll_max_seconds)`，逾時回當前狀態
- [ ] 每 agent 一條 FIFO worker；同 agent 的第二個 Task 在第一個結束前保持 queued
- [ ] 不同 agent 的 Task 並行執行（測試以假 Driver 的延遲證明重疊）
- [ ] 無佇列上限
