# 10: MCP 到真 Claude 執行

**What to build:** 相容 MCP Caller 能選 Agent，交辦不需澄清的真 Claude 工作，查詢結果或取消；沿用已驗證的持久控制與停止流程，不另外建立 Runtime 狀態機。

**Blocked by:** 09 — 結果結案與未知結果確認.

**Status:** ready-for-agent

- [ ] 將 S1 已驗證 Claude Driver／worker 接入公開 submit/get/cancel 與既有 core／storage／supervisor；SDK 不在控制 daemon 事件迴圈執行，worker 不寫核心 DB。
- [ ] 在指定測試 Workspace 跑官方 MCP Client→Task→真 Claude→檔案修改／檢查或無修改分析→完整結果，Task ID、receipt 與結果跨連線保留。
- [ ] 只允許管理者 binding／政策／載入設定及必要 vendor credential，執行前重驗授權／目錄；instruction 結構化傳遞，不 shell 插值或允許遠端設定 executable。
- [ ] 啟用真 Claude 產品派送前，重驗 loopback 或可信 HTTPS／來源限制、Origin／Host、proxy trust 與偽造身分拒絕；以合成敏感標記驗證 worker stdout／stderr／argv／env、工具回應與日誌不外洩 vendor／AgentPort credential。這是本票啟用 gate，20 僅擴大對抗驗證。
- [ ] 驗初始化、running 及子工具取消；按既有 generation／cgroup 證據停止，正常完成與異常都不能只看 SDK 回應；daemon 失聯仍由 supervisor 收斂。
- [ ] 若遇尚未接入產品的互動需求，保留問題與產出並明確停止／失敗；不得假稱 awaiting_input 可回答，也不能以此取代後票必要正向澄清。
- [ ] 基礎快照提供 lifecycle／revision／reason、進展／存活觀察時間與結果；get 不呼叫模型或等待 worker，控制 API 保留處理容量。
- [ ] 執行 check、test:mcp、受影響 test:linux 與真 test:claude，保存 AC-01／AC-02／AC-06／AC-11 證據；本票不宣稱互動 ready，G3 待外側觀察票一起收斂。
