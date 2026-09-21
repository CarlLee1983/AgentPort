# 10: 取消與 Turn 逾時【依地圖票 10，未結案時用 spec 假設】

**What to build:** Caller 對排隊中或執行中的 Task 呼叫 `cancel_task`，子程序被終止、Task 變 `cancelled` 並保留已收到的文字與 git 摘要；Turn 超過設定上限時視同取消但標 `timeout`。

**Blocked by:** 06, 07

**Status:** ready-for-agent

- [ ] queued → cancelled 立即生效，不進 worker
- [ ] running → 對 process group 送 SIGTERM，等待後 SIGKILL（秒數依票 10，預設 5）；Task `cancelled`，`final_text` 為已收到的 message 文字，仍跑 git 摘要
- [ ] `[server] turn_timeout_seconds`（預設 3600）逾時 → 同取消流程，`error.code = timeout`
- [ ] 對終態 Task 取消 → `invalid_state`
- [ ] 取消後同一 Context 的 follow-up 行為（可否 resume）依票 09 / 10 實測結果寫進測試
