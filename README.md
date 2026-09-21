# AgentPort v2

AgentPort 將目標主機上的 AI Coding Runtime（Claude Code、Codex）以 Logical Agent 身份提供遠端工作執行能力。主機管理者在設定檔裡把 Agent 綁定到指定的 Workspace 與 Runtime，遠端 Caller 只能在授權範圍內派工，不能自行指定路徑或登記 Agent。

詳細詞彙定義見 `CONTEXT.md`，架構與決策見 `specs/agentport-v2.md`。

## 安裝

需要 Node.js（版本見 `package.json` 的 `engines.node`）與已經在本機登入過的 `claude` / `codex` CLI。

```sh
pnpm install
pnpm build
```

`pnpm build` 產出 `dist/cli.js`，部署範本（見「啟動」一節）都指向這個檔案的絕對路徑，不是 `pnpm` 指令本身。

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

## 設定：caller token

延續上面「設定檔」一節：`callers[].token_env` 只是變數名稱，實際值要另外從環境變數餵進來，`agentport.toml` 本身不放 token。用一份獨立的 env 檔（`KEY=VALUE`，一行一個 `token_env`）：

```sh
install -d -m 700 ~/.config/agentport
install -m 600 deploy/agentport.env.example ~/.config/agentport/agentport.env
# 編輯 ~/.config/agentport/agentport.env，把 change-me 換成真實 token
```

兩個平台餵法不同，但都指向同一份 `~/.config/agentport/agentport.env`：macOS 的 LaunchAgent 沒有原生的 env-file 機制，所以 plist 用 Node 24+ 內建的 [`--env-file`](https://nodejs.org/api/cli.html#--env-fileconfig)（支援 `#` 註解與加引號的值；指到的檔案不存在時 Node 會直接失敗結束，不是靜默略過）；Linux 的 systemd unit 用原生的 `EnvironmentFile=`（見下方 unit 範本），不假手 Node。

## 啟動

部署範本在 `deploy/`，兩邊都是佔位符範本，不能直接放進服務管理器的目錄，要先把 `__NODE__`、`__AGENTPORT_DIR__`、`__HOME__`、`__USER__` 換成實際值再 render 出去。

### macOS（LaunchAgent）

```sh
NODE=$(command -v node)
AGENTPORT_DIR=/path/to/AgentPortV2   # 這個 repo 的絕對路徑
sed -e "s#__NODE__#$NODE#g" \
    -e "s#__AGENTPORT_DIR__#$AGENTPORT_DIR#g" \
    -e "s#__HOME__#$HOME#g" \
    -e "s#__USER__#$USER#g" \
    deploy/macos/com.agentport.serve.plist > ~/Library/LaunchAgents/com.agentport.serve.plist

mkdir -p ~/Library/Logs/agentport
plutil -lint ~/Library/LaunchAgents/com.agentport.serve.plist   # 確認 render 沒壞

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentport.serve.plist
launchctl kickstart -k gui/$(id -u)/com.agentport.serve
```

停止：`launchctl bootout gui/$(id -u)/com.agentport.serve`。log 在 `~/Library/Logs/agentport/serve.out.log` 與 `serve.err.log`。改了 `agentport.toml` 或 `agentport.env` 之後用 `launchctl kickstart -k` 重啟生效。

Claude Code 的 login Keychain 查詢依賴 `USER` 環境變數（見 `.scratch/agentport-v2/issues/01-research-claude-headless.md`），plist 的 `EnvironmentVariables` 已經帶了 `HOME`/`USER`/`PATH`，不要從 `EnvironmentVariables` 拿掉。

`gui/<uid>` 的 LaunchAgent 掛在使用者的 GUI session 下：重開機後要等這個使用者登入（不必開啟任何 App，登入畫面過去即可）才會啟動，Keychain 本身也要登入解鎖後才能被查詢。要無人值守重開機也自動起服務，得在「系統設定 → 使用者與群組」開這個帳號的自動登入。

### Linux（systemd --user）

```sh
NODE=$(command -v node)
AGENTPORT_DIR=/path/to/AgentPortV2
mkdir -p ~/.config/systemd/user
sed -e "s#__NODE__#$NODE#g" \
    -e "s#__AGENTPORT_DIR__#$AGENTPORT_DIR#g" \
    deploy/linux/agentport.service > ~/.config/systemd/user/agentport.service

systemctl --user daemon-reload
systemctl --user enable --now agentport
```

沒有登入 session 時要開機自動起（不是登入後才起），另外跑一次 `loginctl enable-linger $USER`。停止：`systemctl --user stop agentport`。log：`journalctl --user -u agentport`。Codex 的 ChatGPT 登入憑證在 Linux 是純檔案 `~/.codex/auth.json`（見 `.scratch/agentport-v2/issues/02-research-codex-exec.md`），Claude 訂閱憑證則是 `~/.claude/.credentials.json`，兩者都跟著 `HOME` 找，不需要額外設定。改了 `agentport.toml` 或 `agentport.env` 之後 `systemctl --user restart agentport`。

Unit 用 `Restart=always`（不是 `on-failure`），跟 macOS 範本的 `KeepAlive=true`（任何結束都重啟，包含乾淨的 0 結束）一致，兩邊行為對齊，不用分別記兩種重啟語意。

`PATH` 只補了 `~/.local/bin` 與常見系統路徑；如果 `claude` / `codex` 是用 nvm 或其他版本管理工具裝的、不在這幾條路徑下，不要在這裡加更多 PATH 猜測，改用設定檔 `[runtimes.claude]` / `[runtimes.codex]` 的 `command` 指定絕對路徑（`command -v claude` 查出來的那條），這樣不管 `PATH` 有沒有找到都能啟動。

## 遠端連入

預設不要把 `listen` 改成非 loopback；遠端機器用 SSH port forward 連本機的 loopback：

```sh
ssh -N -L 3333:127.0.0.1:3333 <host>
```

之後遠端的 MCP client 指向 `http://127.0.0.1:3333/` 就等於直接打主機上的 loopback。只有明確需要跳過 SSH 直連 HTTP 時才改 `[server] listen`，這種情況下 `[server] allowed_hosts` 必填（啟動時驗證），沒填會被 `check-config` / `serve` 擋下來。

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
