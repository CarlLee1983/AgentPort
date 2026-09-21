# Prototype：在本機跑通一輪派工

Type: prototype
Status: resolved
Blocked by: 04
Map: ../map.md

## Question

用最小程式在這台 Mac 對一個暫存資料夾各跑一次 Claude 與 Codex 的單輪任務，觀察事件流、session 續接與 diff 摘要，驗證 Driver 介面草案是否站得住。丟棄式。

## Answer

未另寫丟棄式 prototype：它要回答的問題由正式實作的真 CLI 測試（`AGENTPORT_REAL_CLI=1`）直接回答。Driver 介面站得住（建置票 04 / 05 的單輪與事件流測試）；session 續接成立（建置票 07：Claude `--resume`、Codex `exec resume` 第二輪記得第一輪）；diff 摘要形狀為 `git diff --stat --relative` 加 untracked 補列與 `{ sha, subject }[]` commits（建置票 03）；被殺後能否 resume 由建置票 10 實測（見票 10）。
