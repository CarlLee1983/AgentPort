# Task 取消與 Turn 逾時

Type: grilling
Status: resolved
Blocked by: 05
Map: ../map.md

## Question

Driver 有 `kill()`，v1 的停止證據已砍。v2 的「取消」保證到什麼程度：SIGTERM process group 後等多久再 SIGKILL？取消後 Task 記錄什麼（partial 文字、已發生的 file_change、git diff）？Runtime Session 在被殺後還能 resume 嗎（Claude session 檔在磁碟、Codex thread 在 `~/.codex`）？另外 Turn 要不要有設定檔層級的最長時間，逾時視同取消？

## Answer

以建置票 10 的實作定案：取消對 process group 送 SIGTERM，5 秒（常數）後 SIGKILL；Task → `cancelled`，一律帶 `error.code`（`cancelled` / `timeout`），`final_text` 取 `completed.final_text` 或已收到的 `message` 文字，仍跑 git 摘要；取消一旦接受即為終態 `cancelled`。`[server] turn_timeout_seconds` 預設 3600，逾時同取消流程、`error.code = timeout`。被殺後 resume 實測（2026-09-21）：Claude 可 resume 且記得（2/2）；Codex 不穩定（3 次中 2 次完成但忘記、1 次 `session_unresumable`），服務層不抹平。細節見 spec「取消與逾時」。
