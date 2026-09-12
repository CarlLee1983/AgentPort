# 17: 結果保存與過期查詢

**What to build:** Caller 在保存期內能查結果、問題及操作紀錄，過期時得到明確結果；舊 operationId 不會因清理變成新工作，未結案工作不被 TTL 刪除。

**Blocked by:** 13 — 修改尚未開始的 Task；16 — 明確恢復 Context 與 Session.

**Status:** ready-for-agent

- [ ] 前置票完成 G4 後，驗證／補齊終態結案後預設 30 天可調保存；未結案、paused、recovering、stopping／停止未知不套 TTL。
- [ ] 結果與完整 receipt 到期後保留 scope／operationId 去重所需最小 tombstone，不保留 prompt／答案全文；舊鍵回 result_expired，不重跑，不用 TTL 打開重複執行風險。
- [ ] Context 至少保留至相關非終態及可查詢 Task 結案／到期，不套一小時丟續接；原生 transcript 由管理者另管，清理 AgentPort 不刪 vendor 歷史。
- [ ] scope／filter 綁定的 event cursor 指向過期資料回 cursor_expired，要求重查快照；不能默默跨過已刪完成事件或提供跨 scope 資料。
- [ ] 保存及清理遵守規格公開內容 1 MiB、頁預設 50／上限 100、回應 8 MiB 與結案預留，不截斷單筆假裝完整；通知失敗不影響查詢。
- [ ] 一般 tombstone 初值 100,000，滿時拒絕 submit/edit/resume，既有 reply/cancel/ack 使用控制預留；2 GiB admission 預算不足先拒絕新工作，不提前淘汰保存期內結果。
- [ ] 真 SQLite＋可控時鐘＋MCP 驗保存期邊界、清理重啟、過期重試／cursor、未結案保留、Context 引用與 scope；核算 DB/WAL 而非只算 payload。
- [ ] 更新 AC-09／AC-11、保存／清理操作說明與受影響 check／test:mcp／test:faults；資料清理及不可重跑契約經 Sol/high 審查。
