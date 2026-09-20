# 設定檔 schema（TOML）

Type: grilling
Status: open
Blocked by: 01, 02
Map: ../map.md

## Question

定案 agents[] 的欄位：name、workspace、runtime、每個 runtime 的權限/沙箱選項、可選的附加 system prompt；callers[] 的 token→名稱對照；服務層設定（監聽位址、SQLite 路徑、long-poll 上限）。token 放設定檔還是環境變數？啟動時驗證規則。
