# Research：Claude Code 無頭執行面

Type: research
Status: open
Map: ../map.md

## Question

AgentPort v2 要以子程序方式驅動已登入的 `claude` CLI（2.1.278）。需要確認：(1) `claude -p` 搭配 `--output-format stream-json` 的事件 schema，特別是 AskUserQuestion / 權限詢問在非互動模式下如何呈現、task 如何得知「需要輸入」；(2) session id 如何取得、`--resume` / `--continue` 的語意與限制；(3) `--permission-mode` 各值與 `--dangerously-skip-permissions` 的行為；(4) 憑證在 macOS 存於 login Keychain、在 Linux 存於何處，由 launchd / systemd 啟動的非互動程序能否讀到；(5) 官方是否建議改用 Agent SDK 而非 CLI，兩者在上述各點的差異。以官方文件與本機實測為準。
