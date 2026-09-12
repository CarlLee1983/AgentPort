# AgentPort v0.1 — MCP 遠端交辦、持久任務與外側控制

Status: ready-for-agent

日期：2026-09-12。範圍：完整 v0.1。內容依確認需求與現有設計整理，交辦方已確認測試邊界並授權發布至本機 tracker。這不是已實作、測試通過或可部署的聲明。

## Problem Statement

Caller 希望把 coding 工作交給指定主機上的 Logical Agent，隨時查詢、追加指令、回答澄清問題或停止工作，離線後仍能取回結果。直接把所有訊息送進 Runtime 的輸入佇列，會讓查詢與取消被忙碌或卡住的 Runtime 阻擋，也無法清楚區分一般追加、同 Task 的澄清回答與停止操作。

長工作可能在收到回應前斷線、等待人工回答、產生部分檔案變更，或遭遇控制服務重啟。Caller 需要穩定的 Task 身份、可追溯的首答案及操作紀錄，且不能因重試或重啟而偷偷重跑有副作用的工作。沒有完整證據時，系統必須明示結果未知、停止未確認或觀察不可用。

首版服務本人與明確授權的自有 bot；管理者需要限制 Agent 的 Workspace、Runtime 與政策，並保有可操作的 Linux 停止、恢復、保存與升級方式。

## Solution

提供單主機 AgentPort：相容 MCP 的 Caller 選擇管理者預設的 Logical Agent，提交文字工作後立即取得已持久保存的 Task ID，再透過獨立工具查詢狀態、結果、問題與事件。首個 Runtime 是 Linux 上的 Claude Code，預設完成修改、測試及回報；推送分支或建立 PR 依任務與事先設定的專案規則。

同 Workspace 依序執行，等待回答也保留占用；不同 Workspace 可在容量內並行。一般追加建立同 Context 的新 Task，澄清回答回到原 Task，取消走外側控制。服務重啟保留工作紀錄並先暫停、核對；由 Caller 明確處理未知結果與續接，不自動重播工作或答案。

以 MCP 公開行為驗收完整流程，並以真 SQLite、可控故障、真 Linux execution 與真 Claude 互動提供必要證據。通知由 Caller 消費事件處理，通知失敗不影響結果查詢。

## User Stories

1. As a Caller, I want to 列出我有權使用的 Logical Agent、可用性與能力, so that 我能選擇適合工作的執行身份。
2. As a 主機管理者, I want to 預設 Agent 的 Workspace、Runtime 與政策, so that 遠端工作只使用核准的執行綁定。
3. As a Caller, I want to 使用相容的通用 MCP Client 交辦工作, so that 我不必依賴特定 bot 品牌的私有介面。
4. As a Caller, I want to 提交文字工作並取得已持久化的 Task ID, so that 長工作不需要保持原請求連線。
5. As a Caller, I want to 在回應遺失後以相同 operationId 重試, so that 我能取得原 Task 而不重複交辦。
6. As a Caller, I want to 在斷線再連線後查詢原 Task, so that 我的連線狀態不會取消已接受的工作。
7. As a Caller, I want to 以獨立工具查詢工作, so that Runtime 忙碌或卡住時仍有觀察入口。
8. As a Caller, I want to 看見生命週期、最後進展、程序存活與觀察時間, so that 我能分辨執行中、沒有進展與觀察失聯。
9. As a Caller, I want to 看見有時間及證據的工具活動狀態, so that 我不會把程序存活誤認為工具正在工作。
10. As a Caller, I want to 在長時間無進展時收到疑似停滯事件, so that 我能評估是否繼續等待或取消。
11. As a Caller, I want to 在無法取得最新狀態時收到明確說明, so that 舊快照不會被當成目前正常狀態。
12. As a Caller, I want to 分頁列出可存取的 Task 與已提交事件, so that 我能追蹤多項工作而不下載全部內容。
13. As a Caller, I want to 在執行中追加同 Context 的新 Task, so that 每項追加都有獨立狀態、結果及取消能力。
14. As a Caller, I want to 同 Workspace 的工作依 eligible 順序執行, so that AgentPort 管理的工作不會同時修改同一 Workspace。
15. As a Caller, I want to 不同 Workspace 的工作在容量內並行, so that 互不重疊的工作不必全域串行。
16. As a Caller, I want to 明確修改尚未開始的 Task, so that 更新指令不會依訊息先後被誤判為覆蓋。
17. As a Caller, I want to 修改與派送競爭時得到明確 revision 衝突, so that 已開始的工作不會被當作未開始修改。
18. As a Caller, I want to 取消尚未開始的 Task, so that 不需要的工作不會被派送。
19. As a Caller, I want to 前項失敗、取消或中斷後暫停後續 Task, so that 我能先評估部分變更再決定繼續。
20. As a Caller, I want to 明確恢復可解除阻擋的 Context, so that 已接受的 Task 保留原 ID 與順序繼續等待派送。
21. As a Caller, I want to 原生 Session 不可續接時得到 continuation_unavailable, so that 系統不會默默丟失對話脈絡。
22. As a Caller, I want to 明確選擇 fresh_session 並提供摘要或空摘要, so that 我能在同 Context 繼續既有佇列並知道原生對話已更換。
23. As a Caller, I want to Claude 提出具識別與答案格式的澄清問題, so that 我能將回答送回正確的 Task 等待點。
24. As a Caller, I want to 回答後繼續同一 Task, so that 澄清不會被當作另一項追加工作。
25. As a Caller, I want to 一次回答同一原生問題呼叫中的完整題組, so that 原生回呼只接收一組符合 schema 的答案。
26. As a 已授權 bot, I want to 回答同 Access Scope 內其他 Caller 建立的問題, so that 本人與 bot 可以接手工作且保留各自 actor。
27. As a Caller, I want to 每個問題只採用第一個有效回答, so that 同時回覆不會使工作採用不確定的答案。
28. As a Caller, I want to 相同答案重送取得既有結果、不同答案收到衝突, so that 網路重試不會重複投遞或覆蓋已採用答案。
29. As a Caller, I want to 分辨答案已接受、待送達與送達未知, so that 接收回應不會被誤認為 Runtime 已繼續。
30. As a Caller, I want to 等待問題有預設 24 小時期限且純等待不計入執行期限, so that 我有時間回答而工作不會無限等待。
31. As a Caller, I want to 答案被接受後恢復執行計時並停止原問題到期判定, so that 投遞卡住仍受限制，也不會被舊回答期限錯誤取消。
32. As a Caller, I want to 等待回答期間繼續保留 Workspace 占用, so that 其他 Task 不會修改等待中的工作現場。
33. As a Caller, I want to 從外側取消初始化、執行或等待中的工作, so that 停止操作不必等待模型回應。
34. As a Caller, I want to 取消先回停止中再查停止結果, so that 短控制請求不必等待完整清理。
35. As a Caller, I want to 只有在 execution 已停止且不能延遲重啟時才解除占用, so that 後續工作不會與殘留程序重疊。
36. As a Caller, I want to 完成與取消競爭時只有一個依提交順序決定的結果, so that 遲到成功不會覆寫已生效的取消。
37. As a Caller, I want to 達執行或回答期限後安全停止並保存部分產出, so that 超時不會留下無限執行的工作。
38. As a Caller, I want to 服務重啟後用原 ID 讀取 Task、問題、答案、receipt 與事件, so that 重啟不會抹去追蹤能力。
39. As a Caller, I want to 重啟後佇列暫停、舊 execution 先核對, so that 系統不會自動重跑可能已產生副作用的工作。
40. As a Caller, I want to 在停止已證實但結果未知時明確確認 interrupted, so that 我能結案而不虛構成功。
41. As a Caller, I want to 回答投遞證據遺失時保留首答案且不自動重送, so that 不確定的回呼不會被執行兩次。
42. As a Caller, I want to 終態出現時即可取得完整核准結果, so that 不會先看到 completed 卻還沒有結果。
43. As a Caller, I want to 結果包含摘要、變更檔案、檢查證據、未完成事項與實際 Git 資訊, so that 我能評估交付內容與剩餘工作。
44. As a Caller, I want to 區分 Runtime 自述與服務驗證的事實, so that 我能判斷結果證據的可信程度。
45. As a Caller, I want to 分析任務可在沒有檔案變更或 PR 時完成, so that 交付成功依任務要求判斷。
46. As a Caller, I want to 依已授權任務或專案規則推送分支與建立 PR, so that 需要的遠端交付可完成而不強制所有工作開 PR。
47. As a Caller, I want to 通知失敗後仍能查詢結果與事件, so that 通知管道不會成為核心完成條件。
48. As a Caller, I want to 預設保留終態結果 30 天並清楚回報過期, so that 我能回查工作且不會因舊重試重跑已過期任務。
49. As a Caller, I want to 暫停、恢復中與停止未知的紀錄不被 TTL 刪除, so that 未結案工作仍可處理。
50. As a Caller, I want to 游標過期時被要求重查快照, so that 事件清理不會默默漏掉完成通知。
51. As a Caller, I want to 容量滿時拒絕新工作但保留既有 Task 控制容量, so that 已接受工作仍可回答、取消與結案。
52. As a Caller, I want to 儲存故障時明示不可用並收斂執行, so that 系統不會假稱取消或結果已保存。
53. As a 主機管理者, I want to 每項操作重新驗證 scope 與 Agent 權限, so that 知道 ID 或已撤銷權限的舊連線不會繼續取得資料。
54. As a 主機管理者, I want to 本人與 bot 使用個別憑證及 audit actor, so that 共享工作範圍仍可追溯操作責任。
55. As a 主機管理者, I want to 澄清回答不能增加執行權限, so that 問答不會變成遠端提權入口。
56. As a 主機管理者, I want to Runtime 無法修改控制資料庫、AgentPort 憑證及 launcher 控制狀態, so that 開發工作不能改寫自身執行事實。
57. As a 主機管理者, I want to 重疊 Workspace 配置或執行前 binding 變更被拒絕或暫停, so that 工作不會偷偷換到另一個目錄或 Runtime。
58. As a 主機管理者, I want to 以固定版本、pnpm 12 與 lockfile 重現安裝及檢查, so that 相容性問題可追蹤到實際組合。
59. As a 主機管理者, I want to 取得 Linux 安裝、doctor、readiness、停止與恢復文件, so that 我能知道服務是否僅可查詢或可安全派送。
60. As a 主機管理者, I want to 升級前確認停止並做一致備份、支援離線回滾, so that migration 或舊備份恢復不會自動重跑工作。
61. As a 維護者, I want to 真 Claude 往返、Linux 停止及故障驗收都具實際證據, so that fake fixture 或缺環境跳過不會被當成首版完成。

## Implementation Decisions

1. **責任與單一事實來源。** 建立唯一 AgentExecutionService，擁有授權、Task／Context／Question 狀態、合法操作與排程資格。MCP Adapter 只做協定、schema、可信身分及結果轉譯；Registry 擁有管理者配置；儲存擁有交易與讀取；Driver 擁有 Runtime 語意轉換。Adapter、Driver 不建立第二份 Task 狀態機，不以 vendor SDK 型別污染核心。
2. **執行隔離。** 單控制 daemon 與每次 execution 的 worker 分開，Claude SDK／CLI 在 worker 執行；可信 launcher／supervisor 管理 generation 與 cgroup。Runtime worker 不直接寫核心 DB 或發布終態。同步 SQLite binding 放專用資料庫 worker，查詢有獨立短讀通道；IPC、輸出、解析及 checkpoint 有界，不能阻塞外側控制。
3. **版本基線與驗證。** 採 TypeScript、Node 24、pnpm 12；候選基線是 MCP revision 2026-07-28、官方 MCP v2 packages 2.0.0、Claude Agent SDK 0.3.269。S0 固定 exact Node／pnpm patch、SDK、Claude binary、SQLite binding 及實際內嵌 SQLite 版本與 lockfile。WAL 版本需包含適用修正，例如 3.51.3 或後續版本；目前是來源文件的待驗證選擇，不宣稱本規格重新查證或組合測試通過。
4. **MCP 相容性。** 單一 HTTPS Streamable HTTP endpoint，採所選 revision 每請求自含協定資料的無狀態模式，由官方 SDK 驗證 version、client info、capabilities。首版沒有 legacy initialize／session fallback；不依賴原生 Tasks、elicitation 或 background extension。先驗證可預配置個別 bearer 的受信任 Client；固定 token 不等於完整 OAuth，不宣稱任意 MCP Client 相容。需要 OAuth discovery 的 Client 另需 metadata、認證來源及 token 驗證整合，不退回匿名或共用 token。
5. **公開工具。** 所有工具都是短操作；成功結果同時提供符合 outputSchema 的 structuredContent 與同內容 JSON TextContent。工具契約如下：

   | 工具 | 輸入與可觀察契約 |
   | --- | --- |
   | agentport_list_agents | 可選分頁；回授權 Agent、描述、可用性、能力，不含主機路徑。 |
   | agentport_submit_task | operationId、agentId、instruction，可選 contextId、executionLimitSeconds、inputWaitSeconds；commit 後回 Task snapshot，新 Context 由核心建立。 |
   | agentport_get_task | taskId；回已提交快照、觀察資訊、問題及結果，不呼叫模型。 |
   | agentport_list_tasks | 可選 agentId、state、cursor、limit；回 scope 內穩定分頁摘要，預設不含全文。 |
   | agentport_get_events | 可選 taskId、afterCursor、limit；立即回已提交事件與 nextCursor，不等待新事件。 |
   | agentport_edit_task | operationId、taskId、expectedRevision、instruction；僅可改未啟動的 queued／paused 工作。 |
   | agentport_reply | operationId、taskId、questionId、answer；回 accepted／already_accepted、delivery 及快照，不代表已繼續。 |
   | agentport_cancel_task | operationId、taskId；保存取消意圖後立即回快照，停止結果另查。 |
   | agentport_resume_context | operationId、contextId、expectedRevision、continuationMode=preserve／fresh_session；fresh 需明確 contextSummary，可為空；原子解除可解除 blocker，僅派送未開始 Task。 |
   | agentport_acknowledge_interruption | operationId、taskId、expectedRevision；資源已證實停止才可將結果未知工作結案為 interrupted。 |

6. **輸入、授權及錯誤。** Principal 由受保護認證設定提供 principalId、accessScopeId 與 Agent／操作 allowlist，不取自工具輸入。每次讀取或 mutation 重驗當前權限，scope 與 createdBy 分開，audit 保留真實 actor。缺失／無效憑證回 HTTP 401；無權與不存在統一 not_found；未知工具／schema 錯誤是 protocol error，不建 Task。業務衝突用 isError=true、穩定 code、安全重試資訊及授權後快照；查詢已失敗 Task 本身仍成功。schema 拒絕未知且影響執行的欄位；instruction 結構化傳入，不 shell 插值；只接受文字，URL 不自動下載附件。
7. **持久資料契約。** 建立版本化關聯儲存：Task 保存身份、scope、actor、指令、revision、state／reason、時間、結果、predecessor 與 queueOrder；Context 固定 Agent／scope／binding、revision、blocker 及續接 reference；BindingSnapshot 保存配置 revision、Workspace identity、Driver 版本與非秘密政策。Execution 保存 executionId、epoch、可信 unit ID、啟動紀錄、連續 ordinal、候選結果及停止證據；Workspace claim 對 canonical identity 唯一；Question 保存原生 tool-use 關聯、schema、expiry、首答案、actor 及 delivery；receipt 保存 scope／operationId／初始 fingerprint／結果；事件含 Task seq、scope-global cursor、revision 與核准 payload。這是待實作 schema，不是現存資料庫。
8. **Workspace 與續接綁定。** 啟動 realpath 並核對目錄 identity；同目錄共 claim，祖先／子目錄重疊配置拒絕。執行前再核對授權、binding、目錄、能力與政策；不符即暫停，不改綁。限管理者控制的本機目錄，不承諾辨識任意 mount alias 或約束外部人類工具。Context 不改 Agent／scope／binding；原生 Session 不可用回 continuation_unavailable。
9. **先保存再動作與去重。** submit 在同一短交易驗證授權、Context、能力、容量與 receipt，原子建立 queued Task、queueOrder、predecessor、accepted event 及 receipt，commit 後才回 ID。mutation 的 application operationId 在 scope 內唯一，與 JSON-RPC request id 分開；同初始請求回原 receipt，不同請求回 conflict。後續 edit 不改原 submit fingerprint。HTTP 斷線或 request cancellation 不撤銷已 commit Task。不得跨 Runtime I/O 持有 DB 交易。
10. **排程與修改。** 同 Context 新 Task 接在最後已接受 Task 後；predecessor 成功才自動執行。每 Workspace 選最早 eligible Context 頭項，同時最多一個 execution；paused Context 不阻擋其他 Context，但未停止 execution 或 quarantine 阻擋整個 Workspace。不同 Workspace 在全域上限內並行，不加優先權或搶占。dispatch 在短交易取得 claim、建立 execution 並 queued→starting，commit 後 launch。edit 用 expectedRevision CAS 與 dispatch 競爭，只有一方勝出；未啟動 cancel 可直接 canceled，並暫停後續 Task。
11. **可信啟動／停止契約。** supervisor 持久保存 generation 的啟動及撤銷，序列化同 execution 的 start／stop。start 先登記，只有仍獲准 generation 可在 vendor 執行前放行；先到撤銷也永久阻止晚到 start。stop 證據必須同時包含 unit 已空及未來／進行中 start 不可能再放行；空或尚不存在的 cgroup 不足以釋放 claim。cancel 或 recovery commit 後撤銷再停止；supervisor 重啟先撤銷舊 epoch 未結 execution，不明時拒絕啟動及停止確認。
12. **生命週期。** queued／paused 表示從未啟動；starting／running／awaiting_input／stopping 持有 claim；recovering 持有或 quarantine；completed／failed／canceled／interrupted 只有符合停止與結果條件才釋放。正常路徑為 queued→starting→running↔awaiting_input→stopping→終態；未啟動可 queued↔paused 或 canceled。開始失敗也須清理後才 failed。終態不受遲到事件改變；疑似停滯、stale 及觀察不可用是健康／觀察訊號，不新增終態。
13. **完成與取消。** worker 回目前 execution 的連續 ordinal；核心待 finalOrdinal 全提交後封存候選 outcome、摘要與續接 reference 並進 stopping，確認保存後 worker 退出。停止證實後，結果、終態事件、Context reference 及 claim 釋放在同交易完成；EOF、exit 0 或 SDK resolve 不單獨算成功。先 commit 的候選完成或取消意圖決定結果，完成先到則後到 cancel 回 too_late；期限／政策失敗不能被遲到成功覆寫。取消先持久化並回停止中，再 cooperative cancel，5 秒未完成強制停止 cgroup，再最多 5 秒核對；未確認 generation 封閉且 unit 空維持 stopping、stopConfirmation=unknown、degraded 及 claim。正常運行時 worker 死亡且無 outcome，證實停止後 failed/runtime_lost；控制服務 crash 則先 recovering。
14. **可觀察性。** 快照分開提供 state、revision、reason、lastProgressAt、executionLiveness=alive／dead／unknown、livenessCheckedAt、observedAt、observationStatus=current／stale／unavailable、currentQuestion 及 result。toolActivityStatus=active／idle／unknown 附觀察時間與有界核准工具名稱／開始時間，不含參數或完整輸出。無可靠事件時回 unknown，不從心跳推定進展。starting／running 連續 10 分鐘無進展提示疑似停滯；awaiting_input pending 顯示回答期限，accepted 顯示投遞耗時並觀察停滯；queued／paused 顯示 blocker。心跳及網路存活不刷新 lastProgressAt。
15. **Claude 正向澄清。** 官方 Agent SDK query 採 streaming input；不使用已移除的 V2 session API，不以 partial output 推定控制能力。Driver 依工具名稱區分 AskUserQuestion 與一般 canUseTool 批准；一般工具按既定政策允許／拒絕。原生問題先持久保存並進 awaiting_input 再公開，worker 保留待決 callback；普通文字問號不是問題。一次原生呼叫的多題視為一個有界 Question，答案符合整組 schema。純等待前須證實平行工具靜止；首版限制平行或等待靜止，無法保證則互動 gate 不通過。cwd、settingSources、resume 由管理者配置；空 settingSources 不等於所有 managed policy 已隔離。
16. **首答案與投遞。** reply 交易驗證 scope、Task／execution／Question、有效期限、schema 及等待仍有效；首答案保存 actor／hash、receipt、delivery=pending，再送同 worker。questionId 保證不同 operationId 也不能換答案；相同答案回已有結果，不同答案 answer_conflict；過期、取消或關閉不可回答。worker 去重且確認待決 callback，採用後回 ack；有證據才 awaiting_input→running。首答案 commit 結束純等待、停用原 expiry、恢復執行時鐘，即使尚無 ack 仍如此。投遞／ack 間故障標 delivery=unknown、保留答案、禁止自動重送；原 callback 遺失不以 Session resume 假裝恢復，也不保證跨程序 exactly-once。
17. **期限。** inputWaitSeconds 預設 24 小時，pending 問題到期關閉並停止，確認後 failed/input_timeout、後續暫停；reply／expiry／cancel 在交易邊界裁定。executionLimitSeconds 預設累計 60 分鐘，包含 starting、running 與回答投遞，不含 queued／paused／已證實純等待。使用程序 monotonic clock 並持久保存累計及階段；worker 持有期限副本，控制服務失聯由 supervisor 收斂。Caller 僅能在管理者允許範圍調整。
18. **恢復及 Context 解除暫停。** 啟動取得唯一 daemon 鎖並暫停 dispatch，queued→paused，舊 active execution→recovering，核對、撤銷並停止殘留；不確定則 quarantine。完整候選 outcome／finalOrdinal 加停止證據可完成對應終態，但不自動解除重啟 pause；不完整維持 recovering/outcome_unknown。資源停止後 Caller 可 acknowledge_interruption 結案，不能造成功、重跑或回復檔案。resume_context 原子記錄接受哪個已結 predecessor 的部分成果，只解除失敗／取消／重啟等可解除 blocker；未停止、無權或無效 binding 不得略過。preserve 需安全 reference，fresh_session 明示放棄原生對話並使用 Caller 摘要，保留 Task ID／順序、不重播舊工具；核心不自產摘要。claim 時 reference 標使用中，成功且停止後才發布新 reference，失敗／取消／未知使其失效，不回退舊 Session。
19. **儲存、容量與失敗。** SQLite 使用 WAL、foreign keys、FULL 同步、單寫入通道與短交易，DB 放控制帳號專用本機目錄。寫入失敗停止 admission／dispatch，不假接受；可靠舊快照標 stale，無可靠快照回 observation_unavailable。接受 Task 時預留回答、取消、恢復及終態 receipt／event；新 Question 前預留首答案，負載將耗盡 reserve 時用保留空間停止／結案。實體失敗使 reserve 不可用時由獨立 supervisor 停止、回 unavailable 並保留 quarantine，不承諾磁碟故障下仍能持久化終態。
20. **初始限額。** 以下是待調校初值，不是已量測吞吐或成功回應保證；核算 JSON escaping、audit、DB 頁面及 WAL，不能只算 payload：

   | 項目 | 初值與行為 |
   | --- | --- |
   | active execution | 全域 4，同 Workspace 1；等待、啟動、停止及恢復未釋放資源均計入。 |
   | 未啟動 Task | 每 Workspace 32、全域 256，paused 計入；滿時拒絕 admission，不丟已接受工作。 |
   | instruction／HTTP body | 64 KiB／128 KiB，接受前拒絕超限。 |
   | 問題／回答 | 各 32 KiB，答案符合 schema。 |
   | 單 Task 公開內容 | 1 MiB，預留控制／問題／結案；最終結果不完整明示 output_limit，不假成功。 |
   | 頁／回應 | 預設 50、最多 100 筆，8 MiB；不切斷單筆結果冒充完整。 |
   | 儲存 admission／控制 reserve | 2 GiB／另留 256 MiB；先拒絕新工作，不提前淘汰保存期內結果。 |
   | 一般 tombstone | 最多 100,000；滿時阻擋 submit／edit／resume，既有 reply／cancel／ack 另有控制 reserve。 |

21. **保存、事件與結果。** 終態結果、問題及操作紀錄預設結案後保留 30 天，可調；未結案、paused／recovering／停止未知不套 TTL。receipt 過期保留不含 prompt／答案全文的最小 tombstone，舊鍵回 result_expired 而不重跑。Context 至少保留至相關非終態及可查 Task 結案／到期；Runtime transcript 由管理者另管。scope／filter 綁定事件 cursor，過期回 cursor_expired 並要求重查快照；慢 Client 不阻塞 worker，通知不控制狀態。結果含摘要、檔案、檢查證據、未完成事項、實際 commit／分支／PR 及已知副作用，分開標示自述與服務驗證。取消不撤回外部推送或服務工作，亦不保證還原檔案。
22. **安全與操作邊界。** 個別 bearer credential 不進 Workspace、Runtime env、結果或日誌；Runtime 僅取得所需 vendor 憑證，控制 DB、credential 與 supervisor 權限另行保護。HTTPS 由可信代理終止、daemon 預設 loopback；其他暴露需明確 TLS／來源限制，驗證 Origin／Host、proxy trust 與 body 上限，不信任外來 forwarded identity。日誌僅 allowlist metadata，audit 記 actor／結果，不輸出未遮罩 stderr／argv／env。Workspace 是工作目錄而非 Sandbox，專用 Runtime 帳號不保證各 Agent 的檔案／憑證硬隔離；prompt 不是 OS 權限邊界。一般澄清不批准提權，超出政策回 policy_denied；核准 Artifact 才可對外提供，首版僅文字及結構化內容，無任意檔案下載或通用 DLP。
23. **交付與運維。** 提供 Linux 帳號／cgroup v2／launcher、受保護配置、TLS／Client、readiness／doctor、憑證輪替、停止、故障核對與查詢文件；readiness 分開表示可查與可派送，能力未驗證的 Agent 不列 ready。shutdown 先停 admission／dispatch 並暫停 queue，再停止活動 execution、保存結果／未知狀態後關閉 listener／storage，supervisor 兜底。schema 不相容拒絕派送並保留原 DB；升級先停止確認、一致備份含 WAL 語意，再 migration，回滾以相容 schema 或離線恢復；舊備份恢復先 recovery、不自動派送。
24. **依賴順序。** S0 建最小工具鏈、固定版本與 MCP 相容性；S1 在指定 Linux fixture 先證實 generation 撤銷、停止及真 Claude 往返；S2 才建 MCP→持久 admission／查詢／未啟動取消；S3 接派送、結果、取消與基本恢復；S4 完成 queue／修改／問題／續接及全部 10 工具；S5 擴大故障、容量、保存及效能；S6 完成真 Caller 驗收與 Linux 發行包。S3 派送前已有 claim、fence、取消與恢復，不延至 S5 補救；S1 失敗不得以 fake 或刪除澄清能力繞過。階段退出條件採來源實作計畫 G0–G6，未通過者維持未完成。

## Testing Decisions

1. **主要驗收邊界。** 以公開 MCP 工具作 Caller 端最高可觀察入口，測提交、查詢、追加、回答、取消、事件及重啟後結果，不斷言 class 拆法、私有方法或 SQL 排列。大部分行為在同一應用服務入口配真 SQLite、可控 worker 與時鐘測試；adapter 僅另驗 schema、身分與結果轉譯，不複製整套狀態測試。交辦方已於 2026-09-12 確認此主要邊界及下述真 Linux／Claude 契約驗證。
2. **必要的真實控制契約。** generation fence、cgroup 空與子程序清理在真 Linux supervisor 邊界驗證；Claude 原生 callback、取消與 Session 續接在固定 SDK／binary 的真 Runtime 邊界驗證。fixture 可重現錯誤，不能代替 Linux 停止或真 Claude 正向互動。這兩個窄契約補足 MCP 測試不能單靠 mock 證明的行為。
3. **既有基礎。** 目前只有文件，沒有現存可執行模組、測試套件或既有測試 seam。沿用已設計的 AgentExecutionService、Driver／worker、supervisor 責任邊界；以下追溯既有 AC-01–AC-12 與 S0–S6，不聲稱已有通過案例。新增 fixture 只提供故障、時間與程序控制，不額外建立產品入口或狀態機。
4. **驗收矩陣。**

   | 驗收 | 必測外部行為／證據 | 首次落地與收斂 |
   | --- | --- | --- |
   | AC-01 MCP | 官方 Client 驗每請求協定、獨立 bearer、tools/list／call、schema、structuredContent／JSON text、無效版本／token；至少一個真 AI Caller 通過相容性。 | S0、S2；S6 |
   | AC-02 提交與去重 | commit 後回 ID；同鍵同時提交、回應遺失、重啟重試只一個 Task／execution；edit 後重送原 submit 仍回原 ID；commit 失敗無執行。 | S2；S5 |
   | AC-03 外側觀察 | worker 同步卡死、大量輸出／解析與 IPC 無回應時查詢獨立；區分 liveness、progress、tool activity 與觀察不可用；量測 2 秒目標及 Client 5 秒失聯說明。 | S3；S5 |
   | AC-04 Queue | 同 Workspace 互斥、跨 Workspace 並行、eligible FIFO、paused Context 與 quarantine 差異；edit／dispatch CAS；取消／失敗暫停後項；paused 計容量且不淘汰。 | S4；S5 |
   | AC-05 澄清 | 真 Claude 提問→另一同 scope principal 回答→同 Task 繼續；多題 schema、首有效答案、同答案去重、異答案衝突、跨 Task／scope 拒絕、reply／expiry／cancel 競爭；accepted 待 ack 的快照、expiry 與時鐘。 | S1 能力；S4 產品；S5 |
   | AC-06 取消與完成 | starting／running／awaiting_input、子工具及 detached 子程序可外側停止；generation 未封閉或 cgroup 非空不終態／釋放；completion／cancel commit 順序只一結果；timeout 不等於已停止。 | S1、S3；S5 |
   | AC-07 Crash windows | 在 admission commit／response、claim／launch、revoke／late start、answer commit／delivery／ack、candidate／cleanup／terminal commit 前後注入 crash；daemon／worker／supervisor 重啟及恢復再 crash，不重跑、不重送、不漏 future-start fence。 | S1–S4 各邊界；S5 |
   | AC-08 恢復與續接 | ID／receipt／Question／首答案／事件保留，queue 暫停，完整候選才可恢復終態；停止後 ack 僅 interrupted；preserve 失敗不動 queue，明確 fresh 保留 ID／順序並只解除指定 blocker；不能重用失效 reference。 | S3、S4；S5 |
   | AC-09 資源與期限 | 60 分鐘排除純等待、24 小時 pending 到期；平行工具阻止純等待；首答案 commit 恢復累計執行時計；一般 tombstone 滿仍可控制，reserve／磁碟故障收斂；DB 延遲、輸出超限、慢 Client、body／頁面上限不假接受。 | S2–S4；S5 |
   | AC-10 授權 | 同 scope 不同 actor 可接手；跨 scope／Agent／Question／cursor 拒絕、權限撤銷生效；binding／目錄被換或重疊配置拒絕；回答不提權、Runtime 無 DB／credential／launcher 控制權、敏感輸出受限。 | S0、S2–S4；S5 |
   | AC-11 交付與通知 | 終態與結果原子可見；無 PR／檔案變更仍可完成；自述及服務驗證分開、部分副作用保存；通知失敗仍可查；30 天及非終態保存、tombstone／cursor 過期不重跑或漏通知。 | S2、S3；S5、S6 |
   | AC-12 平台與回滾 | exact 版本／frozen lockfile、Linux cleanup、shutdown、readiness／doctor、migration 拒絕未知 schema、一致備份及離線恢復演練；恢復不自動派送；macOS 不當作已支援。 | S0、S1；S6 |

5. **測量方法。** S5 記錄硬體、OS、版本、負載及 fixture，至少涵蓋預設 4 execution 的場景；外側查詢報樣本數、最大值與分位數，不能只報平均或把 unavailable 算正常查詢成功。期限以可控時鐘／縮短時間測穩定競爭，不能取代真 Linux 停止；每個 crash window 保存持久狀態、啟動次數、停止證據與預期／實際差異。
6. **預定命令與 gates。** S0 建立 pnpm install --frozen-lockfile 及 pnpm run check（lint、typecheck、build、無 vendor 憑證的核心／儲存／fixture 測試）；另有 pnpm run test:mcp、test:linux、test:claude、test:faults，最後 pnpm run verify:release 統合必要檢查與證據完整性。這些命令目前尚不存在。切片跑受影響最小檢查，整合跑該階段完整 gates；來源／環境未變可重用結果。缺 Linux、權限或 Runtime 認證記待環境，不能全 skip 後宣稱通過。
7. **真實交付與審查。** S6 用至少一個相容 AI Caller 跑提交→ID→查詢→追加→回答→完成，以及取消、斷線、重啟、未知結案及恢復 queue。Git／PR 政策先用本機 bare remote／模擬 GitHub 回應測試，真遠端只在明確授權測試 repository 驗證，不另建 GitHub Adapter。安全、持久資料及並行須 Sol/high 獨立審查，material findings 解決後才通過 G6。
8. **證據紀錄。** 每次驗證記錄階段／AC、source revision 或檔案摘要、OS／固定版本、命令、fixture、預期與實際、執行／停止次數、結果位置、時間及限制。可用 Task／execution／question ID 關聯，不記 token、環境變數值、完整私密 prompt 或未遮罩 stderr。每階段保存變更、命令、結果及未解事項；必要能力未驗證即保留依賴階段未完成。

## Out of Scope

- macOS 正式支援、A2A、Codex／Cursor 或其他 Driver、排程巡查、LINE／Telegram 等聊天入口；它們屬後續階段，不加空實作或聲稱支援。
- 需求拆解、工作選擇、自然語言意圖模型、跨 Agent 協作及開發流程治理；這些由 Caller 負責。
- 公開多租戶、各 Agent 檔案／憑證硬隔離、任意 Workspace／repo／binary／Driver options 的遠端配置、遠端提權、通用 shell 入口及任意檔案下載。
- 多控制 daemon、跨主機 broker／lease、分散式排程、優先權／搶占、任意 MCP Client 或 legacy revision 相容保證。
- 自動重跑、Runtime 命令／答案重播、跨程序或外部副作用 exactly-once、默默開始新 Session、自動生成 Context 摘要、取消即回復檔案／撤回 PR。
- AgentPort 自行發送聊天通知、GitHub 專用 Adapter、將所有任務強制轉為 PR、通用 DLP 或管理 vendor transcript 的完整生命週期。
- 本次規格工作不安裝依賴、不建立產品程式骨架、不執行 Runtime、不建立 Git 歷史或實作子票、不推送／發布 release／部署；本機 tracker 規格發布屬本次授權。

## Further Notes

- 本規格綜合 [已確認需求](../../docs/delegation-requirements.md)、[Technical Design](../../docs/technical-design.md) 與 [實作計畫](../../docs/implementation-plan.md)，術語遵循 [CONTEXT](../../CONTEXT.md)。Technical Design 定義行為，實作計畫定義順序；若發現衝突先修正計畫，不以方便實作降低需求。
- [外側觀察與控制 ADR](../../docs/adr/0001-external-observation-and-control.md) 與 [跨重啟保存 ADR](../../docs/adr/0002-task-records-survive-restart.md) 是已確認產品方向；[單主機交易儲存 ADR](../../docs/adr/0003-local-transactional-task-store.md) 仍為 proposed，SQLite／worker 技術選擇須實作驗證，不能把此狀態改寫成已接受或已通過。
- [技術依據](../../docs/technical-evidence.md)、[MCP 依據](../../docs/mcp-evidence.md)、[Claude 依據](../../docs/claude-evidence.md) 是來源文件的查證紀錄；本輪不新增即時版本或外部協定查證。架構候選是歷史探索，不沿用忙碌即拒絕、不支援互動或 in-memory-only 舊方案。
- 目前工作目錄只有文件，並非 Git worktree，沒有可執行專案或測試命令。開始實作先確認實際程式工作目錄與 Linux 測試目標；本規格不推定 Linux 憑證、launch 權限或真 Client 已具備。
- ready-for-agent 表示可依 S0–S6 開始執行且仍受階段 gates 約束，不代表 production readiness。版本／Client 相容性及真 Claude 純等待／可靠停止是最早阻擋，失敗需依證據修正技術方案，不得取消已確認產品要求。
- 本次只建立完整功能規格；所有 S0–S6、G0–G6 與 AC-01–AC-12 的實作／執行證據仍待產生。沒有新增依賴、修改 ADR 狀態或擴大外部寫入授權。
