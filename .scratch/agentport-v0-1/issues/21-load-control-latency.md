# 21: 負載下的查詢與控制驗收

**What to build:** 在規格負載與失聯情境下，Caller 可及時查詢或得到明確不可用訊息，已接受工作仍可控制；本票整合容量、故障與安全證據，完成 S5／G5。

**Blocked by:** 18 — 容量耗盡與儲存故障收斂；19 — 崩潰窗口完整驗證；20 — 授權與執行政策對抗驗證.

**Status:** ready-for-agent

- [ ] 在已記錄硬體、OS、版本與可重現 fixture 中，至少涵蓋預設 4 execution、同 Workspace 互斥、不同 Workspace 並行及 queue 初始上限。
- [ ] 注入同步卡住 worker、IPC 無回應、巨量輸出／事件／JSON 序列化、慢 Client、輪詢壓力、DB 延遲及受控 checkpoint，驗查詢不排進 Runtime 或長寫入。
- [ ] 正常可用情境外側查詢以 2 秒內為目標，報樣本數、最大值、分位數與負載；不可只報平均或把 stale/unavailable 當正常成功。
- [ ] 另驗 Client 超過 5 秒連不上明示無法取得最新狀態，分辨失聯、死亡與疑似停滯；tool activity 證據不足回 unknown。
- [ ] 負載下 cancel 先回 stopping，generation／cgroup 未證實仍保 claim；容量滿保留 reply/cancel/ack，不能為達延遲目標假接受或省略停止。
- [ ] 確認 backpressure、訊息／HTTP／公開內容／分頁限額與 reserve，輸出不完整明示 output_limit，慢查詢或通知不阻塞 worker 事件保存。
- [ ] G5 收斂完整 fault matrix、保存與過期、授權、60 分鐘執行／24 小時等待及真 Linux 停止；資料遺失、重跑、越權或假停止尚存不得進 S6。
- [ ] 保存 AC-03／AC-04／AC-07／AC-09／AC-10／AC-11 的測量與限制，跑必要階段 gates，修正後只重跑受影響檢查並完成 reviewer delta。
