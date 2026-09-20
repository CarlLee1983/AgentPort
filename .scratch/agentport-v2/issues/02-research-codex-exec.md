# Research：codex exec --json 執行面

Type: research
Status: open
Map: ../map.md

## Question

AgentPort v2 要以子程序方式驅動已登入的 `codex` CLI（0.155.0）。需要確認：(1) `codex exec --json` 的 JSONL 事件 schema、結束訊號與 exit code；(2) `codex exec resume` 的用法與 session 識別；(3) `--sandbox` / `--full-auto` / approval policy 各選項在非互動下的行為，以及需要人工批准時會怎樣（阻塞？中止？）；(4) 認證：`~/.codex/auth.json` 的 ChatGPT 登入在非互動、由服務管理器啟動的程序下是否可用，與 API key 模式的差異；(5) 是否有能取得「本輪改了哪些檔案」的官方事件。以官方文件與本機實測為準。
