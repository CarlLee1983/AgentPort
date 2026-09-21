---
title: AgentPort v2 — 裝好就能用的 MCP 派工服務
labels: [implemented]
status: implemented
source_map: ../.scratch/agentport-v2/map.md
created: 2026-09-21
---

# AgentPort v2 — 裝好就能用的 MCP 派工服務

詞彙依 `CONTEXT.md`：Caller、Logical Agent、Workspace、Runtime、Runtime Driver、Task、Turn、Follow-up Task、Context、Runtime Session。v2 沒有 Execution 系列、Deployment Readiness、Clarification Reply、`needs_input`。

地圖票 01–10 皆已結案（07–10 於 2026-09-21 依建置票實作結果結案），原先標示 **【假設】** 的區段已依實作定案。

## Problem Statement

主機管理者在自己的電腦上已經登入了 `claude` 和 `codex`，手上有幾個專案資料夾。他希望遠端的人或 AI agent 能「把工作派給某個資料夾上的某個 runtime」，追蹤它做到哪、在同一段脈絡裡追加要求，然後拿回結果與改了什麼的摘要。v1 為了多操作者、特權邊界、精確一次執行堆了 launcher、principal、receipt、fencing、recovery 等機制，導致裝不起來也改不動。單操作者、單主機的場景不需要這些。

## Solution

一個 TypeScript 寫的 MCP 服務。管理者寫一份 TOML 宣告「agent 名稱 ↔ 資料夾 ↔ runtime ↔ 權限等級」與 caller 的 token，用 launchd 或 systemd 以自己的 OS 使用者身分把服務跑起來。Caller 透過 Streamable HTTP（bearer）或本機 stdio 呼叫六個 tool：列出 agent、提交 Task、long-poll 取結果、在同一 Context 追加、取消、列出歷史。每個 Task 恰好跑一個 Turn：服務以子程序啟動 CLI、收齊事件、Turn 結束後跑 `git diff --stat` 與 commit 清單，把最終文字與摘要存進 SQLite 回給 caller。Runtime 從不停下來等人，提問只會是最終文字，回答提問就是再提交一個 Follow-up Task。

## User Stories

### 安裝與設定（主機管理者）

1. As a 主機管理者, I want 只要在主機上登入過 `claude` / `codex`、寫一份 TOML、啟動服務就能用, so that 不用另外申請 API key 或設定特權帳號。
2. As a 主機管理者, I want 設定檔用 `--config`、`$AGENTPORT_CONFIG` 或 XDG 預設路徑找到, so that launchd / systemd 單元只需一行。
3. As a 主機管理者, I want 每個 agent 宣告 name、description、workspace、runtime、policy、extra_args, so that 遠端 caller 只能在我允許的資料夾與權限下工作。
4. As a 主機管理者, I want policy 只有 `read-only` / `workspace-write` / `full` 三級且必填, so that 授權意圖一眼可讀，而且不會因為漏寫而默默拿到寫入權。
5. As a 主機管理者, I want `extra_args` 能把任意旗標原樣附加到 CLI, so that 不用等 AgentPort 改版就能指定 model 或其他選項。
6. As a 主機管理者, I want caller token 只從環境變數讀（`token_env`）, so that 設定檔可以放進 dotfiles 或貼給別人看而不洩漏。
7. As a 主機管理者, I want 啟動時一次列出設定檔所有錯誤再退出, so that 不用改一個錯跑一次。
8. As a 主機管理者, I want 同一個 workspace 只能綁一個 agent, so that 不會有兩個 runtime 同時改同一個資料夾。
9. As a 主機管理者, I want 能用 `[runtimes.<name>].command` 指定 CLI 路徑, so that launchd 的 `PATH` 沒含 `~/.local/bin` 也能啟動。
10. As a 主機管理者, I want 路徑裡的 `~` 會展開、相對路徑相對於設定檔, so that 服務管理器 cwd 是 `/` 也不會找錯目錄。
11. As a 主機管理者, I want 改了設定檔重啟就生效, so that 不需要理解熱重載的邊界情況。
12. As a 主機管理者, I want 服務尊重我個人的 CLI 設定（hooks、model、`~/.codex/config.toml`）, so that 派工跑出來的行為和我自己在終端機跑的一致。
13. As a 主機管理者, I want 服務預設只綁 loopback, so that 我沒明確開放前不會暴露到網路。
14. As a 主機管理者, I want 原始 JSONL 事件存在磁碟並從 Task 記錄找得到, so that 出問題時能看 runtime 到底吐了什麼。
15. As a 主機管理者, I want 服務在 Mac 與 Linux 都能跑, so that 家裡的 Mac 和機房的 Linux 用同一套。

### 派工（Caller）

16. As a caller, I want 列出可用 agent 與各自的 description、runtime、policy, so that 我知道該把工作派給誰。
17. As a caller, I want 提交 Task 後立刻拿到 `task_id` 與 `context_id`, so that 我不用等它跑完就能繼續做別的事。
18. As a caller, I want `get_task` 能 long-poll 等到狀態改變, so that 我不用自己 sleep 輪詢。
19. As a caller, I want long-poll 的等待上限低於我這邊 MCP client 的 tool 逾時, so that 呼叫不會被 client 端砍掉。
20. As a caller, I want 拿回最終文字回覆、`git diff --stat`、commit 清單與 token usage, so that 我知道它做了什麼、改了哪些檔案。
21. As a caller, I want 在同一個 Context 追加要求, so that runtime 記得前面的對話。
22. As a caller, I want runtime 提問時我以 Follow-up Task 回答, so that 沒有第二套「澄清」協定要學。
23. As a caller, I want 看到 Claude 被拒絕的工具呼叫（`permission_denied` hints）, so that 我知道它是做不到而不是不想做。
24. As a caller, I want 對同一 agent 的多個 Task 依序執行、不同 agent 並行, so that 同一個 repo 不會被兩輪同時改，而不同專案不用互等。
25. As a caller, I want 取消還在排隊或執行中的 Task, so that 派錯了不用等它跑完。
26. As a caller, I want 列出歷史 Task 並分頁, so that 重連後找得回之前派的工作。
27. As a caller, I want Context 延續失敗時明確得到 `session_unresumable`, so that 我不會拿到一個失憶的 agent 卻以為它記得。
28. As a caller, I want 服務重啟後我的 `task_id` 還查得到、中斷的 Task 標為 `interrupted`, so that 我可以決定要不要在同一 Context 續派。
29. As a caller, I want 用 bearer token 認證並被記錄為哪個 caller, so that 管理者知道哪個 bot 派了什麼。
30. As a caller, I want 從本機 stdio 也能用同一套 tool, so that 我在主機上用 Claude Code 也能派給另一個 agent。
31. As a caller, I want 工作目錄不是 git repo 時 Task 仍成功、只是沒有 diff 摘要, so that 非 git 的資料夾也能派工。
32. As an AI caller, I want tool 有 output schema 與 `structuredContent`, so that 我不必解析自由文字。

### 維運

33. As a 主機管理者, I want Task 永久保留在單一 SQLite 檔, so that 備份就是複製一個檔案。
34. As a 主機管理者, I want 服務重啟後排隊中的 Task 自動繼續跑, so that 更新版本不用逐一重派。
35. As a 主機管理者, I want 有一張 ADR 說明為何用我自己的訂閱憑證跑服務, so that 之後的人知道這是有意的取捨與其政策風險。

## Implementation Decisions

### 架構與模組

- TypeScript、Node ≥ 24（`package.json` engines；macOS 部署依賴 Node 內建 `--env-file`）、`@modelcontextprotocol/server` + `node` 2.0.0、zod 4、better-sqlite3。Mac 與 Linux 為執行目標。
- 模組：設定檔載入、Agent Registry（設定檔的記憶體投影）、Task Store（SQLite）、Scheduler（每 agent 一條 FIFO worker）、Runtime Driver（claude、codex 各一）、Git 摘要、MCP server factory、兩個進入點（`agentport serve` HTTP、`agentport stdio`）。
- 一份 server factory 同時餵 `serveStdio` 與 `createMcpHandler`；HTTP 為 stateless，`task_id` 是唯一 handle，不用 MCP session。
- v1 可搬：`loopback-server.ts` 的 `toNodeHandler` + Host/Origin 驗證 + bearer → `AuthInfo`、兩個 CLI 的 JSONL 解析。v1 的 launcher、principal、receipt、fencing、recovery、supervisor 不搬。

### 設定檔（票 06 定案）

TOML，尋找順序 `--config` → `$AGENTPORT_CONFIG` → `~/.config/agentport/agentport.toml`。無 `schema_version`。

```toml
[server]
listen = "127.0.0.1:3333"
long_poll_max_seconds = 30       # 上限 55
turn_timeout_seconds = 3600      # 單一 Turn 最長秒數

[storage]
db_path = "~/.local/state/agentport/agentport.sqlite"
log_dir = "~/.local/state/agentport/logs"

[runtimes.claude]
command = "~/.local/bin/claude"  # 可選，預設 PATH

[[agents]]
name = "stationhub"              # [a-z0-9-]+ 唯一
description = "StationHub 後端"  # 可選
workspace = "~/Dev/CMG/StationHub"
runtime = "claude"               # claude | codex
policy = "workspace-write"       # 必填：read-only | workspace-write | full
extra_args = ["--model", "opus"]

[[callers]]
name = "grok"
token_env = "AGENTPORT_TOKEN_GROK"
```

尋找順序的預設路徑尊重 `$XDG_CONFIG_HOME`（未設則 `~/.config`）。未知欄位視為錯誤。`long_poll_max_seconds` 為 1..55 的整數。runtime 可執行檔只檢查有 agent 用到的 runtime；`command` 為裸名（不含 `/`）時走 `PATH` 查找。`HOME` 未設而設定值含 `~` 視為錯誤。（以上四點為票 01 實作時定案）

驗證：agent name 唯一合格式；workspace 存在且為目錄（不要求 git）；同一 realpath 只綁一個 agent；runtime、policy 為列舉值；caller name 唯一、`token_env` 變數非空、token 值唯一；`long_poll_max_seconds ≤ 55`；runtime 可執行檔存在；`agents[]` 非空；HTTP 模式 `callers[]` 非空。全部錯誤一次列出。`~` 展開、相對路徑相對於設定檔目錄。stdio 模式 caller 記為 `local`。不做 `instructions` 欄位、不做 runtime 層 `extra_args`。

### Runtime Driver（票 04 定案）

- 操作：`start(workspace, prompt, policy, extra_args) → events`、`resume(runtime_session_id, workspace, prompt, policy, extra_args) → events`、`kill()`。
- 事件：`started{runtime_session_id}`、`message{text}`、`activity{kind: command|file_change|tool, summary}`、`permission_denied{tool, input}`（僅 Claude）、`completed{final_text, usage}`、`failed{error}`。
- Claude：`claude -p --output-format stream-json --verbose --permission-mode <對應> --permission-prompts none`，續接 `--resume <session_id>`；policy 對應 `plan` / `acceptEdits` / `bypassPermissions`。失敗判定看 `result.is_error` / `subtype`，exit code 不可靠（未登入也 exit 0）。
- Codex：`codex exec --json --sandbox <對應> --skip-git-repo-check`，續接 `codex exec resume <thread_id>`；policy 對應 `read-only` / `workspace-write` / `danger-full-access`。失敗看 `turn.failed` / exit code。
- 子程序 `stdio: ['ignore', 'pipe', 'pipe']`（Codex 讀 stdin 到 EOF 才開始）；環境變數繼承服務程序的環境並確保 `USER` 存在（Claude 的 Keychain 查詢依賴它）。不加 `--ignore-user-config`、不加 `--setting-sources`。
- 票 04 / 05 實作時定案：prompt 一律放在 `--` 之後（`claude -p ... -- <prompt>`、`codex exec ... -- <prompt>`、`codex exec resume ... -- <thread_id> <prompt>`），`extra_args` 在 `--` 之前，caller 無法用前導 `-` 注入旗標。Codex resume 無 `--sandbox` 旗標，改以 `-c sandbox_mode=<值>` 傳 policy。`failed` 事件可帶 `code: "session_unresumable"`（Claude 看 `result.errors[]` 的 `No conversation found with session ID`，Codex 看 stderr 的 `no rollout found for thread id`），服務層直接採用為 `error.code`。Driver 對 caller 的錯誤文字為定型句（`<runtime> exited with code N` / `session not found`），stderr 尾端寫進原始 JSONL。原始 JSONL 存的是 CLI 原始輸出行（透過 `start(input, { onRawLine })` hook），不是對映後事件。Claude `permission_denied` 只從 `result.permission_denials[]` 產生。`[runtimes.*].command` 預設為裸名 `claude` / `codex`。真 CLI 測試以 `AGENTPORT_REAL_CLI=1` 手動開啟。已知限制：`read-only → plan` 下 Claude 不嘗試寫檔，`hints.permission_denied` 不會出現，且 plan mode 會在 `~/.claude/plans/` 留檔；是否改對應到 `default` 模式待決。
- 不宣告 Runtime Capability。原始 JSONL 寫到 `log_dir`，路徑記在 Task 上，不進 SQLite。
- `acceptEdits` 仍會拒部分 Bash 的不對稱寫進文件，不抹平。

### Task 狀態模型（票 05 定案）

`queued → running → completed | failed | cancelled`，沒有 `needs_input`。

| 從 | 到 | 觸發 |
|---|---|---|
| — | queued | `submit_task` / `follow_up` |
| queued | running | 該 agent 的 worker 取出 |
| queued | cancelled | `cancel_task` |
| running | completed | Driver `completed`，之後服務層跑 git 摘要；摘要失敗仍 completed，`diff_stat` / `commits` 為 null 並附 `hints.git` |
| running | failed | Driver `failed`；resume 失敗 `error.code = session_unresumable`；服務重啟時全部 running → `failed{interrupted}` |
| running | cancelled | `cancel_task` 或 Turn 逾時；見「取消與逾時」 |

- Context：服務發 ULID，`submit_task` 時建立並回傳，綁定一個 agent；`runtime_session_id` 存於 Context，第一個 Task `started` 事件後回填。Context 內嚴格線性：前一個 Task 未完成的 follow-up 排在同 agent 佇列後。前一個 failed / cancelled 仍可 follow-up，有 session id 就 resume，否則起新 session。
- 佇列：每 agent 一條 FIFO，不同 agent 並行，無上限。重啟後 queued 自動續跑（偏離 v1 ADR-0002 第二段，隨票 08 修訂）。中斷的 Task 不從 JSONL 回填 partial。
- 建置票 11 實作時定案：重啟掃描在 `createApp` 內執行（`serve`、`stdio`、測試共用），先把所有 running 一次改為 `failed{interrupted}`（`final_text` 維持 null、保留 `raw_log_path`、設 `finished_at`），再依 `task_id` 遞增把 queued 重新排入，因此同 agent 的 FIFO 與 Context 線性不變，帶 `runtime_session_id` 的 follow-up 照常 resume。設定檔已移除該 agent 的殘留 queued 會收斂為 `failed{runtime_failed}`。
- 建置票 11 實作時定案（使用者決定）：每個 `db_path` 只允許一個服務程序。`openTaskStore` 以 `locking_mode = EXCLUSIVE`（先於 `journal_mode = WAL`）加一次寫入取得獨佔鎖，持有到關閉；第二個程序（例如 `serve` 常駐時再開 `stdio`）拿到 `SQLITE_BUSY` 就快速失敗，訊息為「另一個 agentport 程序正在使用 <db_path>」，以非零碼結束。其他 SQLite 錯誤原樣回報。程序結束時 OS 自動釋放鎖，不需處理殘留鎖。主機上同時要用 `serve` 與 `stdio` 時，stdio 需設另一個 `db_path`。
- 持久化：Task 表 `task_id`、`context_id`、`agent`、`caller`、`prompt`、`state`、`created_at` / `started_at` / `finished_at`、`final_text`、`diff_stat`、`commits[]`、`usage`、`hints`、`error{code, message}`、`raw_log_path`。Context 表 `context_id`、`agent`、`runtime_session_id`、`created_at`。永久保留；不做 submit 去重。
- `hints` 非權威：`permission_denied[]` 原樣轉交 Claude 的 `permission_denials`；`git` 記摘要失敗原因。不做問句 heuristic。

票 02 實作時定案：tool 層錯誤以 `isError: true` 加 `structuredContent: { error: { code, message } }` 回傳（SDK 在 `isError` 時跳過 outputSchema 驗證）；Driver 事件流結束而無終態事件視為 `failed{runtime_failed}`；收到終態事件後忽略後續事件；`db_path` 與 `log_dir` 的父目錄由服務啟動時建立；`agentport stdio` 在真 Driver（票 04 / 05）落地前掛的是一律 `failed{runtime_failed}` 的占位 Driver。

### Git 摘要

Turn 開始時記下 HEAD（unborn 視為空樹）；Turn `completed` 後在 workspace 執行 `git diff --stat --relative <start> -- .`（限縮並相對於 workspace 子樹，untracked 以 `git status --porcelain -- .` 補在尾端）與 `git log <start>..HEAD`（不限縮子樹，由舊到新）。`commits` 形狀為 `{ sha, subject }[]`。所有 git 呼叫帶 `-c core.quotePath=false`。非 git 目錄、記 HEAD 失敗或 git 出錯 → `diff_stat` / `commits` 為 null + `hints.git`，Task 仍 completed。`failed` 的 Task 不跑摘要。（票 03 實作時定案）

### MCP tool 表面（地圖票 07 定案）

沿地圖定案的六個 tool，輸入輸出 zod schema 並回 `structuredContent` + 同內容 `content[text]`：

- `list_agents()` → `{ agents: [{ name, description, runtime, policy }] }`
- `submit_task({ agent, prompt })` → `{ task_id, context_id, state: "queued" }`
- `follow_up({ context_id, prompt })` → 同上；Context 不存在 → `not_found`
- `get_task({ task_id, wait_seconds? })` → Task 完整記錄；`wait_seconds` 為 0 即時回，否則等到狀態改變或 `min(wait_seconds, long_poll_max_seconds)`
- `cancel_task({ task_id })` → `{ task_id, state }`
- `list_tasks({ agent?, context_id?, state?, limit?, cursor? })` → `{ tasks: [摘要], next_cursor }`，摘要不含 `final_text`；整個 JSON-RPC 回應體受 ADR-0005 的 8 MiB 上限約束，超過則縮頁並給 cursor。
- `final_text` 容量：單一 Task 回應同受 8 MiB 約束；超過時截斷尾端並附 `hints.truncated`，完整內容在 `raw_log_path`。
- 錯誤碼（tool 層）：`not_found`、`invalid_state`（對終態 Task 取消）、`unknown_agent`。Task 層 `error.code`：`session_unresumable`、`interrupted`、`runtime_failed`、`cancelled`、`timeout`。
- Caller 身分：HTTP 由 bearer 對照 `callers[]`，stdio 為 `local`；只記錄，不做 Task 可見範圍隔離（ADR-0009）。

票 06–09 實作時定案：
- `get_task.wait_seconds`（≥ 0，預設 0）；等待以 notifier 的 per-task revision 為準，避免 notify-before-wait 漏事件；逾時回當前狀態不算錯。
- Scheduler 每 agent 一條 FIFO；`started` 事件只在 Context 尚無 `runtime_session_id` 時回填。
- `submit_task` 與 `follow_up` 共用建立+入列；`follow_up` 對 Context 綁定的 agent 已不在設定檔時回 `unknown_agent`。
- `list_tasks` 摘要只含 `task_id`、`context_id`、`agent`、`caller`、`state`、時間、`error`、`hints`、`raw_log_path`（不含 prompt / final_text / diff_stat / commits / usage）；`limit` 預設 50、超過 100 夾到 100；cursor 為不透明的 `task_id` 下界，未知 cursor 回空頁；排序為 `task_id` 遞減（ulid monotonic）；容量不足時單頁至少回一筆。`final_text` 截尾上限為回應體上限的一半減 64 KiB。容量政策由 `createApp` 注入，測試可覆寫。
- HTTP：`[server] allowed_hosts[]`，`listen` 非 loopback 時必填（啟動驗證），Host / Origin 只放行清單內主機；loopback 用 SDK 內建驗證。401 帶 `WWW-Authenticate: Bearer`，Host/Origin 不合回 403。`AuthInfo.token` 不保存原始 token。caller 名稱經 `AuthInfo.clientId` 進 server factory。
- ADR-0005 已複製到 `docs/adr/`。

### 取消與逾時（地圖票 10 定案，依建置票 10 實作）

- `cancel_task` 對 running Task：對子程序 process group 送 SIGTERM，5 秒後 SIGKILL；Task → `cancelled`，保留已收到的 `message` 文字為 `final_text`、仍跑 git 摘要。
- Runtime Session 被殺後是否可 resume 由票 09 / 10 實測決定；預設視為可 resume（Claude session 檔在磁碟、Codex thread 在 `~/.codex`），resume 失敗走 `session_unresumable`。
- Turn 最長時間：設定檔 `[server] turn_timeout_seconds`，預設 3600；逾時視同取消但 `error.code = timeout`。

建置票 10 實作時定案：
- 子程序以 `detached: true` 啟動成為自己的 process group leader，取消時對 `-pid` 送訊號；寬限 5 秒為常數，不進設定檔。子程序關閉後不再送 SIGKILL（避免 pgid 被重用）。副作用是服務收到 SIGINT 時子程序不會連帶收到，因此 `app.close()` 會先對所有執行中 Turn 呼叫 kill；DB 狀態留給重啟掃描（建置票 11）處理。
- `cancelled` 的 Task 一律帶 `error`：caller 取消為 `{ code: "cancelled" }`，逾時為 `{ code: "timeout" }`。queued 取消以 `WHERE state = 'queued'` 條件更新，立即生效、worker 不會再取出。
- 取消 / 逾時一旦對 running Task 被接受，終態就是 `cancelled`，即使 runtime 之後送出 `completed` 或 `failed`、或取消落在 git 摘要收尾期間。`final_text` 取 `completed.final_text`（若已收到），否則為已收到的 `message` 文字以空行串接；`usage` 同理。
- `cancel_task` 對 running Task 會等到終態或 `long_poll_max_seconds` 為止，回傳當下 state（通常為 `cancelled`，kill 尚未完成時可能仍是 `running`，不算錯）。對 `completed` / `failed` / `cancelled` 回 `invalid_state`。state 為 running 但服務內沒有對應 Turn（前次服務異常結束的殘留）時直接標為 `cancelled`。
- 逾時從 Task 進入 running 起算（含記錄 HEAD 的時間）。`turn_timeout_seconds` 為 ≥ 1 的整數。
- 取消後 follow-up 實測（2026-09-21，`policy = full`，Turn 中執行 `sleep 60` 時取消）：Claude 取消約 0.7 秒完成，follow-up `--resume` 成功且記得取消前的內容（2/2 次）。Codex 取消約 5 毫秒完成，follow-up 結果不穩定：3 次中 2 次 `completed` 但不記得、1 次 `failed{session_unresumable}`，沒有一次記得。推測 Codex 在 Turn 結束前未把該輪寫進 thread rollout（未驗證）。服務層不抹平此差異；真 CLI 測試 `tests/mcp/cancel-real-cli.test.ts` 對 Codex 接受兩種結果。

### 部署與憑證（地圖票 08 定案，依建置票 12 實作）

- 服務以已登入 CLI 的 OS 使用者身分常駐：Mac 用 LaunchAgent（`gui/<uid>`），Linux 用 `systemd --user`。環境至少帶 `HOME`、`USER`、`PATH`。
- `token_env` 變數由 plist `EnvironmentVariables` 或 systemd `EnvironmentFile=` 餵入；預設路徑 `~/.config/agentport/agentport.env`（mode 0600）。
- 遠端進入預設 SSH tunnel 到 loopback；直連 HTTP 需管理者明確改 `listen`。
- ADR：接受同使用者訂閱憑證模型，偏離 v1 ADR-0006 / 0007 / 0010；記錄官方政策灰區（第三方不得在產品中提供 claude.ai 登入或額度）；同一張 ADR 修訂 ADR-0002 的重啟語意。

建置票 12 實作時定案：
- token 一律放在 `~/.config/agentport/agentport.env`（mode 0600，`KEY=VALUE`），不進 plist / unit / TOML。launchd 沒有 env file 支援，macOS 改用 Node 內建 `node --env-file=<path> dist/cli.js serve`（檔案不存在時 node 直接以非零碼結束）；Linux 用 systemd `EnvironmentFile=`。原假設的 plist `EnvironmentVariables` 只用來帶 `HOME` / `USER` / `PATH`，不放 token。
- 範本在 `deploy/macos/com.agentport.serve.plist`、`deploy/linux/agentport.service`、`deploy/agentport.env.example`，以 sed 替換佔位符安裝；PATH 補 `~/.local/bin`，CLI 裝在其他位置時用 `[runtimes.*].command` 絕對路徑。
- macOS LaunchAgent 屬 `gui/<uid>`，重開機後需使用者登入才會啟動（Keychain 同樣需登入解鎖）；無人值守需自動登入。Linux 以 `loginctl enable-linger` 開機即起。
- `serve` 常駐時本機 `stdio` 需另一份設定檔指向不同 `db_path`（單實例鎖，建置票 11）。
- 憑證 ADR 為 `docs/adr/0011-same-user-subscription-credentials.md`，同一張修訂 ADR-0002 第二段；v1 的 0001 / 0002 / 0003 / 0005 / 0009 已複製到 `docs/adr/` 並註明來源與 v2 適用範圍。

### 保留的 v1 ADR

0001 外部觀測與控制、0002 task 跨重啟存活（修訂第二段）、0003 本地交易式 task store、0005 回應容量上限、0009 單操作者不隔離。

## Testing Decisions

- 好的測試只看外部行為：caller 透過 MCP tool 看到的狀態、結果、錯誤碼，以及磁碟上的 SQLite 與 JSONL。不測 Driver 內部的 parser 分支、不測 Scheduler 的私有佇列結構。
- **主 seam：MCP tool 邊界**。透過 server factory 與 `@modelcontextprotocol/client` 的 in-memory transport 直接呼叫 tool。注入一個依腳本吐事件的假 Driver（可指定延遲、失敗、resume 失敗），SQLite 與 workspace 用暫存真檔（workspace 以 `git init` 建立，可切非 git 情境）。在此層驗證：狀態機每條轉移、Context 線性與 follow-up、同 agent 序列 / 跨 agent 並行、long-poll 等待與上限、取消 queued / running、git 摘要與非 git、`hints`、`list_tasks` 分頁與容量、重啟後 running → interrupted 且 queued 續跑、caller 記錄。
- **Driver 契約 seam**：每個 Driver 對真實 CLI 跑單輪與續接，僅當本機有 `claude` / `codex` 且已登入時執行（沿 v1 `test:claude` 閘門）。JSONL 解析用錄下的 fixture 回放，不依賴 CLI。
- **設定檔載入**：`loadConfig(path, env)` 純函式，每條驗證規則一個案例，並驗證錯誤一次全列。
- HTTP 層（bearer、Host / Origin 驗證、stateless handler）沿 v1 `loopback-server` 的測試搬遷，不另開 seam。
- Prior art：v1 `tests/unit/daemon-configuration.test.ts`（設定驗證）、`tests/mcp-compatibility.test.ts`（in-process MCP client）、`tests/integration/s4-context-queue.test.ts`（Context 佇列）、`tests/claude-capabilities.test.ts`（真 CLI 閘門）。
- 覆蓋目標 80%+；TDD（先寫失敗測試）。

## Out of Scope

- 透過 MCP 安裝、登入或設定 runtime CLI；憑證只在主機端由管理者處理。
- Caller 自行指定路徑或登記 agent。
- Agent 之間的機密隔離、cgroup 監督、非 root launcher 特權邊界。
- v1 程式碼整體搬遷；PraxisBound / ForgePilot 流程。
- 設定檔熱重載、每 agent 佇列上限、submit `idempotency_key`、Task 保留期限清理。
- 多主機、完整 diff / 檔案內容取回、token 輪替與撤銷、第三個 runtime、Windows、Artifact 判定（留在地圖 fog，v2 之後）。
- Runtime 互動式提問協定（stdin 控制、`--permission-prompt-tool`）。

## Further Notes

- 本 spec 由地圖 `.scratch/agentport-v2/map.md` 合成；地圖票 01–10 皆已結案。票 09 的 prototype 未另寫，其問題由建置票 03–05、07、10 的真 CLI 測試回答。
- 憑證模型是官方政策灰區，ADR 必須明寫；若日後官方收緊，逃生口是 `CODEX_API_KEY` 與 Claude 的 API key 模式，不需改架構。
- 本機事實（2026-09-21）：`claude` 2.1.278、`codex` 0.155.0 於 `~/.local/bin`；Claude Code 憑證在 macOS login Keychain（`Claude Code-credentials`，查詢依賴 `USER`），Linux 在 `~/.claude/.credentials.json`；Codex 憑證在 `~/.codex/auth.json`。
- Claude Code、Codex、Cursor 都能從設定送自訂 header；Claude Desktop 遠端只走 OAuth Connector，不在 v2 支援清單。
