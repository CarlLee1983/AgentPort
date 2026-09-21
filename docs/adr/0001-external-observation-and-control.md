---
status: accepted
inherited_from: ../../../AgentPort/docs/adr/0001-external-observation-and-control.md (v1, 2026-09)
---

> 自 v1 原樣繼承。v2 保留「查詢與取消獨立於工作輸入佇列」的核心語意：`get_task` /
> `list_tasks` / `cancel` 是 MCP tool 的外側操作，不會排進 Scheduler 的 FIFO 佇列，
> 一個 agent 卡在某個 Turn 不影響對它查詢或取消。v1 專有的「聊天入口」、獨立
> execution worker、可信 launcher 等跨程序隔離機制在 v2 不適用——v2 沒有 launcher，
> Driver 是 `createApp` 直接管理的子程序，不是另一支由控制 daemon 操作的常駐程序。

# 查詢與取消獨立於開發輸入佇列

開發 Runtime 或交辦方模型可能長時間忙碌或卡住。AgentPort 的狀態查詢與取消必須由外側操作處理，不能排入 Runtime 的工作輸入佇列；聊天入口也須提供不依賴交辦方模型完成當前工作的直接操作。一般追加要求可以排隊，澄清回答送往對應等待點。

這保留核心明確的操作語意，代價是入口必須區分工作輸入與控制操作，不能將所有訊息一律轉交 Runtime。自然語言判讀由交辦方負責；外側回報須區分存活、進展與觀察可用性，不能把舊快照或連線心跳當作工作正常的證據。

技術設計以每次 execution 的獨立 worker 執行 SDK，控制 daemon 保存投影並操作可信 launcher。單程序中的非同步函式不足以隔離 SDK 的同步卡死；此分離增加 IPC 與停止核對責任，但不引入跨主機 broker 或排程服務。
