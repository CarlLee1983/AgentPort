# Driver 介面：兩個 CLI 的統一事件模型

Type: grilling
Status: open
Blocked by: 01, 02
Map: ../map.md

## Question

Claude 與 Codex 的子程序輸出要收斂成同一組 Driver 事件（開始、文字、工具使用摘要、需要輸入、完成、失敗）與同一組 Driver 操作（啟動一輪、在既有 session 續一輪、終止）。哪些差異必須暴露到 Task 層（例如 Codex 不會提問、Claude 的 permission 詢問），哪些由 Driver 吸收？Runtime Capability 要不要宣告？
