# AgentPort

AgentPort 將目標主機上的 AI Coding Runtime，以 Logical Agent 身份提供遠端工作執行能力。它負責將 Agent 對應至受管理的 Workspace 與 Runtime，不負責需求拆解、開發流程治理或多 Agent 協作。

## Language

**Caller（交辦方）**：
向 AgentPort 提交工作並取得結果的外部主體，可以是能使用 MCP 的 AI Agent；Grok bot 僅為例子，不限定產品。交辦方與 AgentPort 提供的 Logical Agent 是不同角色。

**Access Scope（工作存取範圍）**：
界定哪些工作可由同一組已授權交辦方共同存取的範圍。本人與自有 bot 可以共享範圍，但仍保有個別身分及操作紀錄。

**Logical Agent（簡稱 Agent）**：
遠端呼叫者選擇的工作身份，關聯一個 Workspace 與指定 Runtime。Agent 身份不等於底層 CLI 品牌，也不等於一次執行中的程序。
_Avoid_: 將 Agent 與 Runtime 或 Process 互稱。

**Runtime**：
實際理解指令並執行 coding 工作的 AI 工具，例如 Codex、Claude Code 或 Cursor Agent。Runtime 的能力與對話延續方式可能不同。
_Avoid_: 用 Runtime 指稱 Driver 或單一執行程序。

**Runtime Driver（簡稱 Driver）**：
AgentPort 與特定 Runtime 之間的整合邊界，將 Runtime 特有的操作與輸出轉成 AgentPort 可理解的語意。

**Execution Supervisor（簡稱 Supervisor）**：
負責放行或撤銷 Execution Generation、停止 Execution Unit 並提供停止證據的可信邊界。不同作業系統可有不同 Adapter，但不得改變核心停止語意。

**Workspace**：
由主機管理者指派給 Agent 的工作目錄範圍。Workspace 綁定表達工作應在哪裡進行，本身不代表 Runtime 無法存取其他主機資源。
_Avoid_: 將工作目錄稱為 Sandbox。

**Agent Registry**：
主機管理者所定義之 Agent 與其工作綁定的權威目錄。它不是遠端呼叫者可自行登記執行目標的入口。

**Task**：
一項可追蹤狀態、結果與取消請求的工作單位。Task 身份與生命週期獨立於傳輸連線及底層程序。

**Execution**：
Task 的一次實際執行嘗試，具有自己的身份、授權世代與停止證據；它不等於 Task、Runtime Session 或作業系統程序。

**Execution Generation**：
可信監督為一次 Execution 保存的啟動授權世代。世代一旦撤銷便不能再啟動，停止完成必須同時證明該世代已封閉。

**Execution Unit**：
可信監督用來容納並核對一次 Execution 資源的邏輯單位。核心只保存其不透明身份，不把 PID、process group 或 cgroup 當成跨平台語意。

**Follow-up Task（追加任務）**：
沿用既有 Context 的新工作單位，與前項 Task 有各自的狀態及結果；澄清問題的回答不屬於追加任務。

**Clarification Reply（澄清回答）**：
針對某項 Task 所提出問題的回覆，屬於該 Task 的互動內容，不是另一項 Task。

**Context**：
將相關工作組織為同一段互動脈絡的邏輯識別。Context 並不保證任何 Runtime 都能延續先前的內部對話。

**Runtime Session**：
特定 Runtime 所持有的對話或執行脈絡，可否延續取決於該 Runtime 的能力。它不是 Task、Context 或程序識別碼的別名。

**Artifact**：
經 AgentPort 判定可提供給呼叫者的工作產出。Runtime 回報的任意檔案路徑或工具輸出，不會自動成為可公開的 Artifact。

**Runtime Capability**：
Runtime 在特定整合方式下可可靠提供的操作能力。宣告支援代表具有明確行為語意，不能只根據同名 CLI 選項推定。

**Protocol Adapter**：
外部協定與 AgentPort 工作語意之間的轉譯邊界。
