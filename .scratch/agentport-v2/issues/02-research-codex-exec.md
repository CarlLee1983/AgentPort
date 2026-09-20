# Research：codex exec --json 執行面

Type: research
Status: resolved
Map: ../map.md

## Question

AgentPort v2 要以子程序方式驅動已登入的 `codex` CLI（0.155.0）。需要確認：(1) `codex exec --json` 的 JSONL 事件 schema、結束訊號與 exit code；(2) `codex exec resume` 的用法與 session 識別；(3) `--sandbox` / `--full-auto` / approval policy 各選項在非互動下的行為，以及需要人工批准時會怎樣（阻塞？中止？）；(4) 認證：`~/.codex/auth.json` 的 ChatGPT 登入在非互動、由服務管理器啟動的程序下是否可用，與 API key 模式的差異；(5) 是否有能取得「本輪改了哪些檔案」的官方事件。以官方文件與本機實測為準。

## Answer

Findings：branch `research/codex-exec`，檔案 `.scratch/agentport-v2/research/codex-exec.md`（全部本機實測或 0.155.0 原始碼驗證）。

1. 非互動下「需要批准」不阻塞、不中止：`codex exec` 強制 `approval_policy = never`；沙箱擋掉的動作以 `operation not permitted` 回給模型，turn 正常結束 exit 0。`request_user_input` 在 exec 模式不存在，Codex 的「需要輸入」只能靠最後 agent_message 是否為問句判斷。
2. ChatGPT 登入的 `~/.codex/auth.json` 在 launchd 啟動的程序可用（真實 LaunchAgent 實測 exit 0）。純檔案，不在 Keychain。`CODEX_API_KEY` 是逃生口，非必要。
3. JSONL：`thread.started{thread_id}` → `turn.started` → `item.*` → `turn.completed{usage}` / `turn.failed{error}`；`thread_id` 直接給 `codex exec resume <id>`。Exit 0 成功、1 turn 失敗或非 git 目錄無 `--skip-git-repo-check`、2 參數錯誤。
4. `file_change` item 只涵蓋 `apply_patch`，shell 改檔不出現，無 turn 層彙總——`git diff --stat` 仍是必要來源。
5. 陷阱：`--full-auto` 與 `-a` 在 exec 已不存在（exit 2）；stdin 非 TTY 時讀到 EOF 才開始，spawn 必須 `stdio: ['ignore', …]`；主機使用者的 `~/.codex/config.toml` 會被載入，v2 要決定 `--ignore-user-config` 與否（留給設定檔 schema 票）。
