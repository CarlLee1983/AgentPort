# 07: 打包腳本、文件改寫與 macOS 實機驗收

**What to build:** 主機管理者在 repo 執行 `pnpm service:install` 就完成 build、打包與安裝；README 只剩這套流程；在本機 Mac 實際走完整個生命週期。

**Blocked by:** 06

**Status:** done

- [x] package manifest 只發佈建置產物；`pnpm service:install` 依序 build → `pnpm deploy --legacy --prod` 到暫存目錄 → 以該目錄的 CLI 執行 `service install`（參數可轉傳，如 `--dry-run`）
- [x] 打包出的目錄單獨執行 `check-config` 成功（驗證建置產物完整，非只有 bin 檔）
- [x] 刪除手動 plist / unit 範本與 env 範例檔；README 部署章節改為 `pnpm service:install`、骨架填寫、token 取得、`agentport service status | restart | uninstall`，並標明 Linux 尚未實機驗收；`pnpm check` 通過
- [x] ADR-0011 的 Falsified if 改為引用服務定義渲染模組（原範本檔已刪）；v2 spec「部署與憑證」的手動流程描述改為指向 service-install
- [x] 本機 Mac 實機：`pnpm service:install` 第一次產生骨架並中止 → 填 agent 重跑成功並印出 token → `agentport service status` 顯示 running → 以該 token 從 MCP client 各派一輪 Claude 與 Codex 皆 `completed` → `agentport service restart` 成功 → `agentport service uninstall` 後 plist、安裝目錄、包裝指令消失而設定、env、SQLite 仍在
- [x] 驗收後依使用者意向保留或移除測試設定，並在票上記錄

## Acceptance

- 2026-09-21 macOS：首次執行建立骨架並以非零碼中止；填入兩個唯讀 agent 後重跑，服務在 `127.0.0.1:34567` running。以 bearer MCP client 對 Claude、Codex 各派一輪，兩者皆為 `completed`；restart 成功。uninstall 後 plist、安裝目錄與包裝指令均不存在，設定、env、SQLite 與 log 均仍在。
- 測試設定與 env 已移除；保留 acceptance SQLite 與 log，作為 uninstall 保留資料行為的實機證據。
