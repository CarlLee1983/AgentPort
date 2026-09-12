# 15: 真 Claude 澄清投遞與計時

**What to build:** 真 Claude 提出問題後，另一位同 scope Caller 可回答並繼續同一 Task；答案接受、送達、原生採用與不確定狀態清楚可查，等待及執行期限正確。

**Blocked by:** 14 — 持久問題與首答案裁定.

**Status:** ready-for-agent

- [ ] 將已驗證 Claude AskUserQuestion／canUseTool 待決 callback 接入持久 Question 路徑，按工具名稱分流一般批准；同原生題組一次回覆，答案不得提升工具、網路、主機或憑證權限。
- [ ] 首答案 commit 後才送原 execution；worker 依 questionId 去重、核對仍等待並交給 callback，再回 ack；有處理證據才 awaiting_input→running。
- [ ] 答案接受但未 ack 顯示 accepted＋delivery=pending，首答案 commit 已停用 input expiry／恢復累計執行時計；不接受第二答案，也不因原回答期限到期錯殺。
- [ ] 投遞或 ack 間 daemon／worker 故障標 delivery=unknown、保留首答案並禁止自動重送；callback 遺失不以 Session resume 假裝恢復，依既有停止／recovering 規則處理。
- [ ] 真 Claude 進純等待前確認所有平行工具靜止；Workspace 全程占用，未靜止不可暫停執行時鐘；固定模式不能保證即互動驗收失敗。
- [ ] 累計執行預設 60 分鐘，包含 starting／running／答案投遞，排除 queued／paused／證實純等待；待回答預設 24 小時，worker 與 supervisor 持有失聯兜底，遠端只可在管理者範圍調整。
- [ ] 驗等待與投遞中取消、答案與期限競爭、工具平行活動、投遞卡住／重啟、同 scope 不同 actor 真正答題續跑；保存問題、答案、delivery 與部分結果。
- [ ] test:claude 經公開 MCP 實際完成提問→另一 principal 回答→同 Task 繼續，fault fixtures 驗 commit/delivery/ack 各窗口；更新 AC-05／AC-07／AC-09／AC-10、操作文件與相關 gates，不以 fake 代替真往返。
