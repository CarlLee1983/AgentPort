# 04: 真 Claude 互動能力驗證

**What to build:** 在指定受控 Linux harness 中，真 Claude 能提出問題、接收有效答案並繼續同一工作，也能在執行或等待中停止；本票收斂 S1／G1，不開放產品派送。

**Blocked by:** 03 — 撤銷 generation 與拒絕延遲啟動.

**Status:** ready-for-agent

- [ ] 固定官方 Claude Agent SDK／binary，使用 query streaming input；SDK 與 CLI 僅在 execution worker 內，不使用已移除的 V2 session API，不從 partial output 推定取消能力。
- [ ] 管理者固定 cwd、settingSources、政策及 vendor 認證；原生 Session reference 由 Driver 產生，記錄空 settingSources 仍不代表所有 managed policy 隔離。
- [ ] 第一次真 Claude harness 執行前驗證敏感輸出邊界：只注入必要 vendor credential，stdout／stderr／argv／env 不直接寫日誌或回傳；以合成標記驗證輸出與證據檔不外洩秘密，保留核准 metadata。
- [ ] 刻意觸發真 AskUserQuestion，保留原生待決 callback／tool-use 關聯，給符合整組 schema 的答案，證明原工作繼續且產生結構化結果。
- [ ] canUseTool 依工具名稱分流問題與一般 permission request；普通工具依預设政策允許或拒絕，不能所有請求自動 allow，也不把 assistant 問號當問題。
- [ ] 進入純等待前證實沒有仍在執行的平行工具；限制並行或等待其靜止。固定 SDK 模式無法做到時 G1 不通過，不能刪除澄清需求。
- [ ] 驗證初始化、執行與等待中取消，正常完成後也核對 generation 封閉及 unit 空；不得留下孤兒 execution。
- [ ] 取得原生 Session reference 並驗證相容 binding 下的實際續接；僅成功結果已保存且資源停止的 reference 可作安全候選，不推定失敗或取消後仍可用。
- [ ] 記錄事件順序、工具關聯、回答採用、結果、停止證據及 SDK 控制行為，形成後續 Driver contract fixtures；建立 test:claude。只有真往返、可靠停止、固定版本及 G0／G1 全部通過才交付，缺憑證不能用 fake 代替。
