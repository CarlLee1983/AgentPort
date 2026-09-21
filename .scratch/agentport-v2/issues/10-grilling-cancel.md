# Task 取消與 Turn 逾時

Type: grilling
Status: open
Blocked by: 05
Map: ../map.md

## Question

Driver 有 `kill()`，v1 的停止證據已砍。v2 的「取消」保證到什麼程度：SIGTERM process group 後等多久再 SIGKILL？取消後 Task 記錄什麼（partial 文字、已發生的 file_change、git diff）？Runtime Session 在被殺後還能 resume 嗎（Claude session 檔在磁碟、Codex thread 在 `~/.codex`）？另外 Turn 要不要有設定檔層級的最長時間，逾時視同取消？
