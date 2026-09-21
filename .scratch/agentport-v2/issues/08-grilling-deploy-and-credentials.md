# 部署方式與同使用者憑證模型

Type: grilling
Status: resolved
Blocked by: 01, 02
Map: ../map.md

## Question

服務在 Mac（launchd）與 Linux（systemd --user？）如何以「已登入 CLI 的那個使用者」身分常駐，Keychain / auth.json 是否可讀，遠端如何連入（直連 HTTP 或 SSH tunnel）。輸出一張 ADR：為何接受同使用者憑證模型並偏離 v1 ADR-0006/0007/0010。

票 05 定案後新增：同一次一併修訂 ADR-0002 第二段——v2 重啟後 queued Task 自動執行、running 一律 `failed{interrupted}`，不再暫停等 caller 確認。

票 06 定案後新增：caller token 只從 `callers[].token_env` 指定的環境變數讀，部署方式要決定 launchd plist / systemd unit 如何安全餵入這些變數（`EnvironmentFile=`、plist `EnvironmentVariables`、或 wrapper script 讀 `.env`），以及 `PATH` 不含 `~/.local/bin` 時是靠 `[runtimes.*].command` 還是補環境。

## Answer

以建置票 12 的實作定案，ADR 為 `docs/adr/0011-same-user-subscription-credentials.md`（同時修訂 ADR-0002 第二段）。Mac 用 LaunchAgent（`gui/<uid>`，重開機需登入）、Linux 用 `systemd --user`（`enable-linger`）；token 放 `~/.config/agentport/agentport.env`（0600），Mac 以 `node --env-file`、Linux 以 `EnvironmentFile=` 餵入；PATH 補 `~/.local/bin`，其他位置用 `[runtimes.*].command` 絕對路徑；遠端預設 SSH tunnel 到 loopback。2026-09-21 在本機 Mac 以 LaunchAgent 實測：launchd 下 Claude 讀得到 login Keychain、Codex 讀得到 `~/.codex/auth.json`，兩個 runtime 各一輪派工皆 `completed`（見建置票 12「實機驗收」）。
