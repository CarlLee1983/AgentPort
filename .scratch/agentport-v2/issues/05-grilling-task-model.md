# Task 狀態模型與 follow-up 語意

Type: grilling
Status: open
Blocked by: 04
Map: ../map.md

## Question

定義 Task 的狀態集合（含 needs_input）、Context 與 Runtime Session 的對應、follow-up 在 session 無法延續時的行為、同一 agent 的序列化佇列、服務重啟後未完成 task 的處置（v1 的 recovery 砍掉後要留什麼）。更新 CONTEXT.md。

票 04 定案後新增：兩個 runtime 都永不等待、提問只會是最終回覆的文字，`needs_input` 是否還需要是獨立狀態？若砍掉，caller 如何辨識「這輪其實在問我」（只靠文字？由服務層用 heuristic 標記？不標記）？
