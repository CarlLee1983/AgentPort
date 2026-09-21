# 設定檔 schema（TOML）

Type: grilling
Status: resolved
Blocked by: 01, 02
Map: ../map.md

## Question

定案 agents[] 的欄位：name、workspace、runtime、每個 runtime 的權限/沙箱選項、可選的附加 system prompt；callers[] 的 token→名稱對照；服務層設定（監聽位址、SQLite 路徑、long-poll 上限）。token 放設定檔還是環境變數？啟動時驗證規則。

## Answer

2026-09-21 grilling，十二題全數依建議定案。

### 尋找順序

`--config <path>` → `$AGENTPORT_CONFIG` → `~/.config/agentport/agentport.toml`（Mac 與 Linux 同路徑）。沒有 `schema_version`。stdio transport 由 `agentport stdio` 子命令啟動，不在設定檔。

### 完整範例

```toml
[server]
listen = "127.0.0.1:3333"        # 預設 loopback；遠端進入方式由票 08 決定
long_poll_max_seconds = 30       # 預設 30，上限 55

[storage]
db_path = "~/.local/state/agentport/agentport.sqlite"
log_dir = "~/.local/state/agentport/logs"     # 原始 JSONL，路徑記在 Task 上

[runtimes.claude]
command = "~/.local/bin/claude"  # 可選，預設從 PATH 找
[runtimes.codex]
command = "~/.local/bin/codex"

[[agents]]
name = "stationhub"              # [a-z0-9-]+，唯一
description = "StationHub 後端，Laravel"   # 可選，list_agents 回傳
workspace = "~/Dev/CMG/StationHub"
runtime = "claude"               # claude | codex
policy = "workspace-write"       # 必填：read-only | workspace-write | full
extra_args = ["--model", "opus"] # 可選，原樣附加到 CLI

[[callers]]
name = "grok"
token_env = "AGENTPORT_TOKEN_GROK"   # 值只從環境變數讀
```

### 決定

- Token 只走 `token_env`，不寫在檔案裡；環境由 launchd plist / systemd `Environment=` 餵（票 08）。
- 不做 `instructions` 欄位：工作目錄的 `CLAUDE.md` / `AGENTS.md` 是各 runtime 慣用機制，旗標走 `extra_args`。
- `extra_args` 只在 agent 層，沒有 runtime 層預設。
- 路徑一律展開 `~`；相對路徑相對於設定檔所在目錄。
- stdio 模式的 caller 固定記為 `local`；`callers[]` 可為空，但 HTTP 模式下為空拒絕啟動；`agents[]` 為空一律拒絕。

### 啟動驗證（全部檢查完一次列出所有錯誤）

agent `name` 唯一且合格式；`workspace` 存在且為目錄（不要求 git repo）；同一 workspace（realpath）只能綁一個 agent；`runtime` 為兩值之一；`policy` 為三值之一；caller `name` 唯一、`token_env` 指到的變數非空、token 值唯一；`long_poll_max_seconds ≤ 55`；runtime 可執行檔存在。

Driver 層事實：非 git 目錄下 `codex exec` 會 exit 1（票 02），Driver 一律帶 `--skip-git-repo-check`。
