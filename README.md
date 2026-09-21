# AgentPort v2

AgentPort 將目標主機上的 AI Coding Runtime（Claude Code、Codex）以 Logical Agent 身份提供遠端工作執行能力。主機管理者在設定檔裡把 Agent 綁定到指定的 Workspace 與 Runtime，遠端 Caller 只能在授權範圍內派工，不能自行指定路徑或登記 Agent。

詳細詞彙定義見 `CONTEXT.md`，架構與決策見 `specs/agentport-v2.md`。

## 設定檔

尋找順序：`--config <path>` → `$AGENTPORT_CONFIG` → `${XDG_CONFIG_HOME:-$HOME/.config}/agentport/agentport.toml`。

```toml
[server]
listen = "127.0.0.1:3333"
long_poll_max_seconds = 30       # 上限 55
turn_timeout_seconds = 3600      # 單一 Turn 最長秒數，逾時視同取消（error.code = timeout）

[storage]
db_path = "~/.local/state/agentport/agentport.sqlite"
log_dir = "~/.local/state/agentport/logs"

[runtimes.claude]
command = "~/.local/bin/claude"  # 可選，預設從 PATH 找

[[agents]]
name = "stationhub"              # [a-z0-9-]+，唯一
description = "StationHub 後端"  # 可選
workspace = "~/Dev/CMG/StationHub"
runtime = "claude"               # claude | codex
policy = "workspace-write"       # 必填：read-only | workspace-write | full
extra_args = ["--model", "opus"]

[[callers]]
name = "grok"
token_env = "AGENTPORT_TOKEN_GROK"  # token 只從環境變數讀，不寫進設定檔
```

`~` 會展開為 `$HOME`，相對路徑相對於設定檔所在目錄。未知欄位視為錯誤。

## 驗證設定檔

```sh
agentport check-config [--config <path>]
```

設定有效時印出 agent 清單（name、runtime、policy、workspace）與 caller 數，exit code 0；設定有誤時把所有錯誤一次列到 stderr（每行 `path: message`），exit code 1。
