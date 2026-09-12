# 14: 持久問題與首答案裁定

**What to build:** Caller 可透過公開 MCP 查詢可控 worker 提出的問題並提交答案；同一 Question 只有首個有效答案生效，重送、衝突與到期都有明確結果。

**Blocked by:** 11 — 進展、工具活動與停滯觀察.

**Status:** ready-for-agent

- [ ] 以可控 worker 跑核心→Question 持久化→get/events→reply→worker 測試路徑；真 Claude 產品互動暫不開放，由後票接入，不發布無法處理的 Runtime 能力。
- [ ] Question 保存 questionId、taskId、executionId、原生 tool-use 關聯、整組有界問題／答案 schema、expiry、pending/accepted/closed、actor 與 delivery；問題先 commit、Task 進 awaiting_input 後才公開。
- [ ] 一般 permission request 與普通文字問號不成為 Question；一次原生多題呼叫只接受一組完整 schema 答案，問題／回答各限 32 KiB，提出問題前預留首答案及收斂空間。
- [ ] reply 交易驗證當前 scope／Agent 權限、Task／execution／Question、schema、仍在等待與期限；保存第一個有效答案、actor/hash、delivery=pending、receipt。
- [ ] questionId 約束跨不同 operationId 仍只一答案；相同答案重送回 already_accepted，不再次投遞，不同答案 answer_conflict；取消、過期、關閉不得再回答。
- [ ] reply／expiry／cancel 在同一交易邊界裁定，首答案 commit 關閉原 input expiry 並恢復累計執行時計；基礎時鐘與收斂語意在本票已正確，不延至真 Runtime 票才補安全。
- [ ] 可控 worker 回 ack 才進 running；對外清楚顯示 pending 或 accepted＋delivery=pending，故障無證據標 unknown 並禁止重送。測試控制點可暫停在 commit／ack 間，不假稱已繼續。
- [ ] 等待預設 24 小時且保留 Workspace claim，pending 到期關閉並停止，確認後 failed/input_timeout；只有證實平行工具靜止才屬純等待。
- [ ] 真 SQLite＋公開 MCP 驗同 scope 不同 principal 接手、跨 scope／Task 拒絕、first-valid、重送／衝突、多題 schema、reply／expiry／cancel 與首答案後原 expiry 到期；保存 AC-05／AC-09／AC-10 及受影響 gates。
- [ ] 以 barrier 讓兩個授權 principal、不同 operationId 同時提交相同與不同答案；核對唯一採用的答案／actor、各 receipt 回應及最多一次 worker 投遞，不以序列重送測試代替並發競爭。
- [ ] 使用可控 monotonic／wall clocks 驗 pending 純等待、首答案已 commit 待 ack 及 daemon 重啟：持久保存累計時間／階段與 expiry，純等待排除執行預算、答案 commit 恢復累計且不受舊 expiry 錯殺；wall-clock 跳動不重設執行預算，重啟不續跑或重送答案。
