# 02: macOS 實際安裝與更新

**What to build:** 主機管理者執行 `agentport service install`（設定檔與 env 檔已存在），程式被放到固定安裝目錄、LaunchAgent 被寫入並載入，指令在服務開始監聽後回報成功；重跑即更新且結果冪等。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 第一次安裝：安裝目錄 `<XDG_DATA_HOME 或 ~/.local/share>/agentport/app` 內容等於目前程式根目錄，plist 寫入 `~/Library/LaunchAgents/com.agentport.serve.plist`，log 目錄已建立，送出的指令序列為 `launchctl bootstrap gui/<uid> <plist>`，埠探測成功後印出監聽位址、結束碼 0
- [ ] 已載入時重跑：指令序列為 `bootout` → 換目錄 → `bootstrap`；過程中曾存在 `app.new`，完成後只剩 `app`，且舊 `app` 內容已被取代
- [ ] 複製到 `app.new` 途中失敗（注入失敗）時，原本的 `app` 與已載入的服務不受影響，結束碼非零
- [ ] 埠探測 10 秒內未成功（注入的探測一律失敗、以可控時鐘或縮短逾時測試）時，輸出含 err log 的最後數行，結束碼非零，且未送出 `bootout`（不自動回滾）
- [ ] 連續兩次成功安裝後，暫存 HOME 內的檔案集合與內容與只安裝一次相同
