# 04: `~/.local/bin/agentport` 包裝指令

**What to build:** 安裝後主機管理者在任何目錄打 `agentport ...` 都會以服務同一個 node 執行安裝目錄的 CLI；不會蓋掉使用者自己的同名檔案。

**Blocked by:** 02

**Status:** done

- [x] 安裝後 `~/.local/bin/agentport` 存在、可執行，內容含 AgentPort 標記行，並以固定的 node 路徑（含空白時正確加引號）執行安裝目錄的 CLI、轉傳所有參數；實際執行它帶 `check-config --config <暫存設定檔>` 得到結束碼 0
- [x] `~/.local/bin` 不存在時會被建立
- [x] 已存在同名檔案但不含標記：安裝中止、結束碼非零、該檔案內容不變、未送出 launchctl 指令
- [x] 已存在帶標記的舊包裝指令（舊 node 路徑）：被更新為新 node 路徑
- [x] `--dry-run` 輸出包含包裝指令全文，且不寫入
