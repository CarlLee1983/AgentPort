# Toolchain and compatibility baseline

查證日期：2026-09-12（Asia/Taipei）。本文件固定 AP-001 / S0 的可重現開發工具與相容性結果；版本來源是當日官方 release／package metadata，實際結果由 repository fixture 取得。

## Exact versions

| Component          | Exact version                                                      | Evidence and role                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js            | `24.21.0`                                                          | Node 24 Krypton LTS 的 2026-09-07 patch；`.node-version`、`engines.node` 與 CI 共用。來源：[Node release archive](https://nodejs.org/en/download/archive/v24)                                                                                                                    |
| pnpm               | `12.4.1`                                                           | 唯一 package manager；`packageManager`、`engines.pnpm` 與 CI 共用。來源：[pnpm releases](https://github.com/pnpm/pnpm/releases)                                                                                                                                                  |
| TypeScript         | `6.0.3`                                                            | 固定 compiler；符合 `typescript-eslint@8.70.0` 宣告的 `<6.1.0` peer range。                                                                                                                                                                                                      |
| MCP TypeScript SDK | `@modelcontextprotocol/client@2.0.0`, `server@2.0.0`, `node@2.0.0` | split v2 packages，固定 `2026-07-28` modern revision。來源：[SDK v2 changelog](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/core/CHANGELOG.md)                                                                                                      |
| Claude Agent SDK   | `0.3.269`                                                          | 僅安裝 JS／type package；其 package metadata 對應 Claude Code `2.1.269`。平台 Runtime optional packages 被精確排除，未執行 `query()`。來源：[official SDK release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.269)                              |
| SQLite binding     | `better-sqlite3@13.0.3`                                            | Node 24 載入成功；fixture worker 的 `select sqlite_version()` 實測 runtime `3.53.4`。來源：[binding metadata](https://github.com/WiseLibs/better-sqlite3/blob/master/package.json)、[bundled SQLite](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md) |

所有 package dependency 都以 exact version 寫入 `package.json` 並由 `pnpm-lock.yaml` 固定 transitives。pnpm 只允許 `better-sqlite3` 的 native build；`@anthropic-ai/claude-agent-sdk-*` 平台 optional packages 由 `pnpm-workspace.yaml` 排除，避免安裝真正 Claude coding runtime。

## Installation and verification

在 fresh checkout 安裝 `.node-version` 指定的 Node，接著執行：

```sh
corepack enable
corepack prepare pnpm@12.4.1 --activate
pnpm install --frozen-lockfile
make verify
```

`make verify` 是 canonical local gate，依序檢查 repository／Story、exact Node／pnpm 與唯一 lockfile，以 frozen lockfile 安裝後再執行 Prettier、ESLint、TypeScript、build 和 Vitest。因此 ForgePilot 的 detached committed worktree 不依賴既有 `node_modules`。個別診斷命令是 `pnpm run typecheck`、`pnpm run test:mcp` 與 `pnpm run test:sqlite`；它們不是另一個 PASS authority。

## MCP compatibility

`pnpm run test:mcp` 使用官方 `Client` 與 `StreamableHTTPClientTransport`，以 `{ pin: "2026-07-28" }` 連至 `127.0.0.1` 的隨機 port。server 使用官方 strict modern `createMcpHandler`、每請求建立 `McpServer`、拒絕 legacy lifecycle，且不建立 `Mcp-Session-Id`。fixture 只有 `compatibility_identity` 工具，沒有 AgentPort production API、Task、storage 或 Runtime dispatch。

每個 POST 都要求 `MCP-Protocol-Version` header；SDK 的 per-request envelope 另帶 protocol version、client capabilities 及 present client info。測試覆蓋官方 Client 的 `tools/list`／`tools/call`、output schema、structuredContent 與相同 JSON TextContent，也覆蓋未知工具、無效 schema、principal override、unsupported revision、缺 envelope、legacy initialize、缺／錯 bearer 與兩個獨立 synthetic principal。transcript 只保存 request ID、method、協定 metadata 及衍生 principal label，不保存 header 或 token。

這證明 private preconfigured bearer fixture 的互通，沒有宣稱完整 MCP OAuth discovery／audience conformance。fixture 外部仍需在 production boundary 定義完整 authorization policy。

## Claude static capability matrix

| Capability           | Fixed-package evidence                                                                                                               | Runtime status                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Streaming input      | `query` prompt 接受 `AsyncIterable<SDKUserMessage>` 的 compile-time assertion                                                        | 未執行真 query                       |
| Cancellation/control | `Options.abortController`、`Query.interrupt`／`close` 型別存在                                                                       | 未證明 process tree 停止；屬 S1      |
| Clarification        | `Options.canUseTool`／`CanUseTool` 與 SDK `AskUserQuestionInput` schema 由 compile-time assertion 連結至 `AskUserQuestion` tool name | 未觸發問題或回答；屬 S1              |
| Workspace/settings   | `cwd`、`settingSources` 型別存在                                                                                                     | 未載入真 workspace settings          |
| Continuation         | `resume` 型別存在                                                                                                                    | 未證明安全續接或跨重啟語意           |
| Launcher seam        | `spawnClaudeCodeProcess` 型別存在                                                                                                    | 未啟動 binary；cgroup／cleanup 屬 S1 |

來源型別由 `compatibility/claude-capabilities.ts` 在 `skipLibCheck: false` 下編譯；package test同時確認 SDK `0.3.269`、binary version basis `2.1.269`，以及所有平台 Runtime packages 都未安裝。

## SQLite compatibility

`pnpm run test:sqlite` 在 Node Worker 裡載入 `better-sqlite3@13.0.3`、開啟清理後即刪除的 temporary database、切換 WAL、查詢實際 SQLite runtime `3.53.4`，並確認主事件迴圈可在 worker 完成前推進。這是未來單一 DB worker 的可用非阻塞 seam；本 Story 沒有建立 Task schema、migration 或 storage。

SQLite 官方指出 WAL-reset corruption 影響 `3.7.0` 至 `3.51.2`，從 `3.51.3` 修正；實測 `3.53.4` 含該修正。來源：[SQLite WAL documentation](https://www.sqlite.org/wal.html)、[release history](https://sqlite.org/changes.html)。

## Linux target prerequisites

本次執行環境是 macOS `26.5.1`，repository 或交辦內容沒有指定可登入的 Linux target。以下是 G0 必要 environment evidence，目前全部 `blocked`，不能由 local PASS 代替：

| Item                     | Query on designated target                                             | Observation                                  |
| ------------------------ | ---------------------------------------------------------------------- | -------------------------------------------- |
| OS/version               | `uname -a`; `/etc/os-release`                                          | `blocked — no designated Linux target`       |
| cgroup v2                | `stat -fc %T /sys/fs/cgroup`; read `/sys/fs/cgroup/cgroup.controllers` | `blocked — no designated Linux target`       |
| service account          | `id <account>`                                                         | `blocked — account name/target not provided` |
| launcher permission      | inspect approved systemd unit and delegated cgroup subtree             | `blocked — launcher target not provided`     |
| protected data directory | `stat` owner/mode on approved path                                     | `blocked — path/target not provided`         |
| vendor credential source | inspect source name and availability only; never value                 | `blocked — target/source not provided`       |

Rollback for S0 removes the fixture/config/dependencies and regenerates `pnpm-lock.yaml`; there is no product state or migration to reverse.
