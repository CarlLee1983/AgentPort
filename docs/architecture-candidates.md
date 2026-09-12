# AgentPort v0.1 架構候選

歷史探索文件：其 A2A 優先、記憶體狀態與忙碌拒絕等選項已由後續[已確認需求](delegation-requirements.md)取代；目前設計以 [Technical Design](technical-design.md) 為準。本文保留探索背景，不作實作規格。

狀態：討論草稿，尚非 Technical Design 或 Implementation Plan。本文依使用者提供的 v0.1 構想整理；建議不代表已批准的介面或技術決策。

2026-09-12：已依使用者要求進入 [Technical Design](technical-design.md)。本文件保留架構探索背景；具體契約以 Technical Design 為目前審閱稿，未決信任模型仍未獲批准。

本階段只定義概念、系統邊界、分層、模組責任、資料流與擴充點。不得據此建立程式骨架、安裝套件或實作 Driver。詞彙以 [CONTEXT.md](../CONTEXT.md) 為準。

## 問題與範圍

AgentPort 解決遠端系統如何以穩定 Agent 身份，在目標主機上提交、追蹤及取消 AI coding 工作。管理者決定 Agent 的 Workspace 與 Runtime；遠端使用者只選擇自己獲准使用的 Agent。

Runtime 替換應維持對外 Agent 身份及共同工作語意，但不保證模型行為、可選能力或既有 Runtime Session 可跨工具移轉。AgentPort 不應宣稱不同 Runtime 的結果等價。

排除 MCP Server 實作、Agent delegation、workflow engine、自動 Runtime 選擇、多 Runtime 協同、PR/CI 自動化、容器或 Kubernetes 排程、動態 Workspace、通用遠端 shell、Web UI、資料庫與 queue infrastructure。管理者預先配置 Workspace，不由請求建立或改綁。

## 最小責任分層

以下是責任邊界，不是必須逐一建立的 class、資料夾或服務。

| 邊界 | 擁有的責任 | 不應擁有的責任 |
| --- | --- | --- |
| A2A Adapter | 協定驗證、Agent Card、協定 ID 與事件轉譯、HTTP/SSE 呈現 | CLI 輸出解析、工作目錄選擇、另一份 Task 狀態機 |
| AgentExecutionService | 執行入口、授權檢查、固定執行綁定、Task 狀態、取消與續接協調、事件發布 | A2A/MCP SDK 型別、特定 Runtime 指令 |
| Agent Registry | 經驗證的 Agent 定義與綁定查詢 | 執行程序、Context 續接、Task 狀態 |
| Driver Registry | 依識別取得 Driver 與其能力 | Agent Registry、Task 排程或 Session 生命週期 |
| Runtime Driver | Runtime 操作、原生 Session handle、原生輸出正規化、停止機制 | 呼叫者授權、公開 Artifact 決策、全域 Task 狀態 |
| 執行資源管理 | 活躍資源登記、停止與 shutdown 清理 | 推論工作成功、協定事件轉譯 |
| Task 儲存邊界 | 保存與讀取核心工作狀態 | 決定狀態轉移是否合法 |

建議以 AgentExecutionService 作為唯一應用層入口及 Task 生命週期擁有者。TaskManager 若保留，只作為其內部協作者，不能與 RuntimeManager 同時決定 Task 終態。

目前沒有必要同時承諾 RuntimeService、RuntimeManager、TaskManager 三個公開協調層。先以單一應用服務表達責任；當 Session 或資源管理出現獨立規則，再決定內部拆分。AgentResolver 可先是 Registry 查詢的一部分。

名稱統一為 Driver Registry，避免把 RuntimeRegistry 誤解成正在執行的 Runtime instance 清單。原提案的 RuntimeRegistry 與 Driver Registry 視為同一項候選責任。

## 核心關係與穩定綁定

一個 Agent 綁定一個 Workspace 與 Runtime 設定。接受 Task 時，應固定這次工作的 Agent 設定版本、Workspace、Runtime 與執行政策；執行中修改設定不能讓工作或取消操作改指向另一個 Runtime。

一個 Context 可關聯多個 Task；Task 不等於 Session。一個 Task 可能等待輸入後繼續，也可能已完成後由新的 Task 延續脈絡。外部 Context ID 不直接當作 Runtime Session ID。

候選續接綁定至少涵蓋呼叫者／授權範圍、Agent、Context、Workspace 綁定及 Runtime 設定版本。單獨使用 contextId 作為全域索引，會讓不同 Agent 或呼叫者誤用他人的 Session。

將同一 Agent 從 Codex 切到 Claude 時，既有 Task 仍使用原綁定；新的工作使用新設定。舊 Session 的後續請求應明確回報不能續接或另開脈絡，不能暗中假裝移轉成功。這個產品行為仍待確認。

候選並行政策：同一 Runtime Session 同時僅允許一項主動工作；共用 Workspace 的 Agent 也需共同考慮寫入衝突。v0.1 可優先採忙碌即拒絕，避免尚未定義隔離就允許並行修改；不需因此引入 queue system。

## Task、事件與續接

核心只有一份 Task 狀態事實，A2A Adapter 將它映射成協定狀態。可以對齊 A2A 語意，但核心不能依賴 SDK 型別或另存一份會漂移的 A2A Task。

候選主路徑：接受並記錄工作 → 啟動 Runtime → 執行中 → 完成、失敗或取消。啟動失敗也必須能將已接受 Task 收斂為失敗。

取消是請求，不等於已取消。只有確認執行已停止後才能發布取消終態；自然完成與取消競爭時，由生命週期擁有者裁定一次。無法確認停止時必須保留不確定性，不能對外假報成功取消。SSE 斷線不等於使用者取消 Task。

核心需能表達「等待輸入」與「已請求取消／停止中」等非終態語意；它們不是完成或失敗的別名。精確狀態名稱與 A2A 映射留待 Technical Design。

Driver 回報 Runtime 事實；應用服務判斷 Task 轉移、產出存取與事件可見性。僅在語意不同時區分 RuntimeEvent 與 ExecutionEvent，例如原生檔案變更經審核後才成為 Artifact；純粹一對一換名不值得建立第二套事件模型。

訊息需要區別增量與完整內容；工具輸出與檔案變更是可選遙測，不要求每個 Runtime 憑空生成。缺乏特定遙測不能被誤認為工作失敗。事件順序、終態只發布一次與重複通知處理需在 Technical Design 定義。

permission_required 不應僅轉成 INPUT_REQUIRED 就結束設計。使用者補充工作內容與授予執行權限是不同動作；後者需要可識別的請求、回覆通道、授權主體與拒絕／逾期語意。沒有可靠往返能力時，候選行為是明確失敗，絕不自動批准或無限等待。

## Driver 擴充邊界

Driver 的最小共同責任是啟動工作、提供可靠結果與失敗訊號，以及可驗證的停止行為。串流、續接、互動式權限與工具事件依能力宣告，不能一面宣告 resume 可選，一面要求所有 Driver 都有可成功執行的 resume 操作。

需區別延續已結束的對話、恢復中斷的工作、回答正在等待的輸入。它們不能只靠一個名稱模糊的 resume 操作概括。能力也應反映實際安裝版本及整合模式，而非僅由品牌固定。

SDK、結構化 CLI、ACP 都屬 Driver 內部選擇。不同模式的能力不同時，fallback 不可靜默降級。新增 Driver 的穩定承諾限於既有共同契約；全新互動語意可能需要擴充核心能力模型，不能承諾任意未來 Runtime 都永遠只改一個 Driver。

對外能力應取 Agent 宣告、Driver 實際能力及部署政策允許範圍的交集。切換 Runtime 後，Agent Card 不能繼續宣告已不支援的能力。

原先 start 完才呼叫 events 的候選介面，需避免訂閱前遺失事件；resume 只回傳完成通知也不足以表達該次工作的事件與停止範圍。Technical Design 應比較每次工作取得一個含事件與停止語意的執行 handle，無須現在固定 TypeScript 介面。

程序只是執行資源的一種。SDK 若自行管理程序，應由 Driver 提供等價的停止與清理保證；不能假設所有 SDK 都能走同一個 spawn 包裝器。長生命週期程序可服務多個 Session，停止一項工作不得誤殺其他工作；整體 shutdown 才負責全部資源收斂。

## 遠端呼叫與回程

1. Transport 入口驗證身份與請求格式，產生可信呼叫者資訊。
2. 應用服務檢查呼叫者對 Agent 的執行權限，解析並固定工作綁定，驗證能力及並行限制。
3. 記錄 Task，再要求對應 Driver 啟動工作；遠端請求不能覆寫 host path、binary、原生 Session handle 或任意 Driver options。
4. Driver 在指定 Workspace 執行，輸出共同語意的事件。
5. 應用服務更新 Task、處理可公開產出並發布事件；Adapter 轉成 A2A 回應或 SSE。
6. 查詢、訂閱、取消、輸入回覆及 Artifact 讀取皆重新檢查 Task 所屬授權範圍；知道 taskId 不代表有權操作。

未來 MCP Adapter 使用相同應用入口、可信身份與核心工作識別，不直接存取 Driver 或繞過授權。MCP 的同步／非同步呈現與 capability mapping 留待未來設計；現在不建立空 Adapter 或 MCP 特定模型。

此處 MCP Adapter 專指外部 Client 透過 MCP 呼叫 AgentPort。Runtime 自己連接 MCP 工具是另一個方向，屬 Runtime 配置與 Driver 整合責任，需獨立處理憑證及網路政策，不能與對外 Adapter 混為一談。

## 安全邊界

Workspace 綁定、realpath 與 isDirectory 檢查，能驗證啟動目標；它們不是 OS 權限隔離。Runtime 開啟 shell 後仍可能讀取其他目錄、使用主機憑證或連線外網。自然語言指令也可能要求 Runtime 執行 shell；AC-07 應限定為「遠端不能直接覆寫執行配置」，不能推論成沒有 shell 風險。

需先選擇信任模型：受信任操作者以服務帳號權限執行，或接納不受信任請求並提供真正的隔離。若選前者，須明確承認工作可能觸及服務帳號可存取的資源；若選後者，隔離是啟用遠端執行前的前置條件，而非之後補強。

受信任模式仍建議以專用低權限服務帳號部署，並由主機管理者控制 executable 與可繼承的環境變數。日後若需要不同隔離等級，可評估主機管理者定義的執行政策組合；目前不建立額外抽象或配置格式。

呼叫者可信不代表 Workspace 文件、外部抓取內容或工具輸出可信。這些內容可能誘導 Runtime 執行超出原意的操作；信任模型也必須涵蓋工作內容來源，低權限帳號用於限制可受影響的主機資源。

allowNetwork／allowShell 等政策只有在底層確實能強制執行時才能宣稱有效。不支援的限制應拒絕啟動，不能當成傳給模型的建議文字便視為已落實。

公開 Artifact 需處理授權、路徑逃逸、symlink、敏感內容與大小限制；file_changed 本身不是公開授權。Agent Card 隱藏主機路徑，也不能保證模型訊息或工具輸出不洩漏同樣資訊。

Bearer Token 用於身份驗證，不自動解決 Agent／Task／Artifact 授權。Agent Card 與 health 的公開程度也要明確，公開 health 不宜包含 Runtime 安裝或認證細節。

日誌預設只記錄核准的識別、狀態、耗時等 metadata。Prompt、Runtime 訊息、工具輸入輸出、CLI 參數、環境變數及錯誤內容預設視為敏感資料，不直接寫入日誌；除錯資訊的開啟、過濾及保留政策另行定義。

HTTPS 的終止位置與信任代理邊界尚待決定。監聽所有介面不等於僅接受 Tailscale 流量；需由實際網路暴露與存取控制保證。

## 暫存、重啟與運維語意

接受 in-memory Task／Session，就必須接受程序重啟後 AgentPort 無法延續查詢與續接的限制；Runtime 自己留有 Session 不代表服務能恢復安全綁定。不得承諾 durable Task、可靠事件重播或 crash recovery。

正常 shutdown 可停止新工作並清理現有資源；異常崩潰的殘留工作是另一個問題。部署環境如何確保資源不在服務失去控制後繼續執行，需於遠端運行前確認。

Task／事件／Artifact 的保留期限、容量上限與健康資訊可見性仍需定義。儲存邊界可以替換，但不因未來可能持久化而先設計通用資料存取框架。

即使沒有 durable replay，狀態快照與即時訂閱的交接也不可遺失終態；慢速或多個 SSE 訂閱者不應控制 Runtime 的事件消費。是否提供程序存活期間的有限重播、請求重試去重，以及設定只在啟動時讀取或支援熱更新，仍是下一階段需明確界定的語意。

## 待確認的架構選擇

| 問題 | 建議起點 | 影響 |
| --- | --- | --- |
| v0.1 呼叫者與 Workspace／外部內容各自的信任範圍？ | 先限受信任操作者，仍視工作內容為可能不可信；明載主機帳號權限邊界 | 決定隔離與授權需求 |
| 同一 Workspace 是否允許同時修改？ | 先拒絕衝突工作 | 決定資源排他範圍 |
| Runtime 切換後如何延續 Context？ | 明確拒絕舊 Session 續接，要求開新脈絡 | 避免靜默遺失上下文 |
| v0.1 是否處理互動式權限？ | 無可靠支援時明確失敗 | 決定輸入回覆契約 |
| 是否接受重啟後失去 Task／Session？ | 接受且對外說明 | 決定暫存方案是否成立 |

## 本階段完成條件與後續查證

完成本階段代表：範圍與詞彙無歧義；每項核心責任有唯一擁有者；上述信任、並行、續接、權限與重啟選擇已確認；以取消競爭、Runtime 切換、跨 Agent Context、SSE 斷線與越界 Artifact 等情境檢查邊界成立。現在仍有待決問題，不宣告架構已定案。

使用者提供的套件版本、Node 最低版本、A2A SDK／協定版本、method 名稱、Cursor ACP 指令、Codex／Claude SDK 能力皆為未驗證技術候選。進入 Technical Design 時須以官方來源逐項確認，不能把本草稿當作支援事實。

原提案第 4 節目錄、第 5–24 節程式介面、第 28 節實作順序與可執行驗收，保留為後續階段輸入。本階段不照表建立檔案。安全、授權、Workspace 綁定與資源清理應在第一個執行流程成立前納入，而非等三個 Driver 完成後才補上。
