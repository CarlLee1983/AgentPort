# 12: Context 追加佇列與 Workspace 並行

**What to build:** Caller 在工作執行時可追加同 Context 的獨立 Task；同 Workspace 按資格與順序執行，不同 Workspace 可並行，前項失敗時保留後項供後續處置。

**Blocked by:** 11 — 進展、工具活動與停滯觀察.

**Status:** ready-for-agent

- [ ] submit 指定既有 Context 時建立新 Task，保留獨立 ID／receipt／狀態／結果，接在最後已接受 Task 後；澄清回答不走此路徑。
- [ ] Context 固定 Agent／scope／BindingSnapshot，拒絕換綁；成功 predecessor 的安全 Session reference 可供後項續接，claim 時標使用中，失敗或未知不可回退舊 reference。
- [ ] 同 Workspace 選最早 eligible Context 頭項，最多一 execution；不同 Workspace 在全域 4 未釋放資源內並行，不加優先權或搶占。
- [ ] paused Context 不阻擋其他 eligible Context；未停止 execution 或 recovery quarantine 擋住整個 Workspace，等待也占 claim，不能把 paused 當成已清理。
- [ ] predecessor failed／canceled／interrupted／未知時後項 paused，不丟棄；取消未啟動前項也阻擋後項，成功才自動派送。
- [ ] 每 Workspace 未啟動容量 32、全域 256，paused 計入；滿時拒絕新 admission，不淘汰已接受 Task，既有 get/reply/cancel 容量保留。
- [ ] 公開 MCP＋真 SQLite／可控 worker 驗跨 Context FIFO、並行、先後競爭、暫停及權限／binding 執行前改變；真 Claude 驗成功後項續接，不靜默開新 Session。
- [ ] 保存 AC-04／AC-08／AC-09 證據、更新 queue 操作說明與受影響 gates；人工 resume 與修改由後票提供，不用未實作工具假成功。
