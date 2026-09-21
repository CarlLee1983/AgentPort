# 12: 部署包與 ADR【依地圖票 08，未結案時用 spec 假設】

**What to build:** 管理者照 README 在 Mac（LaunchAgent）或 Linux（systemd --user）把服務以自己的使用者身分常駐，token 從 env file 餵入，服務重開機自動起來且能讀到 Keychain / auth.json；ADR 說明為何接受同使用者憑證模型。

**Blocked by:** 09, 11

**Status:** ready-for-agent

- [x] LaunchAgent plist 與 systemd user unit 範本，含 `HOME` / `USER` / `PATH` 與 `token_env` 變數餵入方式（env file，mode 0600）
- [x] README：安裝、設定、啟動、遠端連入（預設 SSH tunnel 到 loopback）、Claude Code / Codex 的 MCP client 設定範例
- [ ] 在本機 Mac 以 LaunchAgent 實際啟動並跑通一輪 Claude 與 Codex 派工（沿票 01 / 02 research 的 launchd 實驗）
- [x] `docs/adr/`：同使用者憑證 ADR（偏離 v1 ADR-0006 / 0007 / 0010、記錄政策灰區與 API key 逃生口）並修訂 ADR-0002 第二段；附 `**Falsified if:**`
- [x] v1 保留的 ADR 0001 / 0003 / 0005 / 0009 複製到 v2 `docs/adr/` 並註明來源

## 自票 11 移交

ADR-0002 第二段的修訂需寫明 v2 實際行為（建置票 11 已實作）：重啟時 running 一律 `failed{interrupted}`、不回填 partial；queued 依原順序自動續跑，不再暫停等 caller 確認；理由為 queued 無副作用、單操作者。另記每個 `db_path` 單實例鎖（重啟掃描的前提：不會有另一個存活程序持有同一批 running Task）。

## 狀態註記（2026-09-21）

除「在本機 Mac 以 LaunchAgent 實際啟動並跑通一輪 Claude 與 Codex 派工」外皆已完成；該條由使用者依 README「驗證部署」自行執行，勾選後本票改 `done`。實作時定案寫回 `specs/agentport-v2.md`「部署與憑證」。
