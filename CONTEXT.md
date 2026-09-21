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

**Workspace**：
由主機管理者指派給 Agent 的工作目錄範圍。Workspace 綁定表達工作應在哪裡進行，本身不代表 Runtime 無法存取其他主機資源。
同一主機上的 Agent 共用 Runtime 身分，彼此之間沒有機密隔離；需要隔離時應分主機部署。
_Avoid_: 將工作目錄稱為 Sandbox。

**Agent Registry**：
主機管理者所定義之 Agent 與其工作綁定的權威目錄。它不是遠端呼叫者可自行登記執行目標的入口。

**Task**：
一項可追蹤狀態、結果與取消請求的工作單位。Task 身份與生命週期獨立於傳輸連線及底層程序。

**Turn**：
Runtime Session 內的一次「prompt → 最終回覆」。一個 Task 恰好產生一個 Turn；Turn 結束時 Runtime 不會等待任何人，提問只會以最終回覆的文字形式出現。
_Avoid_: 用 Execution 或 Process 指稱 Turn；v2 沒有「同一 Task 的多次嘗試」。

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

**Deployment Readiness（部署就緒度）**：
主機管理者觀測一個 AgentPort 安裝能否接受並執行工作的運維判定，附帶原因與觀測時間。它不是 Task 或 Execution 的生命週期狀態；未觀測或已過期時視為未就緒，不得推定可執行。判定分為 installed（已安裝未啟動服務）、service-ready（可接受連線但不可執行）、execution-ready（可接受並執行新工作）與 recovery-blocked（需管理者處理復原後才能執行）。
_Avoid_: 以服務程序存活代稱可執行，或把就緒度寫進 Task 狀態。
