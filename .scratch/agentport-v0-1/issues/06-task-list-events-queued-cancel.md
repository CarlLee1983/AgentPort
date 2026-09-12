# 06: 任務列表、事件與排隊取消

**What to build:** Caller 能分頁追蹤自己的工作、讀取已提交事件，並取消尚未派送的 Task；重啟保留工作且佇列暫停，本票完成 S2／G2。

**Blocked by:** 05 — 持久提交與單項查詢.

**Status:** ready-for-agent

- [ ] 公開 list_tasks 依授權 scope 提供 agent／state 篩選與穩定分頁，預設摘要不含指令全文；get_events 使用 scope-global cursor／Task seq，短讀立即回事件與 nextCursor，不等待新事件。
- [ ] cursor 綁 scope／filter，跨 scope 或不匹配 cursor 明確拒絕；頁預設 50、最多 100、回應最多 8 MiB，不截斷單筆假裝完整。
- [ ] cancel_task 以 operationId 原子保存未啟動 queued／paused→canceled、receipt 及 event，暫停同 Context 已接受後項；重送不新增工作或重複副作用。
- [ ] 取消、get/list/events 均驗目前 membership／Agent 權限，保留實際 actor；通知或 Client 斷線不影響持久結果可查。
- [ ] 啟動唯一 daemon 鎖，dispatch 維持關閉，queued→paused 並保留 Task ID、queueOrder、receipt 與事件；重啟後仍能查詢、列出及取消。
- [ ] 取消與結案使用先前預留控制容量，不被一般 admission 限額阻擋；儲存無法提交時不回持久取消成功，回 unavailable 或可信 stale 快照。
- [ ] 官方 MCP Client＋真 SQLite 驗取消競爭、重試、重啟、scope/cursor/page 邊界與 notification-independent 查詢；更新 check／test:mcp 及 AC-02／AC-08／AC-10／AC-11 證據。
- [ ] G2 必須包含同鍵並發僅一 Task、回應遺失原 ID、重啟暫停與跨 scope 拒絕；此時仍無 Runtime 派送。
