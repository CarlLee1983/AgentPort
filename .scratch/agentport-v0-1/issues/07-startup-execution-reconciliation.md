# 07: 啟動時核對舊 execution

**What to build:** 服務啟動時能查到舊 execution 的 recovering 或 quarantine 狀態，先撤銷並核對殘留資源，避免重啟後誤派送；用持久故障 fixture 驗證，尚不開啟 launch。

**Blocked by:** 06 — 任務列表、事件與排隊取消.

**Status:** ready-for-agent

- [ ] 持久 Execution 與 canonical Workspace 唯一 claim 保存 taskId／executionId／daemon epoch／可信 unit ID／prior state；claim 不因時間過期自動釋放。
- [ ] 使用合成但經真儲存提交的 active execution／claim 啟動 daemon，外側 get/events 可觀察 recovering、最後已知快照與核對狀態，不依賴模型或 worker 回應。
- [ ] 啟動取得唯一 daemon 鎖、暫停 dispatch，queued→paused，既有 active→recovering；核對原 supervisor generation，要求撤銷再停止，不重放 Runtime 指令。
- [ ] 可信 unit 無法辨識、generation 尚未封閉或停止證據不足時 quarantine 整個 Workspace，保留 claim／unknown 與 degraded，不以 PID 不存在或 unit 暫空放行。
- [ ] 涵蓋 claim 已 commit 但不知 launch 是否送出的 crash window；不能假定尚未執行。觀察與停止只針對原 execution，不建立新 generation。
- [ ] 此票 launch 路徑仍不可用，不發布 completed／failed 的猜測結果；對完整 outcome 的終態還原與人工 interrupted 結案由後票補上，不影響保守恢復安全。
- [ ] 以真 SQLite、已驗證 supervisor／可控故障 fixture 驗 daemon 重啟及 recovery 再 crash；保存持久狀態、撤銷／停止證據及 AC-07／AC-08 紀錄。
- [ ] 更新啟動／觀察操作說明，執行受影響 check、test:mcp、test:linux／fault cases；持久資料與恢復控制由 Sol/high 分析及獨立審查。
