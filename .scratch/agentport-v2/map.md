# Map: AgentPort v2 — 裝好就能用的 MCP 派工服務

Label: wayfinder:map
Created: 2026-09-20

## Destination

一份可直接進 `/to-spec` 的 v2 規格：主機管理者只要在主機上登入過 `claude` / `codex`、寫一份設定檔宣告「資料夾 ↔ runtime」、啟動 MCP 服務，遠端 caller（人或 AI agent）就能透過 MCP 把工作派給指定 agent、追蹤狀態、在同一 context 追加要求，並拿回文字結果與 diff 摘要。地圖走完的條件：Driver 介面、Task 狀態模型、設定檔 schema、MCP tool 表面、部署方式與憑證 ADR 全部定案。

## Notes

- 領域詞彙沿用 `CONTEXT.md`（自 v1 複製）：Caller / Logical Agent / Workspace / Runtime / Runtime Driver / Task / Context / Runtime Session。v2 不使用 Execution Generation、Execution Unit、Execution Supervisor、Deployment Readiness——這些是 v1 複雜度的來源。
- 每個 grilling 票都用 `mattpocock-skills:grilling` + `mattpocock-skills:domain-modeling`；詞彙異動即時寫回 `CONTEXT.md`。
- v1 程式碼在 `../AgentPort`，Driver 的 CLI 解析可搬；流程（PraxisBound / ForgePilot）不搬。
- 已定案原則（2026-09-20 grilling）：
  - 憑證模型：MCP 服務跑在已登入 CLI 的那個 OS 使用者下，直接用其 home（刻意偏離 v1 ADR-0006/0007/0010，需 ADR）。
  - 設定檔 TOML，`agents[]` 每項 = name、workspace、runtime、runtime 權限/沙箱選項；改了重啟；caller 不能改權限。
  - 非同步 submit + long-poll `get_task`；SQLite 單檔存 task；砍 receipts / fencing / stop evidence。
  - 不做 clarification 協定：runtime 提問 = task 以 `needs_input` 結束並附問題，caller 用同一 context 的 follow-up 回答。
  - Context 對應 `claude --resume` / `codex exec resume`。
  - 同一 agent 序列執行，不同 agent 可並行。
  - Caller 認證：Streamable HTTP + bearer token，token→caller 名稱對照在設定檔，只記錄不隔離。
  - 回傳：最後文字回覆 + `git diff --stat` + commit 清單。
  - TypeScript + `@modelcontextprotocol/sdk`。Mac 與 Linux 皆為執行目標。
- 繼承自 v1 的 ADR：0001 外部觀測與控制、0002 task 跨重啟存活、0003 本地交易式 task store、0005 回應容量上限、0009 單操作者、agent 間不隔離。
- 本機事實：`claude` 2.1.278、`codex` 0.155.0 於 `~/.local/bin`；Codex 憑證在 `~/.codex/auth.json`，Claude Code 憑證在 macOS login Keychain（`Claude Code-credentials`）。

## Decisions so far

<!-- 一票一行：[票名](issues/NN-slug.md) — 一句話 gist -->
- [Research：Claude Code 無頭執行面](issues/01-research-claude-headless.md) — launchd 下 Keychain 憑證可用但需 `USER` env；純 `-p` 不會停下來問（AskUserQuestion 不存在、權限直接 denied）；`session_id` 可 `--resume` 但權限模式每次重帶；訂閱憑證供第三方服務用是政策灰區。
- [Research：MCP SDK Streamable HTTP 與長輪詢](issues/03-research-mcp-sdk-http.md) — 用 SDK 2.0.0 `server`+`node`，stateless、`task_id` 當 handle；long-poll 上限 < 60 s（Codex 預設 60 s），建議 25–45 s；bearer 走前置 middleware 靜態表；stdio 與 HTTP 共用 factory；Claude Desktop 遠端只能 OAuth Connector。
- [Driver 介面：兩個 CLI 的統一事件模型](issues/04-grilling-driver-interface.md) — Claude 單向 `-p --permission-prompts none`，一次執行 = 一個 Turn、永不等待；六種事件；抽象三級 policy + extra_args；尊重主機 CLI 設定；不宣告 capability；詞彙引入 Turn、刪 Execution 系列。
- [Task 狀態模型與 follow-up 語意](issues/05-grilling-task-model.md) — 五態無 `needs_input`，提問即 `final_text`、回答即 follow-up；Context 由服務發 id 綁 agent、內部線性，resume 失敗明確 `session_unresumable`；重啟 running→`failed{interrupted}`、queued 自動續跑（偏離 ADR-0002，隨票 08 修訂）；存 prompt 原文、永久保留、不去重。
- [設定檔 schema（TOML）](issues/06-grilling-config-schema.md) — `--config`/`$AGENTPORT_CONFIG`/XDG 路徑；`[server]`/`[storage]`/`[runtimes.*].command`/`[[agents]]`（name、description、workspace、runtime、必填 policy、extra_args）/`[[callers]]`（name、`token_env`）；token 不進檔案；一 workspace 一 agent；stdio caller 記 `local`；啟動一次列出所有驗證錯誤。
- [Research：codex exec --json 執行面](issues/02-research-codex-exec.md) — approval 在 exec 模式永遠 never（不阻塞）；auth.json 在 launchd 下可用；thread_id 可 resume；file_change 不完整需靠 git diff；stdin 必須 ignore。

## Not yet specified

- 設定檔熱重載（SIGHUP / 檔案監看）——schema 已定（票 06），改了重啟是定案；有痛點再開。
- 多主機：caller 端要不要能選主機，或每台主機各自一個 MCP endpoint 由 client 端組合。
- 完整 diff / 檔案內容的取回方式（受 ADR-0005 容量上限約束）。
- Token 輪替與撤銷。
- 第三個 runtime（Cursor Agent 等）與 Windows。
- Runtime 產出的 Artifact 判定（哪些檔案可回給 caller）。
- 每 agent 佇列上限、`submit_task` 的 `idempotency_key`、Task 保留期限清理——票 05 先不做，有痛點再開。

## Out of scope

- 透過 MCP 安裝、登入或設定 runtime CLI：憑證只在主機端由管理者處理（Q2）。
- Caller 自行指定任意路徑或自行登記 agent（Q4；Agent Registry 原則）。
- Agent 之間的機密隔離、cgroup 監督、非 root launcher 特權邊界（ADR-0009；Q1 要簡單）。
- 沿用 PraxisBound / ForgePilot 開發流程。
- v1 程式碼整體搬遷為 major 版本（Q7 選 b）。
