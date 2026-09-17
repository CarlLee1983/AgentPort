# AgentPort v0.1 Technical Design

日期：2026-09-12。依[已確認需求](delegation-requirements.md)整合的可審閱設計；S0 已固定相容工具鏈，以下產品選擇仍須通過實作驗證。本次平台決策只更新設計與後續 Story，沒有新增產品程式、Runtime 執行或部署。

詞彙：[CONTEXT.md](../CONTEXT.md)。來源：[技術依據](technical-evidence.md)、[MCP](mcp-evidence.md)、[Claude](claude-evidence.md)。[架構候選](architecture-candidates.md)是歷史探索，不再定義首版行為。

## 1. 範圍與設計選擇

首版是通用 MCP 交辦方 → AgentPort → Linux 上的 Claude Code。交辦方選工作與 Agent，AgentPort 擁有任務執行、查詢、排隊、澄清往返及取消。Grok bot 僅為交辦方例子；不建立品牌專屬入口。macOS 支援 platform-neutral development 與 verification，但不支援 native Runtime execution 或 deployment；A2A、Codex／Cursor Driver、排程、LINE／Telegram、需求拆解及跨 Agent 協作不列入首版交付。[平台決策](adr/0004-linux-execution-macos-development.md)

| 選擇 | 設計與理由 |
| --- | --- |
| 一份核心任務事實 | AgentExecutionService 擁有狀態及合法操作；Adapter、Driver 不另建 Task 狀態機 |
| 外側控制 | 控制 daemon 與每次 execution 的 worker 分開；Runtime SDK 不在控制 daemon 事件迴圈執行 |
| 單主機持久化 | 本機 SQLite、短交易及單一寫入通道；保存 Task、問題、事件、操作去重及 Workspace claim |
| MCP 普通工具 | 提交立即回應用 Task ID，再以獨立工具查詢；不依賴 MCP 原生 Tasks、elicitation 或長時間懸掛的 tools/call |
| 固定綁定 | 管理者預設 Agent → Workspace／Runtime／政策；呼叫者不提供主機路徑、binary 或 Driver options |
| 工作順序 | 同 Workspace 一項執行，等待回答也占用；不同 Workspace 可並行；追加要求是同 Context 的新 Task |
| 信任模式 | 本人及明確授權 bot，共享授權範圍但各有身分；Runtime 用專用服務帳號，不提供各 Agent 間檔案／憑證硬隔離 |
| 交付 | 修改、測試、回報為預設；推送及 PR 依任務／專案規則；文字及結構化摘要，不提供任意檔案下載 |

版本設計基線：Node 24、MCP revision 2026-07-28、官方 MCP v2 packages 2.0.0、Claude Agent SDK 0.3.269；版本存在的查證見來源，尚未通過組合測試。實作固定 exact patch、lockfile、Claude binary 與 SQLite binding／內嵌 SQLite 版本；不能使用浮動 latest。SQLite WAL 需包含官方列出的修正，例如 3.51.3 或後續版本，不能由 binding 名稱推定已修正。

## 2. 責任與執行邊界

| 邊界 | 擁有責任 | 不得擁有 |
| --- | --- | --- |
| MCP Adapter | 每請求協定驗證、工具 schema、可信身分、結果及錯誤轉譯 | 工作排程、Runtime 解析、另一份 Task 狀態 |
| AgentExecutionService | 授權、綁定、狀態轉移、問題回覆、排程資格、取消與恢復 | vendor SDK 型別、阻塞 Runtime 呼叫 |
| 持久儲存 | 短交易、唯一約束、revision 比對、快照及事件讀取 | 自行重播 Runtime 命令 |
| Registry | 管理者設定、Agent／Driver 能力及固定 Workspace | 遠端自助建立執行目標 |
| Runtime worker／Driver | Claude SDK、原生 Session、輸出正規化、回答傳遞 | 寫核心資料庫、發布 Task 終態、取得 AgentPort 憑證 |
| Execution Supervisor interface | 放行已持久授權的 generation、撤銷／停止、重啟核對及不透明 Execution Unit／Stop Evidence | OS-specific 名稱、通用遠端 shell、模型成功判定 |
| Linux Supervisor Adapter | 以 cgroup v2 建立／停止 Execution Unit 並提供 unit empty 證據 | Task 狀態、Runtime credential、macOS 支援宣告 |

SQLite 同步呼叫若由 binding 提供，放在專用資料庫 worker；查詢用獨立短讀取通道，不排在 Runtime 或長寫入後面。首版不引入 broker、跨主機 lease 或多控制 daemon。控制 daemon 只處理有界訊息；Runtime 輸出需限制大小及速率，不能讓 stdout、JSON 解析或 checkpoint 阻塞外側查詢。worker 出錯不等於控制 daemon 出錯；控制 daemon 無法連線時由 Client 明示觀察不可用。

## 3. 身分、綁定與持久資料

以下是資料契約，並非已建立的 SQL schema。

| 資料 | 核心內容與約束 |
| --- | --- |
| Principal | principalId、accessScopeId、允許 Agent／操作；只來自認證設定，不取自工具輸入 |
| Task | taskId、contextId、agentId、accessScopeId、createdBy、instruction、revision、state、reason、時間、結果、predecessorTaskId、queueOrder |
| BindingSnapshot | 配置 revision、Workspace identity、Driver／整合版本、政策及非秘密配置；內部資料，不回傳主機路徑或憑證 |
| Context | 固定 Agent／scope／binding、續接 reference、queue pause reason、revision；不等於 Runtime Session |
| Execution | executionId、taskId、daemon epoch、generation、可信且不透明的 Execution Unit ID、開始紀錄、最後提交 ordinal、候選結果、停止證據 |
| Workspace claim | canonical Workspace identity 唯一，記 taskId／executionId；不是會自動到期放行的 lease |
| Question | questionId、taskId、executionId、問題及答案 schema、expiry、pending／accepted／closed、首個答案、actor、delivery |
| Operation receipt | scope、operationId、操作類型／目標、初始輸入 fingerprint、actor、結果；跨重啟去重 |
| Event／Audit | Task seq、scope-global event cursor、revision、類型、時間、核准內容；操作另記 actor、入口及結果，不保存 token |

scope 與建立者分開；本人及 bot 可以同 scope、不同 principalId。每次 get/list/events/reply/edit/cancel/resume 都檢查當前 membership 及 Agent 權限；知道 ID 不構成授權。紀錄保留實際 actor，不共用 token 假裝不同身分。

Workspace 啟動時 realpath 並驗證目錄 identity；相同目錄共 claim，祖先／子目錄重疊配置拒絕。執行前再核對，路徑被換掉或配置變更則暫停相關 Task，不偷偷改綁。限管理者控制的本機目錄；不承諾辨識任意 mount alias 或約束外部人類工具。

接受時固定 BindingSnapshot；執行前再檢查授權、目錄、能力及政策。Context 的 Agent／scope／binding 不由後續請求更換；Runtime 切換或原生 Session 失效要回 continuation_unavailable，不默默開始空白對話。

## 4. MCP 入口與工具契約

對外採單一 HTTPS Streamable HTTP endpoint、2026-07-28 每請求自含協定資料的無狀態模式；依官方 SDK 驗證 protocol version、client info 及 capabilities。此 revision 不沿用舊 initialize／initialized／Mcp-Session-Id 生命週期。首版不另實作 legacy fallback；Client 必須支援所選 revision，通過測試後才擴充相容矩陣。[MCP 依據](mcp-evidence.md)

初期以可預配置獨立 bearer credential 的受信任 Client 驗收。這是明載的 Client 相容性條件，不宣稱所有 MCP Client 都可直接使用，也不將固定 token 說成完整 MCP OAuth。需要 OAuth discovery 的 Client 須另整合受保護資源 metadata／認證來源與 token 驗證，不能改成共用 token 或匿名入口。

下表是 AgentPort 應用工具，不是 MCP 標準 method。成功輸出提供符合 outputSchema 的 structuredContent，並附同內容 JSON TextContent；不用自由文字判斷成功。

| 工具 | 主要輸入 | 結果／限制 |
| --- | --- | --- |
| agentport_list_agents | 可選分頁 | 授權 Agent、描述、可用性、能力；不含 host path |
| agentport_submit_task | operationId、agentId、instruction、可選 contextId／executionLimitSeconds／inputWaitSeconds | 持久化後回 Task snapshot；新 Context 由核心建立 |
| agentport_get_task | taskId | 已提交快照、觀察時間、待回答問題及結果；不呼叫模型 |
| agentport_list_tasks | 可選 agentId／state、cursor、limit | scope 內摘要、穩定分頁；預設不帶全文 |
| agentport_get_events | 可選 taskId、afterCursor、limit | scope 內已提交事件及 nextCursor，立即回傳，不等待新事件 |
| agentport_edit_task | operationId、taskId、expectedRevision、instruction | 只改未執行的 queued／paused Task；不可改 scope／Agent／Workspace |
| agentport_reply | operationId、taskId、questionId、answer | accepted／already_accepted、delivery 及快照；不表示已繼續執行 |
| agentport_cancel_task | operationId、taskId | 記錄取消意圖後即回快照，停止結果另查 |
| agentport_resume_context | operationId、contextId、expectedRevision、continuationMode=preserve／fresh_session、fresh 時的 contextSummary | 原子解除可解除的 Context blocker，將符合資格的 paused→queued；只派送未開始的 Task，fresh 明確放棄原生對話續接 |
| agentport_acknowledge_interruption | operationId、taskId、expectedRevision | 僅在資源已證實停止後，將恢復未知的舊執行結案為 interrupted；不宣稱成功或重跑 |

mutation 使用 application operationId；JSON-RPC request id 只關聯協定回應。相同 operationId／初始請求回原 receipt，不同請求回 conflict。schema 拒絕未知且影響執行的欄位；instruction 以結構化輸入傳入，不作 shell 插值。首版輸入限文字；URL 是任務文字，Adapter 不自動抓取附件。

HTTP 斷線／取消該次 MCP request 不撤銷已 commit Task。回應遺失使用相同 operationId 取得原 Task；只有 cancel_task 是持久工作取消。所有 tools/call 都是短操作，不依賴原生 MCP Tasks、elicitation 或 background extension。Client 可以每 2–5 秒查詢，退避加 jitter；「好了沒」轉為 get_task，不提交新工作。未來聊天入口須有不依賴忙碌交辦方模型的直接查詢／停止操作。

## 5. 接受、修改與佇列

submit 交易驗證 scope／Agent、schema、receipt、Context、能力、容量；建立 Task=queued、queueOrder、predecessor、receipt 及 accepted event，一起 commit，之後才回 taskId。未 commit 不啟動 Runtime；同 Context 新 Task 接在最後一項已接受 Task 後面。

dispatcher 挑未暫停 Context 的最早 eligible Task；短交易再核對授權及 binding、取得唯一 Workspace claim、建立 executionId、queued→starting；commit 後才交給 launcher。沒有跨 Runtime I/O 的交易。claim 與 launch 之間 crash 也進恢復核對，不假設一定尚未執行。

Execution Supervisor 是核心與 OS-specific execution control 之間的 seam。其小型 interface 只有三項責任：`start` 只接受核心已持久授權的 Execution Generation 並回不透明 Execution Unit ID；`revokeAndStop` 先永久封閉 generation，再 cooperative／forced stop，且只在 generation 不會再放行及 unit 已空時回 Stop Evidence；`reconcile` 在 daemon 或 Supervisor 重啟後，雙向核對核心已知 Execution 與 Supervisor ledger／Execution Unit。呼叫順序、generation fencing、同 execution 的 start／stop serialization、unknown／quarantine 與錯誤模式都屬 interface 契約，Caller 不需知道 cgroup、PID、process group 或 `launchd`。

每個 Supervisor request 都使用內部 Execution reference，至少綁定 executionId、不可變 generation、daemon epoch、管理者控制的 launch profile 與 canonical Workspace identity；unit ID 與 Stop Evidence 也綁定完整 reference，不可跨 generation／epoch 重用或由 MCP Caller 提供。`start` 對相同 reference 必須 idempotent，已撤銷世代不得建立 unit；transport timeout、ledger failure 或 reference mismatch 回 indeterminate／conflict，不可猜成尚未啟動。`revokeAndStop` 只有 stopped、pending 或 indeterminate 三種語意，not found 不等於 stopped。`reconcile` 必須撤銷舊 epoch、收斂 ledger-only／unit-only orphan，且不啟動、resume 或重播 worker；任何未知狀態都保留 claim、quarantine Workspace 並阻擋 dispatch。

Supervisor 必須持久保存 generation 的啟動／撤銷狀態。任何啟動先登記 generation，只有仍獲准的 generation 能放行 worker；撤銷即使早於 start 到達也要保存不可再啟動的紀錄。stop 確認須同時證明「Execution Unit 已空」及「該 generation 的延遲／進行中 start 不可能再放行」。Linux Adapter 以 cgroup v2 提供 unit empty 證據；僅檢查尚不存在或暫時為空的 cgroup 不足以釋放 claim。

核心 commit cancel 或開始 recovery 後要求 supervisor 撤銷 generation，再停止及核對；撤銷確認前不發布已停止。supervisor 的核准／撤銷不得被延遲 launcher I/O 繞過；可在 vendor 執行前設受控放行點，但不能先執行再補 fence。supervisor 重啟先撤銷舊 epoch 未結 execution，再接受新啟動；狀態不明就拒絕啟動及停止確認。此為可信 launcher 必要契約，不是單靠資料庫 executionId 就成立。

同 Workspace 按 queueOrder 選最早 eligible Context 頭項；paused Context 不阻擋其他 Context，但未停止 execution／恢復 quarantine 擋住整個 Workspace。不同 Workspace 在全域容量內並行，不加入使用者優先權或搶占。

predecessor 成功才自動執行追加 Task。前項失敗、取消、interrupted 或恢復未知使同 Context 後續 Task 暫停。resume_context 在交易中記錄交辦方接受哪個已結束 predecessor 的部分成果，解除對應的失敗／取消／重啟 blocker，將符合資格的 paused→queued；不能清除未停止 execution、無效 binding、未授權等其他 blocker。

preserve 模式要求安全的原生續接 reference；不符則不改 queue、回 continuation_unavailable。交辦方可明確指定 fresh_session 及 contextSummary（可明確選擇空摘要），在同一邏輯 Context 開新原生對話，保留已接受 Task ID／順序；回應與事件明示原生對話不延續。核心不自行生成摘要、不重播舊指令，也不改 Agent／Workspace／政策。claim 時把舊 reference 標為使用中；成功且清理完才發布新 reference，失敗／取消／未知則失效，不能偷偷回退到更舊 Session。

queued／paused 修改用 expectedRevision compare-and-swap；與 dispatcher 競爭只有一方成功。輸入變更增 revision／事件，不改原 submit receipt 的 fingerprint；重送最初 submit 仍回同 taskId。取消未啟動 Task 可直接 canceled，並暫停 Context 後續要求。

queue 初值每 Workspace 32、全域未啟動 Task 256，paused 也計入。滿時拒絕新 admission，不丟棄已接受工作；get/reply/cancel 保留處理容量。這些是可調校初值，不是已量測的吞吐承諾。

## 6. Task 狀態與可觀察性

| 狀態 | 語意／操作 | Workspace 占用 |
| --- | --- | --- |
| queued | 已接受未派送；可改／取消 | 未取得 |
| paused | 從未啟動，因 Context／重啟暫停；可改／取消／解除暫停 | 未取得，仍可能被別的 execution 擋住 |
| starting | 已記 execution，正啟動；可取消 | 持有 |
| running | 正執行；追加建立新 Task，可取消 | 持有 |
| awaiting_input | 等待回答或首答案已接受、等待送達；pending 可回覆，accepted 不可換答案；皆可取消 | 持有 |
| stopping | 正結束／清理，stopReason 區分完成、取消、失敗或期限 | 持有直到確認停止 |
| recovering | 重啟或證據不完整，正在核對；不可重送執行／回答 | 持有或 quarantine |
| completed | 成功結果已提交且 execution 停止 | 釋放 |
| failed | 確認失敗並停止，保存 reason／部分產出 | 釋放，後續暫停 |
| canceled | 已取消且未啟動或已確認停止 | 釋放，後續暫停 |
| interrupted | 資源已停止但結果未知，交辦方已明確確認結案 | 釋放，後續仍暫停 |

主路徑 queued→starting→running↔awaiting_input→stopping→completed／failed／canceled。未啟動 queued↔paused，可直接 canceled；starting 失敗仍經清理確認才能 failed。先前非終態 execution 重啟後進 recovering，依完整持久證據核對至原終態，或經 acknowledge_interruption 至 interrupted。終態不因遲到事件改變。

stopping 不等於取消成功；stopReason=completion 表示成功候選已封存、正在清理。先 commit 的完成候選或取消意圖決定原因：完成候選先封存，後到取消回 too_late 及快照；取消先 commit，後到成功不能改 completed。deadline／政策失敗成立後同理不能被遲到成功覆寫。

停止確認失敗維持 stopping，health.stopConfirmation=unknown、readiness=degraded，保留 claim；HTTP timeout 不釋放。recovering/outcome_unknown 不套終態 TTL，交辦方不能以「當作成功」繞過停止證據。

快照分開回 lifecycle state、revision、reason、lastProgressAt、executionLiveness=alive／dead／unknown、livenessCheckedAt、observedAt、observationStatus=current／stale／unavailable、currentQuestion、result。currentQuestion 呈現 question.status 及 delivery：pending 表示尚待回答，accepted＋pending 表示答案已接受尚待送達，unknown 表示送達證據不完整。

另回 toolActivityStatus=active／idle／unknown、toolActivityObservedAt 及有界 toolActivityEvidence（核准工具名稱／開始時間，無參數、環境或完整輸出）。Driver 沒有可靠工具事件或證據失效時標 unknown，不從程序存活推定工具仍執行。疑似停滯事件帶相同證據，running 只是生命週期，不代表有新進展。

疑似停滯是 health 訊號，不是終態。running／starting 連續 10 分鐘無可觀察進展提示；awaiting_input 的 pending 顯示回答期限，accepted 顯示投遞經過時間並適用執行停滯觀察，queued／paused 顯示阻擋原因。worker 心跳、網路存活及實際工作進展分開，前兩者不刷新 lastProgressAt。

## 7. 澄清、回答與期限

Claude 首個整合必須完成同 Task 正向往返。官方 SDK 的 AskUserQuestion 與一般工具批准都進 canUseTool，Driver 必須按工具名稱分流：問題轉為 Question；一般工具依既定政策允許／拒絕，不變成遠端提權。核心先保存 questionId、taskId、executionId、原生 tool-use 關聯、問題／答案 schema、期限及 awaiting_input，再發布。worker 保留待決回呼；不把任意 assistant 文字的問號當作問題。[Claude 依據](claude-evidence.md)

進入純等待前須確認沒有仍執行的平行工具，否則不暫停執行時鐘或宣告純等待。首版 Driver 限制此類工具並行，或等其他工具靜止；固定 SDK 模式無法保證時，互動驗收不通過。Workspace 整段等待占用。AskUserQuestion 可能一次帶多題，Question 保存整個原生呼叫的有界問題集合，answer 須符合整組 schema，不分多次重複回原生 callback。

reply 交易驗證 scope、Task、Question、期限、答案 schema 及等待仍有效；首個答案保存 actor／hash／delivery=pending 及 receipt。同答案重送回已有結果，不新增投遞；不同後到答案回 answer_conflict。過期／取消／已關閉問題不能回答，不同 operationId 也受 questionId 唯一答案約束。

commit 後才送同 execution worker；worker 按 questionId 去重、驗證仍在等待，將答案交給原生回呼並回 ack。接受與送達分開記錄；awaiting_input→running 需 worker 已處理回覆證據。回答採用後、ack 前屬 delivery pending，不接受第二答案，仍受執行期限約束。

首答案 commit 時結束純等待計時，停用該問題的 input expiry，恢復累計執行時鐘；無 ack 時仍為 awaiting_input／accepted＋delivery=pending。過期判定只適用尚未回答的 pending Question，不能在答案已接受後因原 expiry 到期而錯殺。故障使送達證據未知時先禁止重送，再依 execution／控制證據進入停止或 recovering；最後答案及 delivery 仍可查詢。

服務或 worker 在投遞／ack 間故障時 delivery=unknown，保留首答案、不自動重送。原生回呼已遺失時不以 Session resume 假裝恢復；按恢復規則結案，交辦方另建 Task。SQLite commit 與 Runtime 回覆沒有跨程序 exactly-once 保證。

等待預設 24 小時，以持久 expiry 計算；到期關閉 Question、停止 Task，確認後 failed/input_timeout、後續暫停。reply 與 expiry／cancel 同交易邊界裁定，只有勝出者有效。回答不提高工具、網路、憑證或主機權限；超出固定政策回 policy_denied。

執行期限預設累計 60 分鐘，包含 starting、running、回答投遞期間，不含 queued／paused／已確認純等待。程序內 monotonic clock，持久保存已累計時間及階段；重啟不自動續跑。worker 有執行／等待期限副本，控制服務失聯由資源監督收斂，不允許無限執行。遠端期限只能在管理者配置的允許範圍內調整。

## 8. Claude worker、結果與停止證據

採官方 Agent SDK query 的 streaming input 模式；不使用已移除的 V2 session API。輸入串流與 includePartialMessages 輸出串流分開，不靠串流顯示推定可取消。SDK／CLI 都在 execution worker 內，Supervisor Adapter 在 worker／vendor 執行前建立獨立 Execution Unit，不依賴 SDK 自訂 spawn 才建立停止邊界；v0.1 Linux Adapter 使用 cgroup v2。

SDK 的 cwd、settingSources、resume 由固定管理者配置轉入，原生 Session reference 只由 Driver 產生；settingSources 空陣列不代表所有 managed policy／工作指令都被隔離。原生 callback、AbortController、版本特有控制方法均以固定型別／測試核對，不只憑方法名稱推定停止。

worker 事件帶 executionId、單調 ordinal、類型及有界 payload；核心只接受目前 execution 的連續序列。EOF、exit code 0、SDK promise resolve 不單獨代表成功。Session reference 只在 binding 相容、結果已保存且資源停止後才可提供下一 Task。

完成流程：worker 傳候選 outcome、finalOrdinal、摘要及續接 reference；核心確認所有 ordinal 已提交，保存候選並轉 stopping；worker 在核心確認保存後退出；Supervisor 回傳 generation sealed 且 Execution Unit empty 的 Stop Evidence；最後交易同時發布結果、終態事件、Context reference 及釋放 claim。不能先 completed 再補結果。

取消：持久保存意圖及 stopping，再要求 Supervisor 撤銷 Execution Generation 並送 cooperative cancel；5 秒未完成由 Adapter 強制停止 Execution Unit，再最多等 5 秒核對。API 不等待這 10 秒，立即回停止中；未確認 generation 已封閉且 unit 空，就保持 claim／degraded。SDK 的取消回應或 signal 已送出都不等於停止。

Linux Supervisor Adapter 掌握 cgroup 建立、migration、kill；Runtime 不取得控制權，亦不能改核心 DB／credential。cgroup 只保證本機 Execution Unit 停止，不隔離各 Runtime 同帳號檔案，也不撤回分支推送、PR 或外部服務工作；取消結果保存已知副作用及部分變更。

正常運行時 worker 死亡且無 outcome：取得有效 Stop Evidence 後 failed/runtime_lost。控制服務 crash 先 recovering，不因 PID 消失推測成功／失敗。Linux Adapter／SDK／子工具清理未通過測試，Agent 不列 ready。native macOS process group 可被建立新 session 的 descendant 逃離，`launchd` service 管理也不等於 generation sealed 加 unit empty；因此目前沒有 macOS Runtime Adapter，macOS S2 evidence 不沿用 Linux cgroup 保證。

## 9. 持久化、事件與恢復

SQLite WAL、foreign keys、FULL 同步、單寫入通道；檔案在控制帳號專用本機目錄，不放 Workspace。SQLite／binding 需含適用 WAL 修正；短讀取／交易與受控 checkpoint 延遲另測。S2 依 GATE-008 同時計算 DB／WAL 實際 bytes，並以同 filesystem、非 sparse、fsync 的 sidecar 實體配置 accepted-Task restart／cancel reserve；啟動時依持久 ledger reconciliation，無法補足則 fail closed。此保證限 AgentPort 控制的 artifact，不宣稱抵抗任意外部 host writer。[來源與限制](technical-evidence.md)

影響執行的狀態、receipt、問題、答案、claim、事件先 commit 再外部動作。寫錯／磁碟滿停止 admission／dispatch，不回已接受再補寫。資源監督可安全停止，但 DB 未恢復前不能假報持久取消或終態；get 可回快照並標 stale，無可靠快照則 observation_unavailable。

operationId 在 scope 內唯一、receipt 跨重啟保留。結果到期保留最小 tombstone，回 result_expired，不重跑舊 operationId；不存 prompt／答案全文。一般 tombstone 上限只阻擋新增工作類 mutation（submit／edit／resume），不阻擋既有 Task 的 reply／cancel／acknowledge 或結案。Client 新工作用新 ID，換 ID 不代表同一次安全重試。

接受 Task 時另預留有界的問題回覆、取消、恢復確認及終態 receipt／event 空間；提出新 Question 前先保留其首答案紀錄，相同答案重送不重新投遞。新問題或非必要操作將耗盡預留空間時，先拒絕增加負載、用已保留的停止／結案紀錄收斂，不能等取消來時才發現沒有空間。即使控制 reserve 因實體故障耗盡，也須停 admission／dispatch、由獨立 supervisor 停止 execution，回 unavailable 並保留 quarantine；不能假接受、丟紀錄或無限執行。此降級不宣稱所有磁碟故障下仍可持久化結果。

已提交事件有 scope-global cursor 及 Task seq，供輪詢通知；通知成功不控制核心狀態。get_events 短一致讀取回事件／cursor；scope／filter 綁 cursor。游標指向已過期資料回 cursor_expired，要求重查快照，不默默漏過完成事件。慢 Client 不阻擋 worker 消費。

啟動持有唯一 daemon 本機鎖並暫停 dispatch；短交易將 queued→paused、先前 active execution→recovering，保留 prior state。核對可信 execution unit；殘留先停止。不能確定單位範圍或停止狀態就 quarantine Workspace。啟動可提供 recovering 查詢，不能以 readiness=true 假裝已恢復派送。

完整持久候選 outcome、finalOrdinal 齊全且確認停止，可提交對應終態，但不自動解除 Context 的重啟 pause。無完整證據維持 recovering/outcome_unknown；確認資源停止後交辦方可 acknowledge_interruption 結案，仍明示未知，不重跑／還原檔案或保證外部副作用已停止。

resume_context 依第 5 節 preserve／明確 fresh_session 選擇處理原生對話，只解除該 Context 可解除的 blocker，不恢復啟動過的舊 Task 或未確認的舊答案。已接受的 queue 保持 Task ID 及順序，不因原生 Session 失效而無法處置。持久事件不作 Runtime 工具命令的重播清單。

## 10. 觀察、上限與保存

外側查詢正常情況 2 秒內是驗收目標；只讀已提交投影及有界健康快照，不等模型、worker IPC 或停止確認。DB 讀取超時回 stale／unavailable；Client 超過 5 秒連不上回無法取得最新狀態。這不是對整台主機或網路失效的成功回應保證。

| 項目 | 初值／行為 |
| --- | --- |
| 全域 active execution | 4；starting／waiting／stopping／recovering 的未釋放資源計入 |
| 單 Workspace | 1；等待保留 claim |
| queue 容量 | 每 Workspace 32，全域 256，paused 計入 |
| instruction／HTTP body | 64 KiB／128 KiB；接受前拒絕超限 |
| 問題／回答 | 各 32 KiB，符合問題 schema，不當作 Driver options |
| 單 Task 公開內容 | 1 MiB；進度有界摘要，另預留問題／控制／結案空間；最終結果不完整時明示 output_limit，不假報成功 |
| 查詢頁／回應 | `limit` 預設 50、最多 100，均為筆數上限而非保證筆數。terminal `agentport_list_tasks` 的 8 MiB（8,388,608 bytes，含上限）權威層是 AgentPort 產生的完整未壓縮 UTF-8 JSON-RPC response body，包含 JSON-RPC envelope、`structuredContent`、等值 JSON TextContent 及 echoed request ID 等有界 envelope 欄位，不含 HTTP headers、transfer framing、compression、TLS 或 proxy-specific encoding。若 requested/default count 超限，在 cursor 封存前選取可安全容納的完整 Task prefix，回 non-null `nextCursor`；沿 cursor 必須無重複、無遺漏取得餘項。不得切斷 summary、在較大頁 cursor 封存後才裁切、以 terminal cursor 省略項目，或為 page capacity 新增 `output_limit`。其他工具若要套用相同 wire contract，須有各自 worst-case Evidence 與核准 Story。 |
| 終態保存 | 結案後預設 30 天，可調；未結束、paused／recovering／停止未知不因 TTL 刪除 |
| 儲存 admission 預算 | 初值 2 GiB，另留 256 MiB 結案／控制空間；先拒絕新工作，不提早淘汰 30 天內結果 |
| 一般去重 tombstone | 初值最多 100,000；滿時拒絕 submit／edit／resume；既有 Task 控制另有預留容量，不以 TTL 打開重跑風險 |

以上為調校初值；需核算 JSON escaping、audit、DB 頁面及 WAL，不能以內容大小當磁碟上限。接受前保留問題／取消／終態空間；實體磁碟錯誤遵守第 9 節降級。

terminal `agentport_list_tasks` 的 capacity selection 僅在完成目前授權後進行；既有 scope／filter／retention cursor binding、foreign `not_found`、revoked `access_denied`、工具名稱、schema、public code 與 cursor format 不變，private instruction／result 不進 capacity evidence、audit 或 log。Caller 必須把 50／100 視為 requested upper bound 並沿 `nextCursor` 取完，不可假設成功頁一定回精確筆數。此契約不需 DB、schema 或 cursor migration；若日後回滾實作而恢復精確 50／100 筆，也會重新引入超過權威上限的 AgentPort response body，必須明示接受該 operational risk。完整決策與被拒方案見 [ADR-0005](adr/0005-terminal-summary-response-capacity.md)。

Context 至少保留至相關非終態與可查詢 Task 結案／到期，不沿用一小時自動遺失續接。原生 Session 是否續接仍看實際可用性；transcript 保存／刪除由管理者配置，不因清理 AgentPort 資料而刪供應商歷史。

完成結果包含摘要、變更檔案、檢查結果／證據、未完成事項、實際 commit／分支／PR 及已知副作用；Runtime 自述與服務親自驗證的事實分開標示。無 PR 或檔案變更不自動算失敗。模型文字／檔名可能含敏感資訊，只供授權 scope，不宣稱通用 DLP。

## 11. 錯誤、政策與認證

| 情況 | 外側行為 |
| --- | --- |
| 缺少／無效憑證 | HTTP 401，不進工具執行 |
| 不存在或無權 Task／Agent／Question | 同一 not_found，避免跨 scope 枚舉 |
| 未知工具／schema 錯誤 | MCP protocol error，不建 Task |
| queue 滿、revision／operation／answer 衝突、已開始不可改 | isError=true，穩定 code、安全重試資訊及授權後快照 |
| 已接受工作稍後失敗 | get_task 正常回 failed；不把查詢本身標工具錯誤 |
| 回答已接受但送達未知 | receipt／delivery=unknown；不回已繼續或重送 |
| cancel 已接受但未確認停止 | stopping／stopConfirmation=unknown，claim 不釋放 |
| 結果／cursor 過期 | result_expired／cursor_expired；不重跑、不默默跳過 |
| 儲存／觀察不可用 | unavailable／stale；不聲稱 mutation 已持久接受 |

credential 只由受保護服務配置解析，分別映射本人／bot，不進 Workspace YAML、Runtime env、工具結果或日誌。HTTPS 由可信代理終止、daemon 預設 loopback；非 loopback 暴露需明確 TLS／來源限制。HTTP Origin／Host、代理信任及 body 上限由入口驗證，不信任外部 forwarded identity header。

Runtime env 只提供該 execution 所需 vendor 憑證；核心 DB／credential／launcher 權限由不同受保護邊界持有。Runtime 可共用低權限帳號，不承諾相互檔案隔離。Workspace 文件、hooks、MCP 設定可能執行行為，管理者明確指定載入來源；prompt 限制不等於 OS 強制限制。

已允許的工具可正常執行；permission request 不等於 clarification。首版無遠端提權工具，不用 AskUserQuestion 答案授權任意 shell。日誌只記 allowlist metadata；S2 product audit 僅接收 allowlisted method／tool、已 normalize 的 protocol metadata、client metadata 的單向 SHA-256 fingerprints、衍生 Principal 與 stable outcome，不接收 raw client metadata、arguments、token、instruction、path、stack、cause 或 error message。audit ring 滿時依 GATE-010 覆寫最舊列並持久累計 gap counter；main-thread queue 受相同 capacity 限制，淘汰最舊 queued payload、保留最新，超額只合併為持久 gap count；gap retry 使用持久 idempotency key，late commit 不重複計數，連續失敗則明確終止 audit drain，但不阻擋 reserved Task control 或 storage close。audit 排程一次最多送一筆低優先 worker request。完整 prompt／答案存在授權資料區，stderr／argv／env 不直接輸出。

## 12. 運維、回滾與擴充

正常 shutdown 先停 admission／dispatch、暫停 queue；對活動 Task 停止，保存結果及未知狀態，再關 listener／storage。deadline 及 cgroup 清理由可信 supervisor 兜底，不只依賴 Node finally；非正常結束按第 9 節核對。

部署驗證包含專用帳號、DB／credential 權限、TLS、固定 executable、cgroup v2／Linux Supervisor Adapter 與 crash cleanup；正式部署契約見下方「Linux 部署契約」。readiness 區分能查詢與能派送；Agent unavailable 可列出，不接受違反其能力契約的工作。macOS development composition 不含 Runtime Adapter，不能對外宣稱可派送或 production-ready。

### Linux 部署契約

依 [ADR-0006](adr/0006-non-root-daemon-launcher-privilege-boundary.md)、[ADR-0007](adr/0007-runtime-api-key-official-claude-install.md)（安裝部分）、[ADR-0010](adr/0010-runtime-authorization-subscription-first.md)、[ADR-0008](adr/0008-bootstrap-digest-pinned-installer.md)、[ADR-0009](adr/0009-single-operator-dedicated-host-no-agent-isolation.md) 與 AP-020。本節是一鍵安裝、正式 daemon 入口與 `agentport` CLI 的共同契約；AP-021 已讓受控 Runtime composition 以非 root 執行並拒絕 uid 0；正式 daemon 入口、admin socket 與 Caller 管理仍由後續 Story 承接。

支援範圍只有單一管理者、只運行 AgentPort 的專用主機，平台為 Ubuntu 24.04 LTS／amd64／systemd／cgroup v2，其他組合由安裝器拒絕。同主機所有 Agent 共用一個 Runtime 帳號與 runtime-home，彼此沒有機密隔離；需要隔離時分主機部署。

程序身分：control daemon 以非 root `agentport-daemon` 執行；launcher 是唯一 root 程序，建立 per-execution ingress、保存 ledger，並以 `systemd-run --uid/--gid` 啟動 `agentport-runtime` 身分的 worker。daemon 與 launcher 之間以 launcher socket 群組權限認證，該群組只能包含 `agentport-daemon`；偏離時不得報告 execution-ready。

| 資源 | 位置 | 擁有者／mode | root launcher | agentport-daemon | agentport-runtime |
| --- | --- | --- | --- | --- | --- |
| 發行程式 | `/opt/agentport/releases/<version>`、`current` | root，不可被服務寫入 | 讀 | 讀 | 讀（worker entrypoint） |
| 設定 | `/etc/agentport/launcher.json` | root，無 group／other 寫 | 讀 | 無 | 無 |
| 設定 | `/etc/agentport/agentport.json` | root:agentport-daemon 0640 | 無 | 讀 | 無 |
| 受保護秘密 | `/etc/agentport/credentials/` | root 0700 | 讀；經 `LoadCredential` 傳遞 | 只經 systemd credential 取得 `cursorSecret`、`continuationEncryptionKey` | 只在 Execution 期間經 credential 取得 ingress token 與單次 resume 資料 |
| SQLite 與 control-reserve | `/var/lib/agentport/daemon/` | agentport-daemon 0700 | 無 | 讀寫 | 無 |
| launcher ledger | `/var/lib/agentport/launcher/` | root 0700 | 讀寫 | 無 | 無 |
| launcher socket | `/run/agentport/launcher.sock` | root:launcher 群組 0660 | 擁有 | 連線 | 無 |
| admin socket | `/run/agentport/admin.sock` | agentport-daemon:agentport-admin 0660，唯讀查詢 | 無 | 擁有 | 無 |
| ingress 目錄 | `/run/agentport/ingress` | root:agentport-ingress 0771 | 建立、驗證 | 驗證，建立 socket | 僅 traverse |
| per-execution ingress socket | ingress 目錄內 | agentport-daemon:runtime 群組 0660 | 無 | 建立、listen | 連線並以 token 認證 |
| runtime-home | `/var/lib/agentport/runtime-home` | agentport-runtime 0700 | 驗證 | 無 | 讀寫 |
| Workspace | `/var/agentport/workspaces/<agent>` 或管理者指定路徑 | Runtime 可存取 | 驗證 | 無 | 讀寫 |

Runtime 身分不能讀取 Caller token 雜湊、`cursorSecret`、`continuationEncryptionKey`、SQLite 或 ledger，也不能連線 launcher socket。

秘密與授權：安裝器只在首次安裝時產生 `cursorSecret` 與 `continuationEncryptionKey`，之後不原地輪替；秘密不出現在 argv、環境檔、SQLite 或一般輸出。Caller 以 `agentport caller add|list|revoke` 管理，主機只保存 token 雜湊，token 只在建立時顯示一次。Claude Runtime 首版沿用 GATE-020 的訂閱 OAuth：credential 只存在 Runtime 帳號 0700 的 runtime-home，driver 拒絕環境注入的 API key 或 OAuth token；只能使用管理者本人的訂閱，條款風險由管理者承擔，API key 路徑由後續 Story 補上（ADR-0010）。Claude Code 由官方 apt 套件庫安裝指定版本並 hold，發行 manifest 記錄已驗證版本範圍，不內附於發行包。

設定與生效：`launcher.json` 與 `agentport.json` 各帶 `schemaVersion`。Agent／Caller 類變更以驗證後的候選設定加 `SIGHUP` 觸發 Registry revision-fenced 替換，驗證失敗保留舊 revision；launcher 類變更只在沒有 active Execution 時允許重啟。MCP 預設監聽 loopback 3333，可設定；port 被占用即啟動失敗並回報原因，不自動換 port。`agent add` 建立 Runtime 擁有的新 Workspace，或只驗證既有路徑並提示修正指令，不做遞迴 chown／chmod。

Deployment Readiness 是主機層的運維判定，與上文 Task 快照中的 health／readiness 分開，也不是 Task 狀態：

| 等級 | 意義 | 接受新 Task |
| --- | --- | --- |
| installed | 程式已安裝，服務未運行或無法觀測 | 否 |
| service-ready | 可接受 MCP 連線與查詢，但缺 Agent、Runtime 授權、Claude 版本相容或 launcher 連線任一條件 | 否 |
| execution-ready | 上述條件皆成立、無待處理復原，且觀測未過期 | 是 |
| recovery-blocked | 有未完成 recovery、storage incident 或 quarantine 需管理者處理 | 否 |

每次判定附 reason code 與觀測時間；未觀測或過期一律不是 execution-ready。非 execution-ready 時提交 Task 以穩定錯誤碼拒絕且不建立 Task。零個 Agent 時 daemon 仍為 service-ready 並列出空集合。daemon 以唯讀 admin socket 回報就緒度；daemon 未運行時 `agentport doctor` 做離線檢查。預設檢查不發出付費 Runtime 呼叫，Runtime 授權只顯示「已設定、未驗證」；`agentport doctor --live` 是明確的付費驗證。

安裝信任鏈：每個 release 發布內嵌 archive SHA-256 的版本固定 `install.sh` 與 GitHub artifact attestation。digest 只證明下載內容與該版本腳本一致，來源證明由 attestation 提供。runtime-home 內含 Runtime Session 延續所需的 Claude session 檔，屬於需備份、反安裝預設保留的資料。

schema 有版本，未知新版本拒絕 dispatch、保留原檔，不重建空 DB。升級先暫停、停止並確認 execution、做一致備份再 migration。回滾需相容 reader／schema 或離線恢復，不能切回舊 in-memory。備份不可只複製未 checkpoint 的 DB 主檔而漏 WAL；恢復舊備份可能遺失較新副作用紀錄，須核對且不自動派送。

新增 Runtime 走 Driver／能力驗證，新增入口共用 service／scope／Task；後續 A2A 映射核心狀態，不反向用 A2A enum 限制核心。Runtime 自己連 MCP servers 與外部 Client 呼叫 AgentPort 是兩方向，各有憑證政策，不轉發 token。

## 13. 驗收及實作前門檻

目前已有 S0 compatibility project 與 `make verify`；以下是尚待產品切片逐項滿足的驗收，不因 S0 local PASS 自動通過。

| 驗收 | 必須觀察到的行為 |
| --- | --- |
| AC-01 通用 MCP | 2026-07-28 每請求協定資料、授權、tools/list／call、結構化及文字結果；不依賴 Grok 私有介面或原生 Tasks |
| AC-02 短提交／去重 | commit 後回 ID；回應遺失、同鍵同時提交、重啟後重試不重複啟動 |
| AC-03 外側觀察 | worker 同步卡住／大量輸出時查詢仍符合 2 秒目標；失聯、無進展、死亡區分；工具 active／idle／unknown 附時間與證據 |
| AC-04 queue | Workspace 互斥及跨 Workspace 並行；edit／dispatch 競爭、取消前項暫停後項、paused 不被淘汰 |
| AC-05 必要澄清 | 真 Claude 提問、跨授權 principal 回答、同 Task 繼續；first-valid／重送／衝突／逾期競爭；accepted 等待 ack 的快照及時鐘正確 |
| AC-06 取消／完成 | 初始化、等待、子工具／detached process 都可外側取消；cgroup 空前不終態／釋放；completion/cancel 唯一結果 |
| AC-07 Crash windows | submit commit／launch、回答 commit／ack、候選 outcome／終態 commit 前後注入 crash；取消／recovery 後延遲 start 被 generation fence 拒絕，不重跑／重送答案 |
| AC-08 恢復／續接 | ID／receipt／事件／問題保留，queue 暫停；ack 不造成功；Session 失效明確選 fresh_session 後保留既有 queued Task ID，原子解除指定 blocker、不清除其他阻擋 |
| AC-09 資源／期限 | 60 分鐘排除純等待，24 小時等待到期停止；一般 tombstone 滿仍可 reply／cancel／ack，控制 reserve 耗盡安全停止；磁碟滿／DB 卡住／輸出超限／慢 Client 不假接受 |
| AC-10 授權 | 本人／bot 同 scope 不同 actor；跨 scope／Agent／question／cursor 拒絕；回答不提權，Runtime 無 DB／launcher 權限 |
| AC-11 交付／通知 | 終態立即可見結果，通知失敗仍可查；30 天保存及過期行為，無 PR 仍可完成 |
| AC-12 平台／回滾 | Linux cleanup、版本 pin、migration／備份恢復；macOS 僅有 platform-neutral development evidence，不宣稱 Runtime／停止等價支援 |

驗證分層：macOS 或 Linux 的核心交易／狀態競爭、fake worker／故障注入、官方 MCP Client 互通，以及指定 Linux target 的真 Claude fixture、停止／恢復。G1 的 Linux execution-control／Stop Evidence（G1-L）與真 Claude authentication／Runtime capability（G1-C）可由不同 Story review，但 production dispatch 必須同時依賴兩者。固定 SDK 型別、認證 Client 配置、儲存與 Linux Supervisor Adapter 整合未驗證前，不宣告 production readiness。依賴順序、早期能力門檻與品質命令見[實作計畫](implementation-plan.md)。S0 與 AP-002 的歷史證據位於各 Story；Registry revision fence、bounded sanitized audit ring／gap counter 與 SQLite／WAL physical control reserve 是相關產品契約。它們的 Work Item、Gate、verification 與 Human Review 現況由 ForgePilot 而非本設計文件宣告。
