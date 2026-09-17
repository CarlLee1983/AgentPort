# AgentPort 完整部署與運維手冊

本手冊為 AgentPort 的完整部署、配置、多專案接入、運維診斷與備份復原指南。

---

## 1. 系統架構與拓撲規範

AgentPort 採用 **三權分立（Separation of Privilege）** 架構，確保外部 AI 任務、系統核心與底層作業系統資源嚴格隔離。

```
┌────────────────────────────────────────────────────────┐
│                   External MCP Caller                  │
│       (Claude Desktop, Cursor, Automated Scripts)      │
└───────────────────────────┬────────────────────────────┘
                            │ HTTPS (TLS + Bearer Token)
                            ▼
┌────────────────────────────────────────────────────────┐
│                   Reverse TLS Proxy                    │
│                 (Nginx / Caddy / Envoy)                │
└───────────────────────────┬────────────────────────────┘
                            │ Forward to 127.0.0.1 (Loopback)
                            ▼
┌────────────────────────────────────────────────────────┐
│               AgentPort Daemon Process                 │
│                 (User: agentport-daemon)               │
│  - MCP Adapter (Streamable HTTP / JSON-RPC)            │
│  - AgentExecutionService (Invariants & Fencing)        │
│  - SQLite WAL Store (/var/lib/agentport/store.db)      │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
      IPC      ▼                          ▼  Dedicated Worker
┌──────────────────────────┐   ┌─────────────────────────┐
│   Root Launcher Daemon   │   │  Storage Incident Sync  │
│      (User: root)        │   │    & Capacity Reserve   │
│  - cgroup v2 controller  │   └─────────────────────────┘
│  - StopEvidence verifier │
└──────────────┬───────────┘
               │ Fork / Drop Privileges
               ▼
┌────────────────────────────────────────────────────────┐
│               Isolated Runtime Worker                  │
│                (User: agentport-runtime)               │
│  - Claude Code CLI / Agent SDK                         │
│  - Restricted Workspace (/var/agentport/workspaces/..) │
└────────────────────────────────────────────────────────┘
```

### 三大角色權限職責

| 身份主體 | 系統帳號 | 擁有權限與職責 | 安全限制（禁止事項） |
| :--- | :--- | :--- | :--- |
| **Root Launcher** | `root` (`uid 0`) | 管理 cgroup v2、綁定資源限制、啟動與強制銷毀執行進程樹、簽發 Stop Evidence。 | 不處理任何外網請求，只監聽本機 protected UNIX Socket。 |
| **Daemon Service** | `agentport-daemon` (非 root) | 執行 MCP Adapter、核心狀態機、SQLite 資料庫獨占讀寫。 | 無 root 權限，無法繞過 Launcher 直接操作底層進程或 cgroup。 |
| **Runtime Worker** | `agentport-runtime` (低權限) | 實際跑 Claude Code CLI / SDK，直接在指派的 Workspace 內執行讀寫與測試。 | **嚴禁**存取 SQLite 資料庫、WAL 檔、Launcher Socket、系統憑證與其他 Workspace。 |

---

## 2. 環境需求

- **作業系統**：
  - **正式執行環境**：Linux（Kernel 5.8+，支援 cgroup v2 與 systemd）。
  - **開發與契約驗證**：macOS 或 Linux。
- **執行環境**：Node.js `24.21.0`（嚴格版號要求）。
- **套件管理工具**：pnpm `12.4.1`（鎖定 `pnpm-lock.yaml`）。
- **外部依賴**：SQLite 3.51.3+（包含 WAL 修正），Claude Code CLI。

---

## 3. Linux 主機前置設定步驟

### 3.1 建立系統專用帳號與群組

```bash
# 1. 建立 Launcher 通訊群組
sudo groupadd -r agentport-launcher

# 2. 建立 Daemon 服務帳號（加入 launcher 群組）
sudo useradd -r -s /usr/sbin/nologin -g agentport-launcher -M agentport-daemon

# 3. 建立 Runtime 沙盒帳號（完全隔離，不給予 launcher 群組權限）
sudo useradd -r -s /bin/bash -m -d /home/agentport-runtime agentport-runtime
```

### 3.2 建立必要目錄與設定檔案權限

```bash
# 配置檔目錄 (root 專用)
sudo mkdir -p /etc/agentport
sudo chmod 700 /etc/agentport

# 資料庫持久化目錄 (daemon 專用讀寫)
sudo mkdir -p /var/lib/agentport
sudo chown -R agentport-daemon:agentport-launcher /var/lib/agentport
sudo chmod 700 /var/lib/agentport

# Supervisor Ledger 帳本目錄 (root 專用)
sudo mkdir -p /var/lib/agentport/ledger
sudo chown -R root:root /var/lib/agentport/ledger
sudo chmod 700 /var/lib/agentport/ledger

# Worker Ingress 通訊目錄 (root 擁有，runtime 可進但不可改)
sudo mkdir -p /run/agentport/ingress
sudo chown root:agentport-runtime /run/agentport/ingress
sudo chmod 750 /run/agentport/ingress

# 多專案工作區目錄根路徑
sudo mkdir -p /var/agentport/workspaces
sudo chown -R agentport-runtime:agentport-runtime /var/agentport/workspaces
sudo chmod 750 /var/agentport/workspaces
```

---

## 4. 設定檔配置

### 4.1 Root Launcher 設定 (`/etc/agentport/launcher.json`)

此設定檔由 root 擁有，嚴禁非 root 修改（權限 `0600`）：

```json
{
  "socketPath": "/run/agentport/launcher.sock",
  "socketGroup": "agentport-launcher",
  "ledgerDirectory": "/var/lib/agentport/ledger",
  "workspaceRoot": "/var/agentport/workspaces",
  "runtimeUser": "agentport-runtime",
  "runtimeGroup": "agentport-runtime",
  "runtimeHome": "/home/agentport-runtime",
  "nodeExecutable": "/usr/bin/node",
  "profiles": {
    "profile-project-a": {
      "workspaceIdentity": "ws-project-a",
      "workspacePath": "/var/agentport/workspaces/project-a",
      "workerEntrypoint": "/opt/agentport/dist/src/runtime/worker/entrypoint.js",
      "workerArguments": [],
      "memoryMaxBytes": 4294967296,
      "tasksMax": 512,
      "cpuQuotaPercent": 200
    },
    "profile-project-b": {
      "workspaceIdentity": "ws-project-b",
      "workspacePath": "/var/agentport/workspaces/project-b",
      "workerEntrypoint": "/opt/agentport/dist/src/runtime/worker/entrypoint.js",
      "workerArguments": [],
      "memoryMaxBytes": 4294967296,
      "tasksMax": 512,
      "cpuQuotaPercent": 200
    }
  },
  "commandTimeoutMilliseconds": 30000,
  "stopTimeoutMilliseconds": 15000
}
```

### 4.2 Agent Registry 設定 (`/etc/agentport/registry.json`)

定義外部認證金鑰（Bearer Token）、使用者權限與多專案 Agent 的對應關係：

```json
{
  "credentials": {
    "sk_live_agentport_secure_bearer_token_abc123": "caller-operator"
  },
  "principals": [
    {
      "principalId": "caller-operator",
      "accessScopeId": "scope-default",
      "active": true,
      "allowedAgentIds": ["project-a-agent", "project-b-agent"]
    }
  ],
  "agents": [
    {
      "agentId": "project-a-agent",
      "description": "前端專案 A (Web App)",
      "workspacePath": "/var/agentport/workspaces/project-a",
      "configurationRevision": "v1",
      "runtimeDriver": "claude-code",
      "runtimeVersion": "0.3.269",
      "launchProfileId": "profile-project-a",
      "policy": {
        "maximumExecutionLimitSeconds": 3600,
        "maximumInputWaitSeconds": 86400
      }
    },
    {
      "agentId": "project-b-agent",
      "description": "後端專案 B (API Service)",
      "workspacePath": "/var/agentport/workspaces/project-b",
      "configurationRevision": "v1",
      "runtimeDriver": "claude-code",
      "runtimeVersion": "0.3.269",
      "launchProfileId": "profile-project-b",
      "policy": {
        "maximumExecutionLimitSeconds": 3600,
        "maximumInputWaitSeconds": 86400
      }
    }
  ]
}
```

---

## 5. 部署前環境預檢 (Preflight Check)

在啟動服務前，必須執行 AgentPort 內建的嚴格權限預檢工具：

```bash
cd /opt/agentport
pnpm run build

sudo node dist/src/operations/linux-preflight-main.js \
  /etc/agentport/launcher.json \
  agentport-daemon \
  /var/lib/agentport/store.db \
  /run/agentport/ingress
```

### 預期結果
- 指令必須輸出 JSON 且結束碼（Exit Code）為 `0`：
```json
{
  "status": "preparation_valid",
  "dispatchEligible": false,
  "checks": [
    { "code": "configuration_fields", "outcome": "pass" },
    { "code": "platform_supported", "outcome": "pass" },
    { "code": "daemon_account_isolated", "outcome": "pass" },
    { "code": "database_path_isolated", "outcome": "pass" },
    { "code": "ingress_permissions_valid", "outcome": "pass" }
  ]
}
```
*若結果為 `fail`，請檢查是否誤將 database 放在 Workspace 內，或 runtime 帳號有權讀取資料庫。*

---

## 6. Systemd 服務管理配置

建立兩個 Systemd 服務單元：`agentport-launcher.service` 與 `agentport.service`。

### 6.1 `agentport-launcher.service` (以 root 執行)

`/etc/systemd/system/agentport-launcher.service`:
```ini
[Unit]
Description=AgentPort Root Execution Launcher
Before=agentport.service

[Service]
Type=simple
User=root
Group=root
ExecStart=/usr/bin/node /opt/agentport/dist/src/supervisor/linux/launcher-main.js /etc/agentport/launcher.json
Restart=always
RestartSec=3
KillMode=process

[Install]
WantedBy=multi-user.target
```

### 6.2 `agentport.service` (以 agentport-daemon 執行)

`/etc/systemd/system/agentport.service`:
```ini
[Unit]
Description=AgentPort MCP Daemon Service
After=network.target agentport-launcher.service
Requires=agentport-launcher.service

[Service]
Type=simple
User=agentport-daemon
Group=agentport-launcher
WorkingDirectory=/opt/agentport
Environment=NODE_ENV=production
Environment=AGENTPORT_DB=/var/lib/agentport/store.db
Environment=AGENTPORT_REGISTRY=/etc/agentport/registry.json
Environment=AGENTPORT_PORT=3333
ExecStart=/usr/bin/node /opt/agentport/dist/src/mcp/loopback-server.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

啟動服務：
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agentport-launcher.service
sudo systemctl enable --now agentport.service
```

---

## 7. 反向代理與對外暴露 (Nginx TLS Proxy)

AgentPort MCP 監聽於 `127.0.0.1:3333`。禁止直接暴露於公網，必須透過反向代理封裝 TLS：

```nginx
server {
    listen 443 ssl http2;
    server_name agentport.internal.yourcompany.com;

    ssl_certificate /etc/ssl/certs/agentport.crt;
    ssl_certificate_key /etc/ssl/private/agentport.key;

    # 嚴格限制最大請求內容，符合 MCP 規格
    client_max_body_size 16M;

    location /mcp {
        proxy_pass http://127.0.0.1:3333;
        proxy_http_version 1.1;

        # 傳遞標準 Header，但防止未信任的偽造 Header
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization $http_authorization;

        # 支援 Streamable HTTP 串流回應
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

---

## 8. MCP Client 連線設定 (Claude Desktop / Cursor)

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "agentport": {
      "url": "https://agentport.internal.yourcompany.com/mcp",
      "headers": {
        "Authorization": "Bearer sk_live_agentport_secure_bearer_token_abc123"
      }
    }
  }
}
```

---

## 9. 日常運維、備份與災害復原

### 9.1 資料庫一致性備份 (SQLite Online Backup)

禁止在服務運作中直接用 `cp` 複製 SQLite 檔案，應使用 SQLite 官方提供的安全備份指令：

```bash
# 使用 sqlite3 備份 API（保證交易與 WAL 一致性）
sudo -u agentport-daemon sqlite3 /var/lib/agentport/store.db ".backup '/var/backups/agentport/store-$(date +%Y%m%d%H%M%S).db'"
```

### 9.2 離線復原流程

若需復原資料庫：
1. 停止 Daemon：`sudo systemctl stop agentport.service`
2. 替換資料庫檔案：
   ```bash
   sudo cp /var/backups/agentport/store-20260917.db /var/lib/agentport/store.db
   # 務必清理舊的 WAL 與 SHM 檔
   sudo rm -f /var/lib/agentport/store.db-wal /var/lib/agentport/store.db-shm
   sudo chown agentport-daemon:agentport-launcher /var/lib/agentport/store.db
   sudo chmod 600 /var/lib/agentport/store.db
   ```
3. 重新啟動服務：`sudo systemctl start agentport.service`
   - 重啟後，AgentPort 會自動核對未完成的 Task 並轉入安全暫停（Paused）狀態，**絕不盲目重跑或覆寫工作區**。
