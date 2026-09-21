# 05: `status` / `restart` / `uninstall`（macOS）

**What to build:** 主機管理者用 `agentport service status` 看健康狀態、`restart` 套用設定變更、`uninstall` 把系統還原到安裝前但保留資料。

**Blocked by:** 02, 04

**Status:** ready-for-agent

- [ ] 已安裝且在跑：`status` 顯示 running、pid、監聽位址可連、安裝目錄、node 路徑，結束碼 0（launchctl print 輸出以錄下的真實樣本回放）
- [ ] 記錄的 node 路徑已不存在：`status` 提示「node 路徑已失效，請重跑 install」且結束碼非零
- [ ] `status` 附上 err log 最後數行（檔案不存在時不報錯）
- [ ] `restart`：設定檔有效時送出 `launchctl kickstart -k gui/<uid>/com.agentport.serve` 並等待埠；設定檔無效時列出錯誤、結束碼非零、未送出任何 launchctl 指令
- [ ] `uninstall`：送出 `bootout`、刪除 plist、安裝目錄與帶標記的包裝指令；設定檔、env 檔、SQLite 檔與 log 目錄仍在，結束碼 0
- [ ] 包裝指令不含標記時 `uninstall` 不刪它並提示
- [ ] 未安裝時 `status` 與 `uninstall` 都印「未安裝」、結束碼 0；`restart` 印「未安裝」、結束碼非零
