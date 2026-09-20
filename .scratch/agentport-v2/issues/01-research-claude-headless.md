# Research：Claude Code 無頭執行面

Type: research
Status: resolved
Map: ../map.md

## Question

AgentPort v2 要以子程序方式驅動已登入的 `claude` CLI（2.1.278）。需要確認：(1) `claude -p` 搭配 `--output-format stream-json` 的事件 schema，特別是 AskUserQuestion / 權限詢問在非互動模式下如何呈現、task 如何得知「需要輸入」；(2) session id 如何取得、`--resume` / `--continue` 的語意與限制；(3) `--permission-mode` 各值與 `--dangerously-skip-permissions` 的行為；(4) 憑證在 macOS 存於 login Keychain、在 Linux 存於何處，由 launchd / systemd 啟動的非互動程序能否讀到；(5) 官方是否建議改用 Agent SDK 而非 CLI，兩者在上述各點的差異。以官方文件與本機實測為準。

## Answer

Findings：branch `research/claude-headless`，檔案 `.scratch/agentport-v2/research/claude-headless.md`（官方文件六頁原文 + SDK 0.3.278 原始碼 + 十次本機實驗）。

1. 憑證可用，但依賴 `USER` 環境變數：launchd `gui/501` 啟動、環境只有 `HOME/USER/PATH/SHELL/TMPDIR` 的 `claude -p` 成功；`env -i` 只留 `HOME` 回 `Not logged in`（exit 0）。Keychain 查詢是 `security find-generic-password -a $USER -s "Claude Code-credentials"`。Linux 為 `~/.claude/.credentials.json`。`--bare` 不讀 OAuth，與訂閱憑證互斥。
2. 「需要輸入」在純 `-p` 不存在：AskUserQuestion 不在工具清單；權限只會變成 `system/permission_denied` + `result.permission_denials[]`，程序不等。要真的停下來問必須 `--input-format stream-json --permission-prompt-tool stdio`，CLI 送 `control_request{subtype:"can_use_tool"}`。這與地圖定案的「needs_input 結束、follow-up 回答」相容：v2 可先用純 `-p`，由結果文字與 `permission_denials` 推斷。
3. Session：`result.session_id`；`-p --resume <id>` 可從任意 cwd 續接，`--fork-session` 給新 id；resume 不還原原權限模式（每次都要重帶）。
4. 權限模式：`acceptEdits|auto|bypassPermissions|default|dontAsk|plan`；`-p` 起始固定 default；`--dangerously-skip-permissions` ≡ bypass，root 下拒絕。使用者層 hooks 會在 `-p` 裡跑，建議 `--setting-sources project`。
5. 政策：官方把 `-p` 定位為 Agent SDK 的 CLI 形態；SDK 文件明文「未經核准，第三方不得在產品中提供 claude.ai 登入或額度」。用管理者訂閱憑證跑 MCP 服務是 ADR（票 08）必須記錄的灰色取捨。
