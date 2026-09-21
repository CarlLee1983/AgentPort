---
status: accepted
inherited_from: ../../../AgentPort/docs/adr/0002-task-records-survive-restart.md (v1, 2026-09)
---

> 自 v1 原樣繼承；第一段「重啟後可用原 task id 查詢紀錄與最後已知狀態」精神不變，
> 第二段已由 [ADR-0011](0011-same-user-subscription-credentials.md) 取代。

# 任務紀錄跨服務重啟保留

遠端交辦方需要在 AgentPort 重啟後，以原任務 ID 查詢紀錄與最後已知狀態，因此不採既有草案中僅保存記憶體狀態的方案。重啟後須核對執行情況；不能確認時明示結果未知，不自動重跑可能已產生副作用的工作。

重啟後保留尚未開始的佇列，但先暫停，待交辦方確認；先前執行中或等待回答的任務先核對，不自動重送給 Runtime。

此產品選擇增加持久化與故障核對責任，但不承諾自動恢復 Runtime 或精確一次執行。儲存及核對方案已具體化於 v1 的 Technical Design 文件（v1 專有，v2 沒有對應檔案）與[交易儲存 ADR](0003-local-transactional-task-store.md)；後者是待實作驗證的技術提案，不等於產品基線尚未確認。v2 的實際落地見 [`specs/agentport-v2.md`](../../specs/agentport-v2.md)「Task 狀態模型」一節。
