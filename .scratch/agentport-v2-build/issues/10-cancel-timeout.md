# 10: 取消與 Turn 逾時【依地圖票 10，未結案時用 spec 假設】

**What to build:** Caller 對排隊中或執行中的 Task 呼叫 `cancel_task`，子程序被終止、Task 變 `cancelled` 並保留已收到的文字與 git 摘要；Turn 超過設定上限時視同取消但標 `timeout`。

**Blocked by:** 06, 07

**Status:** done

- [x] queued → cancelled 立即生效，不進 worker
- [x] running → 對 process group 送 SIGTERM，等待後 SIGKILL（秒數依票 10，預設 5）；Task `cancelled`，`final_text` 為已收到的 message 文字，仍跑 git 摘要
- [x] `[server] turn_timeout_seconds`（預設 3600）逾時 → 同取消流程，`error.code = timeout`
- [x] 對終態 Task 取消 → `invalid_state`
- [x] 取消後同一 Context 的 follow-up 行為（可否 resume）依票 09 / 10 實測結果寫進測試

實作時定案與實測結果已寫回 `specs/agentport-v2.md`「取消與逾時」段落（建置票 10 實作時定案）。
