# 13: 修改尚未開始的 Task

**What to build:** Caller 能明確修改指定 queued／paused Task 的指令，與派送競爭時取得確定結果，不靠訊息先後猜測覆蓋。

**Blocked by:** 12 — Context 追加佇列與 Workspace 並行.

**Status:** ready-for-agent

- [ ] 公開 edit_task 接受 operationId、taskId、expectedRevision、instruction；只允許從未開始的 queued／paused Task，不可改 Agent／scope／Workspace／binding。
- [ ] 在核心短交易比對 revision、狀態與授權，更新指令、revision、event、receipt；edit 與 dispatcher CAS 只有一方成功，已開始返回穩定衝突及授權後快照。
- [ ] operationId 同初始請求回原 receipt，不同請求 conflict；修改不改原 submit fingerprint，重送最初 submit 仍回同 Task ID。
- [ ] 修改 paused Task 不解除 Context blocker 或改 queueOrder／predecessor；取消仍能單獨處理已接受工作。
- [ ] 沿用文字、body、admission 及控制 reserve 限額；普通操作容量不足可拒絕 edit，不妨礙既有 Task 取消／回答。
- [ ] 真 SQLite＋公開 MCP 驗 edit／dispatch、edit／cancel、同鍵重試、錯誤 revision、跨 scope 及權限撤銷；只觀察指令版本、狀態、事件與實際啟動輸入。
- [ ] 更新 AC-04／AC-10 證據、修改操作說明及 check／test:mcp；並行／持久交易的重要 Sol/high 審查問題解決後交付。
