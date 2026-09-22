# AgentPort

[English](README.md) | 繁體中文 | [日本語](README.ja.md)

![AgentPort 信使帶著任務穿越 gateway，前往已授權的 workspace](site/assets/agentport-cover.png)

AgentPort 將目標主機上的 AI Coding Runtime（Claude Code、Codex）以 Logical Agent 身份提供遠端工作執行能力。主機管理者在設定檔裡把 Agent 綁定到指定的 Workspace 與 Runtime，遠端 Caller 只能在授權範圍內派工，不能自行指定路徑或登記 Agent。

![AgentPort 信使將任務封包交付給已授權的 workspace](site/assets/agentport-dispatch.png)

詳細詞彙定義見 `CONTEXT.md`，架構與決策見 `specs/agentport-v2.md`。

## 安裝與部署

需要 Node.js（版本見 `package.json` 的 `engines.node`）與已經在本機登入過的 `claude` / `codex` CLI。在 repo 根目錄執行：

```sh
pnpm install
pnpm service:install
```

這個指令會 build、把僅含正式依賴與建置產物的程式打包到暫存目錄，再由那份程式安裝服務；常駐服務不會執行 repo 內的檔案。首次執行會在 `${XDG_CONFIG_HOME:-$HOME/.config}/agentport/agentport.toml` 產生骨架並停止。填入至少一個 agent 後重跑同一個指令。

骨架中的設定檔尋找順序是 `--config <path>` → `$AGENTPORT_CONFIG` → `${XDG_CONFIG_HOME:-$HOME/.config}/agentport/agentport.toml`。可用非預設位置：

```sh
pnpm service:install -- --config /path/to/agentport.toml
```

骨架保留一個 `default` caller；填入 agent 時可依下列範例修改：

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

`service install` 會建立相鄰的 `agentport.env`（mode 0600），補齊每個 caller 缺少的 token，並且只在當下印出新 token 一次。把該值安全地交給 MCP client；不要把 token 寫進 TOML 或 log。若設定檔已存在，安裝不會改寫它或既有 token。

安裝成功後，`~/.local/bin/agentport` 會指向安裝目錄的固定版本；日常操作不需要回到 repo：

```sh
agentport check-config
agentport service status
agentport service restart
agentport service uninstall
```

`restart` 適用於修改 TOML 或 env 後。`uninstall` 只移除服務定義、安裝目錄與 AgentPort 建立的包裝指令；設定、env、SQLite 與 log 會保留。`--dry-run` 可先檢視服務定義與系統指令：`pnpm service:install -- --dry-run`。

macOS 以登入使用者的 LaunchAgent 執行，因此重開機後要等該使用者登入且 Keychain 解鎖。Linux 採 systemd user unit；**Linux 路徑尚未經實機驗收**，未登入時要在自行確認影響後執行 `loginctl enable-linger $USER`。

## 遠端連入

預設不要把 `listen` 改成非 loopback；遠端機器用 SSH port forward 連本機的 loopback：

```sh
ssh -N -L 3333:127.0.0.1:3333 <host>
```

之後遠端的 MCP client 指向 `http://127.0.0.1:3333/` 就等於直接打主機上的 loopback。只有明確需要跳過 SSH 直連 HTTP 時才改 `[server] listen`，這種情況下 `[server] allowed_hosts` 必填（啟動時驗證），沒填會被 `check-config` / `serve` 擋下來。

## 排程式 backlog trigger

AgentPort 本身不排程工作。可選的外部 trigger 能由 launchd、cron 或 systemd timer 啟動，透過已驗證的 MCP endpoint 提交一個 read-only backlog-triage Task。MCP 只用來提交 Task，不能新增、列出、暫停或刪除 schedule。URL、token 與 Agent 名稱應放在 trigger 自己的 mode `0600` 環境檔，不必每次寫在指令上。它不會重試或去重，因此外部排程器必須確保每次 run 只觸發一次。腳本、環境與排程範例見 [`docs/operations/backlog-trigger.md`](docs/operations/backlog-trigger.md)。

## MCP client 設定範例

AgentPort 的 HTTP server 是 stateless streamable HTTP；handler 掛在整個監聽位址上、不看路徑，下面範例統一用根路徑 `http://127.0.0.1:3333/`。

**Claude Code**（透過上面的 SSH tunnel）：

```sh
claude mcp add --transport http agentport http://127.0.0.1:3333/ \
  --header "Authorization: Bearer ${AGENTPORT_TOKEN}"
```

這裡的 `${AGENTPORT_TOKEN}` 是在執行 `claude mcp add` 這一刻由呼叫端的 shell 展開，不是 Claude Code 自己在連線時讀環境變數——展開後的明文 token 會直接寫進 `~/.claude.json`（或專案的 `.mcp.json`，視 `-s` scope 而定）。實測過 Claude Code 2.1.278：header 值不支援 `${VAR}` 這種語法的執行期展開，寫 `\${AGENTPORT_TOKEN}`（跳脫掉 shell 展開）只會把字面上的 `${AGENTPORT_TOKEN}` 當成 header 值送出去，連不上。目前沒有能避開明文落地的寫法，只能接受 token 存在該設定檔裡（比照它保存其他 MCP server 認證的方式），並確保這個檔案的存取權限跟其他機密設定一樣受限。

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.agentport]
url = "http://127.0.0.1:3333/"
bearer_token_env_var = "AGENTPORT_TOKEN"
tool_timeout_sec = 120
```

`AGENTPORT_TOKEN` 要在呼叫端自己的環境先設好（Codex 用 `bearer_token_env_var` 在連線時讀，不會把值寫進 `config.toml`），對應主機上 `agentport.toml` 裡某個 caller 的 `token_env` 所指的值。Long-poll 的上限是 `[server] long_poll_max_seconds`（≤ 55 秒）。Codex 每個 MCP server 可設 `tool_timeout_sec`（存在於 codex-cli 0.155.0 的設定 schema，實測 `strings` 出來的 binary 常數確認過這個欄位名）覆蓋預設 tool timeout；官方文件寫 60 秒，但沒有再進一步核對這份文件對應的版本是否與本機 0.155.0 一致，也沒有找到 0.155.0 實際生效的預設數字，所以不假設某個具體預設值——直接在設定裡明寫一個高於 `long_poll_max_seconds` 的數字（例如上面的 120 秒），不依賴預設。

**本機 stdio**：不經網路，直接在本機跑。`serve` 常駐時如果要另外開一個 `stdio`，兩者不能共用同一個 `db_path`（single-instance 鎖，見 spec「Task 狀態模型」一節），所以 stdio 用另一份設定檔，只改 `[storage]` 的 `db_path`（通常也順便改 `log_dir`，避免兩邊 log 混在一起），其餘欄位（agents、callers、server）照抄：

```sh
cp ~/.config/agentport/agentport.toml ~/.config/agentport/agentport.stdio.toml
# 編輯 agentport.stdio.toml，把 [storage] db_path（與 log_dir）改成 serve 以外的路徑，例如：
#   db_path = "~/.local/state/agentport/agentport-stdio.sqlite"
#   log_dir = "~/.local/state/agentport/logs-stdio"

agentport stdio --config ~/.config/agentport/agentport.stdio.toml
```

沿用同一個 `db_path` 啟動 stdio 會拿到 `SQLITE_BUSY`，以非零碼退出並印出「另一個 agentport 程序正在使用 &lt;db_path&gt;」。

## 驗證部署

- `agentport check-config` 印出預期的 agent 清單、exit code 0
- LaunchAgent / systemd unit 顯示為 running（`launchctl print gui/$(id -u)/com.agentport.serve` 或 `systemctl --user status agentport`）
- 從 client 呼叫 `list_agents`，回傳的清單跟 `check-config` 一致
- 提交一個 Claude task 跑到 `completed`
- 提交一個 Codex task 跑到 `completed`

## MCP tools

所有 tool 都回 `structuredContent` 與同內容的 `content[0].text`（JSON）。tool 層錯誤回 `isError: true` 加 `{ "error": { "code", "message" } }`，碼為 `not_found`、`invalid_state`、`unknown_agent`。

| tool          | 輸入                                               | 回傳                                                                                          |
| ------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `list_agents` | —                                                  | `{ agents: [{ name, description?, runtime, policy }] }`                                       |
| `submit_task` | `{ agent, prompt }`                                | `{ task_id, context_id, state: "queued" }`，同時建立新 Context                                |
| `follow_up`   | `{ context_id, prompt }`                           | 同上；沿用該 Context 的 Agent 與 Runtime Session                                              |
| `get_task`    | `{ task_id, wait_seconds? }`                       | Task 完整記錄；`wait_seconds` > 0 時等到狀態改變或 `min(wait_seconds, long_poll_max_seconds)` |
| `cancel_task` | `{ task_id }`                                      | `{ task_id, state }`；對已結束的 Task 回 `invalid_state`                                      |
| `list_tasks`  | `{ agent?, context_id?, state?, limit?, cursor? }` | `{ tasks: [摘要], next_cursor }`，新到舊，`limit` 預設 50、上限 100                           |

Task 狀態：`queued → running → completed | failed | cancelled`。Task 記錄含 `final_text`、`diff_stat`（Turn 期間的 `git diff --stat` 與未追蹤檔）、`commits`、`usage`、`hints`（`permission_denied`、`git`、`truncated`）、`error`、`raw_log_path`（CLI 原始輸出）。`error.code` 可能為 `runtime_failed`、`session_unresumable`、`interrupted`（服務重啟時正在執行）、`cancelled`、`timeout`。

典型流程：`submit_task` → 反覆 `get_task`（帶 `wait_seconds`）直到結束 → Runtime 的最終回覆若是提問，用 `follow_up` 回答。服務重啟後 `task_id` 仍查得到；排隊中的 Task 自動繼續，執行中的標為 `interrupted`，可在同一 Context `follow_up` 續派。

## 已知限制

- **Codex 取消後的 follow-up 不穩定**：取消執行中的 Codex Task 後，同一 Context 的 `follow_up` 實測可能完成但不記得取消前的內容，或回 `session_unresumable`。Claude 取消後可正常續接。
- **`read-only` 對 Claude 對應 `plan` 模式**：Claude 不會嘗試寫檔，因此不會出現 `hints.permission_denied`，並會在 `~/.claude/plans/` 留檔。
- **`workspace-write` 對 Claude 對應 `acceptEdits`**：檔案編輯自動允許，但部分 Bash 指令仍會被拒（記在 `hints.permission_denied`）。
- **policy 不是隔離邊界**：服務以管理者本人身分執行，Runtime 可存取該使用者可及的一切（見 `docs/adr/0009-*`、`docs/adr/0011-*`）。
- **每個 `db_path` 只能有一個服務程序**：見上方「本機 stdio」。

## 開發

```sh
pnpm install
pnpm check      # format:check → lint → typecheck → build → test，驗證一律跑這個
```

`pnpm test` 會先並行跑不會碰 package 依賴樹的測試，再獨立跑 production package 驗收。後者會以 `pnpm deploy --prod` 暫時重建 repo 的 `node_modules` 連結；不能與其他會從該依賴樹載入模組的測試並行。`pnpm service:install` 本身會先用 frozen lockfile 補齊建置依賴，因此前一次 production deploy 留下 production-only 依賴樹後，重跑安裝仍可 build。

真 CLI 測試預設跳過，需本機已登入 `claude` / `codex`，並會消耗訂閱額度：

```sh
AGENTPORT_REAL_CLI=1 pnpm vitest run tests/driver/claude/real-cli.test.ts \
  tests/driver/codex/real-cli.test.ts tests/mcp/follow-up-real-cli.test.ts tests/mcp/cancel-real-cli.test.ts
```

## 文件

- `CONTEXT.md`：領域詞彙
- `specs/agentport-v2.md`：規格與各建置票的實作定案
- `docs/adr/`：架構決策（0001 / 0002 / 0003 / 0005 / 0009 繼承自 v1，0011 為 v2 憑證模型）
- `.scratch/agentport-v2/map.md`：決策地圖與尚未處理的議題；`.scratch/agentport-v2-build/`：建置工單
