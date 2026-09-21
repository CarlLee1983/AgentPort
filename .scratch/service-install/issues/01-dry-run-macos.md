# 01: `service install --dry-run`（macOS）

**What to build:** 主機管理者執行 `agentport service install --dry-run`，看到將寫入的 LaunchAgent plist 全文與將執行的 launchctl 指令，任何檔案都沒被改動。建立 `service` 模組的單一入口與可注入依賴（平台、HOME、USER、uid、node 路徑、程式根目錄、環境變數、系統指令執行器、埠探測、token 產生器），作為本功能的主測試 seam。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 平台為 darwin、HOME 為暫存目錄、設定檔有效時，`install --dry-run` 印出的 plist 含 label `com.agentport.serve`、`ProgramArguments` 依序為 node 路徑、`--env-file=<設定檔目錄>/agentport.env`、安裝目錄的 CLI、`serve`、`--config <設定檔路徑>`，且暫存 HOME 下沒有任何新檔案
- [ ] node 路徑含空白（如 `/Users/x/Library/Application Support/node`）時渲染結果經 `plutil -lint` 驗證通過（測試中以 macOS 可用時才跑的方式驗證，或斷言 XML 字串逐項正確）
- [ ] 設定檔有一個結構錯誤與一個語意錯誤時，兩者都列出且結束碼非零，不印 plist
- [ ] 平台為 win32 時結束碼非零並印出「不支援的平台」
- [ ] 以真的建置產物跑一次 `agentport service install --dry-run --config <暫存設定檔>`（HOME 指向暫存目錄）結束碼為 0 且輸出含 `com.agentport.serve`
- [ ] `agentport service` 不帶子命令或未知子命令時印用法、結束碼 2（與既有 CLI 慣例一致）
