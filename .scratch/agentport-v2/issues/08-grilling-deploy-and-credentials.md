# 部署方式與同使用者憑證模型

Type: grilling
Status: open
Blocked by: 01, 02
Map: ../map.md

## Question

服務在 Mac（launchd）與 Linux（systemd --user？）如何以「已登入 CLI 的那個使用者」身分常駐，Keychain / auth.json 是否可讀，遠端如何連入（直連 HTTP 或 SSH tunnel）。輸出一張 ADR：為何接受同使用者憑證模型並偏離 v1 ADR-0006/0007/0010。

票 05 定案後新增：同一次一併修訂 ADR-0002 第二段——v2 重啟後 queued Task 自動執行、running 一律 `failed{interrupted}`，不再暫停等 caller 確認。

票 06 定案後新增：caller token 只從 `callers[].token_env` 指定的環境變數讀，部署方式要決定 launchd plist / systemd unit 如何安全餵入這些變數（`EnvironmentFile=`、plist `EnvironmentVariables`、或 wrapper script 讀 `.env`），以及 `PATH` 不含 `~/.local/bin` 時是靠 `[runtimes.*].command` 還是補環境。
