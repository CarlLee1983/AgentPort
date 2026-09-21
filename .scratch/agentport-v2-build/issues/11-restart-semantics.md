# 11: 重啟語意

**What to build:** 服務重啟後，caller 用原 `task_id` 查得到每筆 Task；重啟當下執行中的變成 `failed{interrupted}`，排隊中的自動繼續跑。

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] 啟動時掃描 SQLite：所有 running → `failed`、`error.code = interrupted`，不從 JSONL 回填 partial
- [ ] queued 保留並由 worker 依原順序繼續執行
- [ ] 測試以「寫入 running / queued 狀態 → 重建 server → 觀察」的方式驗證，不依賴真程序
- [ ] 行為與 v1 ADR-0002 第二段的差異記在 12 號票的 ADR
