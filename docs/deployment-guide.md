# AgentPort v0.1：部署與下游專案 MCP 使用

這份手冊對應目前 repository 的 production daemon。它描述的是「Hub
Station 管理多個下游專案，MCP Caller 以 `agentId` 明確選擇專案」的部署
方式。

目前交付形式是 source checkout；repository 尚未發布 archive、installer、
GitHub release 或 attestation。部署前請先以同一個 commit 執行 `make verify`，
再把相同 source candidate 安裝到 Linux 主機。這一版只支援專用 Ubuntu
24.04 amd64、systemd、cgroup v2、同機連線或管理者控制的 SSH tunnel。
MCP listener 固定只綁 `127.0.0.1`；不要直接暴露到公網，也不要把目前的
預配置 Bearer token 誤稱為 OAuth。

## 先確認這一版能做什麼

Hub Station 管理三種資料：

| 資料      | 意義                                                                       |
| --------- | -------------------------------------------------------------------------- |
| Agent     | 一個下游專案的穩定 `agentId`、管理者指定 Workspace、Runtime profile 與政策 |
| Principal | 權限集合，列出它允許使用的 Agent IDs                                       |
| Caller    | MCP Bearer token，綁定一個 Principal；原 token 只在建立時輸出一次          |

MCP request 只能傳 `agentId`、instruction 和 Task 欄位。Caller 不能傳
`workspacePath`、`launchProfileId`、Runtime executable、credential 或
Execution reference。AgentPort 會在受保護的 registry 中把 `agentId` 綁到
Workspace，再由既有 Task／Context／Execution 邊界處理後續操作。

這個 candidate 仍把 production Runtime readiness 保持為 `unverified`，所以
production `agentport_submit_task` 會回 `execution_not_ready`，且不建立 Task
或 Workspace claim。這是 AP-020 R11 的 fail-closed 行為；ForgePilot
`GATE-058` 正在等待「維持 admission-only」或「批准 Runtime readiness
verification」的決定。完成該 Gate 與後續 Runtime readiness Story 前，不要把
本版宣稱為可執行 production coding service。

## 1. 建立候選版本

在開發機或指定 Linux build host：

```sh
git clone <private-repository-url> AgentPort
cd AgentPort
git checkout <approved-commit>
corepack enable
pnpm install --frozen-lockfile
make verify
pnpm run build
```

使用 Node `24.21.0` 與 pnpm `12.4.1`。`make verify` 通過的 commit 就是要
部署的 candidate；不要在主機上另外修改 `dist/` 或 lockfile。將整個 checkout
放到 root 管理的版本目錄，例如：

```text
/opt/agentport/releases/<approved-commit>/
/opt/agentport/current -> /opt/agentport/releases/<approved-commit>
```

`current` 只由 root 更新，daemon 只能讀取。切換版本前先停止或依維運程序
排空 daemon；切換後以同一個 candidate 重新跑主機 preflight。

## 2. Linux 主機前置條件

Production execution 需要 AP-021 的 root launcher 已經由主機管理者安裝、
啟動並驗證。AgentPort repository 目前只提供 daemon unit；它不會替你建立
root launcher、cgroup、帳號、群組、Runtime home 或 Claude subscription
login。

主機至少要有下列隔離身份與用途：

| 身份／群組           | 用途                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `agentport-daemon`   | 非 root 控制 daemon，只讀 protected config、寫 daemon SQLite         |
| `agentport-launcher` | launcher Unix socket 群組；只允許 daemon 加入                        |
| `agentport-ingress`  | launcher-owned ingress 目錄的受控 traversing                         |
| `agentport-runtime`  | Runtime worker 身份；不得讀 SQLite、launcher socket 或其他 Workspace |
| `agentport-admin`    | 本機 read-only readiness socket 的管理者群組                         |

必須由 root 預先準備並核對：

```text
/etc/agentport/agentport.json                  root:agentport-daemon 0640
/etc/agentport/credentials/                    root-only 0700
/var/lib/agentport/daemon/                     daemon writable
/var/lib/agentport/runtime-home/               runtime 0700
/run/agentport/                                root-owned protected parent
/run/agentport-ingress/                        launcher-owned, daemon cannot repair
/var/agentport/workspaces/<project>/            runtime-owned approved directory
/run/agentport/launcher.sock                   root-owned, launcher group, 0660
```

不要把 SQLite、credential 或 launcher config 放在任何 Workspace。daemon
不會替你 `chown`／`chmod` ingress 或 Workspace。

## 3. 安裝 daemon unit 與固定 credential

把 unit 安裝到 systemd 後檢查它仍指向要部署的版本：

```sh
sudo install -o root -g root -m 0644 \
  config/systemd/agentport-daemon.service \
  /etc/systemd/system/agentport-daemon.service
sudo systemctl daemon-reload
```

建立兩個 root-only systemd credentials。`cursorSecret` 至少 16 個字元；
`continuationEncryptionKey` 必須是 32 bytes 的 base64url（通常 43 字元）。
值不要出現在 shell history、argv、環境檔、設定檔、SQLite 或 log：

```sh
sudo install -d -o root -g root -m 0700 /etc/agentport/credentials
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | \
  sudo tee /etc/agentport/credentials/continuationEncryptionKey >/dev/null
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | \
  sudo tee /etc/agentport/credentials/cursorSecret >/dev/null
sudo chmod 0600 /etc/agentport/credentials/*
```

保留 credential 值跨 restart 不變；輪換會讓既有 cursor 或 continuation
資料失效。啟動 daemon 前，先確認 unit 中的 `LoadCredential` 路徑正確。

## 4. 建立第一份 protected configuration

先把範例複製到唯一受保護路徑，再由管理 CLI 原子更新。設定中的
`workspaceRoot` 是所有 Agent Workspace 的單一核准根目錄，預設為
`/var/agentport/workspaces`；`registryRevision` 會由管理 CLI 每次成功更新時
單調遞增，daemon reload 會拒絕舊候選：

```sh
sudo install -d -o root -g agentport-daemon -m 0750 /etc/agentport
sudo install -o root -g agentport-daemon -m 0640 \
  config/agentport.example.json /etc/agentport/agentport.json
```

所有管理命令都必須指定絕對路徑，而且檔名必須是 `agentport.json`。以下假設
source candidate 在 `/opt/agentport/current`：

```sh
AP=/opt/agentport/current/dist/src/operations/agentport-main.js
CFG=/etc/agentport/agentport.json
```

### 4.1 逐個登錄下游專案

Workspace 先由管理者建立並交給 Runtime 身份；`agent add` 只驗證既有目錄，
不會遞迴更改 ownership 或 mode。Workspace 必須是 `workspaceRoot` 的直接或
更深層非 symlink 子目錄，root 與 Workspace 的 owner/group 必須一致，且不能
有 group/other write。每個 Agent 必須是非重疊的目錄：

```sh
sudo install -d -o agentport-runtime -g agentport-runtime -m 0750 \
  /var/agentport/workspaces
sudo install -d -o agentport-runtime -g agentport-runtime -m 0750 \
  /var/agentport/workspaces/hub-station

sudo node "$AP" agent add --config "$CFG" \
  --agent-id hub-station \
  --description 'Hub Station project' \
  --workspace /var/agentport/workspaces/hub-station \
  --launch-profile hub-station
```

再登錄其他專案時，只要換 `agent-id`、Workspace 與 launcher profile：

```sh
sudo node "$AP" agent add --config "$CFG" \
  --agent-id billing-api \
  --description 'Billing API project' \
  --workspace /var/agentport/workspaces/billing-api \
  --launch-profile billing-api
```

確認清單不含秘密：

```sh
sudo node "$AP" agent list --config "$CFG"
```

### 4.2 建立 Principal allowlist

Principal 是 MCP Caller 的授權主體；`--allow-agent` 可以重複指定。只給
需要的專案，不要使用 wildcard：

```sh
sudo node "$AP" principal add --config "$CFG" \
  --principal-id hub-operator \
  --access-scope-id hub-scope \
  --allow-agent hub-station \
  --allow-agent billing-api
```

### 4.3 建立 Caller 並保存一次性 token

```sh
sudo node "$AP" caller add --config "$CFG" \
  --caller-id hub-mcp \
  --principal-id hub-operator
```

輸出 JSON 中的 `token` 只出現這一次。把它放進受保護的 MCP client secret
store，不要提交 Git、寫入 project、shell history 或貼到 ticket。設定檔只會
保存 `sha256:v1:<digest>`，`caller list` 不會輸出 token 或 hash：

```sh
sudo node "$AP" caller list --config "$CFG"
```

撤銷時：

```sh
sudo node "$AP" caller revoke --config "$CFG" --caller-id hub-mcp
```

## 5. 啟動、reload 與 readiness

Registry 變更先寫入受保護設定，再由 daemon `SIGHUP` 讀取、驗證並以 revision
fence 替換。錯誤 candidate 不會取代目前 revision：

```sh
sudo systemctl enable agentport-daemon.service
sudo systemctl start agentport-daemon.service
sudo systemctl reload agentport-daemon.service
sudo systemctl status agentport-daemon.service --no-pager
```

`ExecReload` 只允許 registry 欄位變更；port、storage、launcher、admin
socket 等 daemon-class 設定變更必須走完整 stop/start，不能用 reload 偷換。

如果有人把舊的、schema 正確的 `agentport.json` 放回去，SIGHUP 也會因為
`registryRevision` 倒退或同號內容不同而拒絕，保留目前 Registry revision。
這個高水位也寫入 daemon SQLite；重啟後載入較舊有效設定同樣會 fail closed。

管理 CLI 會在同一目錄建立 `agentport.json.lock`，把讀取、驗證與原子替換
序列化；同時執行的第二個管理命令會安全回 `managed_configuration_conflict`。
這個 lock 是 cooperative lock：若主機在管理命令中途崩潰，可能留下 lock
而暫時阻擋管理面。先確認沒有其他管理命令仍在執行，再由 root 移除這個同名
lock，之後重新執行原命令；不要用編輯器直接改 protected config。這是本版已知
的 residual operational risk。

建置後可查 offline host prerequisites：

```sh
sudo node "$AP" doctor --config "$CFG"
```

這個 command 不啟動 daemon、不開 SQLite、不讀 systemd credentials，也不會
呼叫 Runtime。`doctor --live` 是明確的 bounded Runtime probe，可能產生外部
Runtime 成本，只有在主機管理者授權時使用。

daemon 的 read-only readiness socket 只回傳 level、reason、時間與 bounded
capabilities；它不是 Task mutation API。看到 listener 開啟或 caller 已配置，
都不能單獨推論 `execution-ready`。

## 6. 下游 MCP Caller 設定

### 同一台 Hub Station

MCP client 指向 loopback endpoint，並在每個 HTTP request 帶一次性建立的
Bearer token：

```json
{
  "mcpServers": {
    "agentport": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-caller-add>"
      }
    }
  }
}
```

### 管理者控制的遠端工作站

不要把 daemon port 綁到 `0.0.0.0`。在遠端工作站建立管理者控制的 SSH
tunnel：

```sh
ssh -N -L 3333:127.0.0.1:3333 <hub-host>
```

然後讓該工作站的 MCP client 使用相同的
`http://127.0.0.1:3333/mcp`。SSH 帳號、host key、token 與網路 ACL 由主機
管理者負責；目前沒有 public HTTPS/OAuth transport。

## 7. MCP 驅動特定專案的固定流程

Caller 先列出自己 Principal 允許的 Agent，再把其中一個穩定 `agentId` 放進
submit。`list_agents` 不會回傳 workspace path；選擇由 Hub Station 的 registry
完成：

```text
agentport_list_agents({})
  -> [{ agentId: "hub-station", description: "..." },
      { agentId: "billing-api", description: "..." }]

agentport_submit_task({
  operationId: "billing-change-2026-09-19-001",
  agentId: "billing-api",
  instruction: "在目前專案修正發票 API，執行測試並回報結果"
})
```

之後的 `get_task`、`list_tasks`、`get_events`、`reply`、`resume_context`、
`cancel_task` 都只接受既有 Task／Context 的 opaque ID，仍會重新檢查 Caller
目前是否允許該 Agent。Caller 不能用另一個 Agent ID 改寫既有 Context，也不能
以路徑或 profile 旁路 registry。

在本 candidate 的現況，第二個呼叫會收到：

```json
{
  "ok": false,
  "error": {
    "code": "execution_not_ready",
    "retryable": false,
    "safeRetry": "none"
  }
}
```

這個結果沒有 Task、claim、Execution 或 launcher side effect。等 GATE-058
與 Runtime readiness 驗證完成後，該段流程才會變成實際 coding dispatch；
下游 client 不需要改變 `agentId` 選擇契約。

## 8. 更新與復原

每次變更後：

```sh
sudo node "$AP" agent list --config "$CFG"
sudo node "$AP" principal list --config "$CFG"
sudo node "$AP" caller list --config "$CFG"
sudo systemctl reload agentport-daemon.service
sudo node "$AP" doctor --config "$CFG"
```

變更前保留 root-only config backup 與 daemon SQLite／Runtime home 的一致性
備份；不要只備份 `agentport.json`。若 reload 失敗，先看 sanitized
`daemon_reload_failed`，確認設定檔仍符合 schema，再重試。不要手動刪 SQLite
或把 revoked caller 的 token 重新寫回設定。

## 不在本版承諾的事項

- archive、installer、版本簽章、GitHub release 或 attestation；
- 公開 HTTPS listener、TLS termination、OAuth discovery、audience validation；
- 自動建立 Claude subscription OAuth、Runtime home 或新 Runtime driver；
- 非 Linux native execution；
- 把 `service-ready`、MCP port 開啟或 Caller 已配置當成 `execution-ready`。

這些邊界若要改變，必須新增或批准對應 Story／Gate，不能只改部署命令。
