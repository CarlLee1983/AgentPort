# AgentPort v0.1 實作計畫

日期：2026-09-12。這是計畫文件，不投影目前 Story、Gate、verification 或 completion 狀態；請以 ForgePilot 查詢該狀態。

依據：[已確認需求](delegation-requirements.md)、[Technical Design](technical-design.md)、[術語表](../CONTEXT.md)。技術設計定義行為，本文件定義執行順序與驗收；兩者衝突時先修正計畫，不以方便實作為由降低已確認需求。

治理導入註記：本計畫保留 S0–S6／G0–G6 的依賴與驗收設計；正式工作狀態由 ForgePilot 管理，不在本計畫維護第二套 lifecycle。
`.scratch` 不是 implementation lifecycle authority；正式 implementation 工作需提升為 ForgeFlow Story，其執行狀態由 ForgePilot Work Item 管理。
[AP-001 / S0–G0](../specs/stories/AP-001-toolchain-mcp-compatibility/story.md) 與 [AP-002 / S2–G2](../specs/stories/AP-002-platform-neutral-durable-admission/story.md) 提供這份計畫所引用的需求與歷史證據；完整 current-state 流程見 [development workflow](development-workflow.md)。

## 1. 首版成果與範圍

完成的使用流程是：具相容 MCP 能力的交辦方選取已配置 Agent，提交工作取得 Task ID；Linux 上的 Claude Code 執行修改／測試，交辦方可從外側查詢、追加、回答問題或取消，最後取得結果。服務重啟仍可查任務，且不自動重跑或重送答案。

首版必須同時具備外側控制、持久任務、可靠停止及正向澄清往返；只有 fake worker、SDK 呼叫成功或 MCP tools/list 成功，都不能宣告首版完成。分支推送與 PR 依任務／專案規則，不是所有任務的必需產出。

macOS 是 Node、MCP、SQLite、核心狀態／持久化、Adapter 與 fake-worker contract tests 的開發平台，但 native Runtime execution、可靠停止與部署不列入首版支援。A2A、其他 Runtime、排程、LINE／Telegram、公開多租戶、遠端提權與任意檔案下載同樣不列入這次實作。[平台決策](adr/0004-linux-execution-macos-development.md)

## 2. 順序與階段門檻

| 階段 | 交付的可觀察能力                                                                                        | 依賴                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| S0   | 可重現工具鏈與版本／契約檢查；MCP Client 相容性已證實                                                   | 無                                                                                            |
| S1-L | 指定 Linux target 上受控 execution 可啟動／停止，並具 bounded isolated worker IPC                      | S0 local compatibility；指定 Linux environment                                                |
| S1-C | 真 Claude 可產生 structured result、提問、取得回答並在受控 execution 內取消                           | G1-L；指定 Runtime authentication environment                                                 |
| S2   | 經授權 MCP 提交→持久 queued Task→查詢／取消；重啟不遺失；不派送 Runtime                                 | S0 local compatibility；ADR-0004 sequencing decision                                          |
| S1-P | platform-neutral execution-control preparation；只完成 lifecycle／持久化／Supervisor contract，絕不派送 | G2；[AP-003](../specs/stories/AP-003-platform-neutral-execution-control-preparation/story.md) |
| S3-A | platform-neutral S3 persistence／candidate／recovery／projection preparation；絕不派送 Runtime          | G2、S1-P；[AP-006](../specs/stories/AP-006-s3-predispatch-preparation/story.md)             |
| S3-B | MCP→核心→受控 Claude execution→結果／取消，並具基本恢復                                                 | G1-L、G1-C、G2、S3-A                                                                           |
| S4   | 完整追加佇列、修改、澄清往返與明確續接操作                                                              | S3-B                                                                                          |
| S5   | 崩潰、容量、儲存及效能情境下仍符合控制與恢復契約                                                        | S4                                                                                            |
| S6   | 通用 MCP 交辦方的首版全流程驗收與可操作的 Linux 發行包                                                  | S5                                                                                            |

S0 後可平行處理 S1-L 與 S2：S1-L 只在指定 Linux fixture 建立受控 execution；S1-C 在 G1-L 後以獨立 Story 驗證真 Claude capability。S2 可在 macOS 或 Linux 開發 platform-neutral durable admission，但 build／import／production composition graph 都不得含可到達的 Runtime dispatch path。G2 之後可進行 S1-P，將 execution lifecycle、transaction、recovery 及 Supervisor contract 先實作為不可由 production composition 到達的 platform-neutral Module；其 core／storage preparation fixture 可持久建立並保留 Workspace claim，但 scripted Supervisor fixture 本身不建立 claim，兩者都不是 Linux Stop Evidence，也不能建立 Execution Unit、程序或 Runtime call。S1-P 只能進入同樣不可派送的 S3-A；主整合路徑是 `(G1-L + G1-C + G2 + S3-A) → S3-B → S4 → S5 → S6`。S0 的 Linux metadata blocked 不由 macOS evidence 取代，也不因可平行而讓多個人同時修改生命週期／儲存 seam。

S1-L 與 S1-C 將最可能推翻整合選擇的能力分開驗證；兩者的 harness 都只在指定 Linux fixture 使用，不是略過核心授權與持久化的產品入口。S2 的 MCP／storage fixture 也不是可部署的 admission-only 服務。S1-P 的不可達 preparation transaction 先建立並保留 platform-neutral persisted claim；S3-A 可先完成 schema v3、bounded candidate／cancel ordering、recovery 與單一 projection，但 production composition 必須物理上沒有 Runtime start 能力，也不得 terminalize 或釋放 claim。S3-B 開始任何真正派送前，仍須同時通過 G1-L 的 generation fencing／Stop Evidence、G1-C 的真 Claude capability 與 G2 的持久 admission／取消／重啟規則，並在 production dispatch transaction 中核對及承接該 prepared claim。claim release 仍只屬於 S3-B 的真 Stop Evidence／terminal commit 路徑，不能留到 S5 才補上。S5 是擴大故障驗證，不是延後可靠性實作。

每階段完成時保存檔案變更、命令、版本、測試結果及未解事項。階段只有在退出條件通過後才標完成；缺少 Linux 或 Runtime authentication 標記待環境，不以跳過測試作為通過。

## 3. 建議程式邊界

下列是實作時逐步建立的責任位置，現在並不存在；以最小內聚檔案開始，不預建空 class、通用 repository framework 或第二份狀態機。

| 建議位置                                                                       | 責任／主要擁有者                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| src/core/                                                                      | Task／Context／Question、唯一應用服務、狀態及授權；主代理                                         |
| src/storage/、migrations/                                                      | SQLite 交易、receipt、claim、事件、reserve 與恢復資料；主代理                                     |
| src/mcp/                                                                       | 官方 SDK、工具 schema、Principal 轉換與錯誤投影；穩定核心契約後可分派                             |
| src/runtime/claude/、src/runtime/worker/                                       | Claude Driver、受限 IPC、事件及回答 ack；主代理負責控制語意                                       |
| src/supervisor/                                                                | platform-neutral Supervisor interface、generation／Stop Evidence；Linux cgroup v2 Adapter；主代理 |
| src/bootstrap/                                                                 | 配置、Registry、組裝、readiness／doctor；不含另一套排程                                           |
| tests/unit/、tests/integration/、tests/contracts/、tests/e2e/、tests/fixtures/ | 對應行為、真儲存、worker、MCP、Linux／Claude 及故障 fixture                                       |
| docs/operations.md、docs/verification.md                                       | 操作程序與實際驗證紀錄；隨切片更新                                                                |

SQLite／並行／授權／launcher 是高風險邊界，保持主代理實作及 Sol/high 分析、審查；不拆給一般 worker 同時改寫。可分派的內容限已凍結契約下的 adapter、fixture、文件或唯讀查證；每個語意切片只有一個 writer。跨邊界修改由主代理整合，審查後只複查修正範圍。

## 4. S0 — 工具鏈、固定版本與相容性

**成果：**可重現的開發／測試入口，及足以開始 S1 的版本與環境紀錄。

工作：

- 建立最小 TypeScript／Node 專案，套件管理器依使用者指定採 pnpm 12，使用 pnpm-lock.yaml；建立型別／lint／build／測試命令，不新增前端、框架或空擴充模組。
- 依設計基線核對 exact Node patch、pnpm 12 exact patch、MCP packages、Claude SDK／binary、SQLite binding 與實際 SQLite library version，記入驗證檔。package.json 的 packageManager 固定查證後的 pnpm 12 確切版本，驗證 Node 相容性；目前文件列出的版本是候選組合，不把發布 metadata 當作相容性結果。
- 檢查固定套件型別：MCP 每請求協定資料、普通工具 schema、錯誤／structuredContent；Claude query、AskUserQuestion／canUseTool、取消、cwd／settingSources／resume；SQLite 不阻塞控制事件迴圈的執行方式。
- 以官方 MCP Client 對本機受限 fixture 驗證指定 revision、獨立 bearer 身分、tools/list、tools/call 與不支援版本／無效 token。fixture 只做協定回應，不啟動開發 Runtime。
- 記錄未來 Linux 測試目標的 OS、cgroup v2、專用帳號、launcher 權限、資料目錄及可用 vendor 認證來源；只記 metadata，不複製 credential 到文件。

**退出條件 G0：**乾淨安裝／型別／基本測試可重現；MCP 版本及預配置 bearer 的互通有實際結果；Linux 前置條件與 SQLite 修正版已辨識。若選定 Client 不支援設計 revision 或認證模式，先修正技術相容方案，不加隱藏 fallback 或宣稱支援任意 Client。

## 5. S1-L／S1-C — 受控 Linux execution 與真 Claude 可行性

**S1-L 成果：**指定 Linux target 的 harness 能觀察與停止 execution，並證明 isolated
worker 與 bounded IPC 邊界。此階段只操作指定測試目錄，不開放遠端任務派送。

工作：

- 實作最小可重用 Execution Supervisor interface、Linux cgroup v2 Adapter 及 worker IPC 契約：executionId／generation、持久撤銷、開始前放行點、不透明 Execution Unit ID、Stop Evidence；Supervisor 狀態與 Runtime 帳號權限分離。
- 先用不呼叫模型的 fixture 驗證啟動、取消早於啟動、延遲 start、supervisor 重啟、同步卡住 worker、子程序／detached 子程序的停止。generation 封閉且 cgroup 空才可說停止完成。
- 驗證 Runtime worker 只取得指定 Workspace 與最小環境；Reference、ordinal、payload 或 candidate 不合法時 fail closed，且不洩漏 host details。
- 以 import／process tripwire 證明 Linux Adapter、launcher 與 worker harness 不可由 production composition 到達。

**退出條件 G1-L：**可靠停止與 isolated worker IPC 有證據；沒有孤兒 execution，晚到
start 無法在取消後重新啟動。G1-L 單獨不允許 S3-B Runtime dispatch。

**S1-C 成果：**後續獨立 Story 在已驗證的受控 execution 內接入真 Claude SDK，明確
cwd／設定來源，取得 structured result；觸發 AskUserQuestion、綁定原生 question／tool-use、
提供有效答案並繼續，同時驗證執行中與純等待取消及安全 Session reference。

**退出條件 G1-C：**真 Claude 正向「提問→回答→繼續」、cancellation 與 Session safety
有 candidate-bound evidence。若 SDK 模式無法保證純等待或控制邊界，暫停 S3-B–S4；
不能以本機既有登入、fake、skip 或 G1-L evidence 取代。

## 6. S2 — MCP 到持久任務的第一個切片

**成果：**交辦方取得穩定 Task ID，能跨重啟查詢並取消尚未啟動的工作；此切片可在 macOS 或 Linux 開發，但不建立 Execution、Workspace claim 或派送 Runtime。[AP-002](../specs/stories/AP-002-platform-neutral-durable-admission/story.md)

工作：

- 建立核心公開型別與唯一 AgentExecutionService；SQLite 初始 migration 只保存本切片需要的 Task、Context、BindingSnapshot、receipt、event 與 reserve metadata，不預建 Question、Execution 或 Workspace claim schema。
- 實作管理者 Registry、scope／principal 分離、固定 Workspace identity 與 Agent allowlist；MCP 請求不能覆寫路徑、binary、政策或身分。
- 完成 list_agents、submit_task、get_task、list_tasks、get_events 及可取消未啟動 queued／paused Task 的 cancel_task。僅發布已實作且具正確語意的工具，不以空成功結果代替其他工具。
- submit 的 Task／receipt／事件先原子 commit 再回覆；原始 operation fingerprint 不隨後續 Task 更新改變；跨重啟去重、queued→paused、取消 queued、事件 cursor 與基本 result projection 一起落地。
- 從一開始區分一般 admission 與既有 Task 控制容量，確保 accepted Task 已保留取消／結案紀錄空間。SQLite I/O 不在控制事件迴圈阻塞。
- AP-002 diff 不新增 dormant／feature-flagged dispatcher、Runtime Driver、Supervisor Adapter 或 worker launcher；S2 build／import／composition graph 的每種配置都不能到達 S1 已合法交付的 execution artifacts。fake worker 只驗證訊息 contract，任何 spawn／dispatch 都使 tripwire 測試失敗。

**退出條件 G2：**真 SQLite＋官方 MCP Client 驗證同鍵同時提交只建一個 Task、回應遺失後同鍵取得原 ID、重啟保留紀錄且 queue 暫停、跨 scope 操作拒絕；no-dispatch contract 證明沒有 Execution／claim／worker／Supervisor 接觸。提交或 DB commit 失敗時沒有執行副作用；macOS PASS 只證明 durable admission，不是 Linux、Runtime、reliable-stop 或首版完成。

## 6a. S1-P — Platform-neutral execution-control preparation

**成果：**在不建立可到達 dispatcher、Runtime worker 或 Supervisor Adapter 的前提下，完成 S3 所需 execution lifecycle 的核心 Module、SQLite transaction／recovery 語意、MCP read projection 與 Supervisor contract fixtures。

工作：

- 將 AgentExecutionService 保持為唯一 lifecycle owner；以既有 `start`、`revokeAndStop`、`reconcile` Supervisor interface 形成唯一 seam，定義 immutable Execution Reference、generation、daemon epoch 與 prepared／recovering／quarantine 的安全保留語意。
- 以真 SQLite 驗證 Workspace claim 的唯一性、prepare／cancel race 與 restart→recovering／quarantine；scripted contract fixture 只可回 pending／indeterminate，不能啟動程序、建立 Execution Unit、寫入 candidate outcome、釋放 claim 或提供 G1 Stop Evidence。
- 建立 bounded Reference-bound worker observation schema 與 MCP lifecycle read projection；所有 production bootstrap/composition 仍不可 import dispatcher、worker launcher、Supervisor Adapter 或 Driver。candidate outcome 預設延後至 G1 後的 S3-B；只有 Human Gate 明確 supersede GATE-012 的 candidate-timing 部分後，S3-A 才可先保存 bounded、untrusted、nonterminal candidate。terminal result 與 claim release 始終延後至 G1 後的 S3-B。
- 保留 no-dispatch reachability／process tripwire；不呼叫 Claude SDK `query()`、不建立 container、cgroup、process group 或 Execution Unit。

**限制：**S1-P 的 test、review 與 macOS evidence 只證明 core contract。它不證明 generation fencing、cgroup containment、unit empty、descendant cleanup、real Claude 問答／取消／Session、G1-L、G1-C、G3 或 production readiness；它只允許另經 Gate 授權的 S3-A pre-dispatch preparation，不允許 S3-B Runtime dispatch。

## 6b. S3-A — Pre-dispatch persistence and projection preparation

**成果：**在 G1-L 或 G1-C 尚未證明時，完成 schema v3、bounded observation／candidate persistence、取消排序、restart recovery 與單一 `agentport_get_task` lifecycle projection；不建立任何可到達 Runtime dispatch。

工作：

- additive migration 保留 AP-003 execution／claim／evidence；舊 binary 拒絕 schema v3，rollback 使用 v3-aware recovery 或 reconciliation 後的 offline restore。
- 以真 SQLite 保存綁定完整 Reference、連續 ordinal 的 bounded observations 與 nonterminal candidate；衝突、跳號或越界輸入拒絕並 quarantine。
- candidate 與 cancel intent 依 commit order 決定 stop reason，但都只能到 `stopping`／`recovering`；沒有 G1 Stop Evidence 不 terminalize、不發布 result、不釋放 claim。
- 將 lifecycle 合併至 `agentport_get_task`，移除 preparation-only public tool；G1-L 或 G1-C 任一未通過時，readiness 固定為 `blocked`／`g1_unproven`。
- 擴充 no-dispatch import／composition／process tripwire，確保 production 無 Adapter、launcher、worker、Driver、credential source 或 Runtime side effect。

**限制：**S3-A 只是 platform-neutral preparation；不證明 Linux containment、Claude、reliable cancellation、G1-L、G1-C、S3／G3 或 production readiness。真正 dispatch 仍屬 S3-B 並必須等待 G1-L 與 G1-C。

## 7. S3-B — 派送、結果、取消與基本恢復

**成果：**單項 MCP 工作能經核心交給 S1 的受控 Claude worker，回傳最終結果；外側查詢／取消不等模型。

工作：

- dispatcher 在短交易內核對並承接 S1-P 已持久化的 prepared Execution／唯一 Workspace claim、標 starting，再呼叫 launcher。將核心取消／recovery 與 supervisor generation 撤銷接起來；所有停止確認含「不會再有未來 start」。
- 接上 worker observation、連續 ordinal、候選 outcome、finalOrdinal 及停止證據；結果／終態／reference／claim 釋放同交易提交，EOF 或 exit 0 不單獨算成功。
- 完成 running／stopping／completed／failed／canceled／recovering／interrupted；cancel 立即回停止中，完成與取消以 commit 順序裁定。acknowledge_interruption 必須先有停止證據，不造成功。
- 實作開機 pause／舊 execution 核對、stop-unknown quarantine、候選 outcome 恢復及 daemon 失聯清理。重啟不能自動 dispatch 或重播 Runtime 命令。
- 回傳有界 lifecycle／progress／liveness／toolActivity 狀態與時間；驗證模型卡住、IPC 不回覆時查詢走獨立讀取。加入基本累計執行期限及安全停止。

**退出條件 G3：**官方 MCP Client → 真儲存／核心 → 真 Claude → 可查結果，另以故障 fixture 驗證 cancel-before-start、completion/cancel 競爭及 crash 後不重跑。此階段真 Claude 任務只測不需要互動的流程；若碰到尚未接入的互動，明確停止／失敗，不對外宣稱完整 ready。S1 的澄清可行性不等於 S4 的產品往返已完成。

## 8. S4 — 完整佇列、問題與續接

**成果：**10 項設計工具全部具備實際行為，交辦方可在同一 Context 追加、修改、回答及明確恢復佇列。

工作：

- 加入 Context predecessor／blocker、每 Workspace eligible FIFO、跨 Workspace 並行、queue／paused 容量；修改與 dispatch 使用 revision CAS；取消／失敗前項暫停後項。
- 完成 edit_task、reply、resume_context，擴充已存在的 get／events／cancel；工具與核心共用型別，不在 Adapter 另存 Question 或 queue 狀態。
- 原生問題先持久化再公開；首答案 transaction、questionId／schema、相同答案重送、不同答案衝突、跨授權 principal 回答、reply／expiry／cancel 競爭一起處理。
- 明確實作 pending→accepted／delivery pending→ack；純等待停止執行時鐘，答案 commit 恢復時鐘並關閉 input expiry。commit→ack crash 標 delivery unknown、不重送。
- 接入預設 24 小時等待與 60 分鐘累計執行期限，並測試工具平行活動如何阻止進入純等待。等待時保留 Workspace claim。
- 實作 preserve／明確 fresh_session，保留 Task ID／順序；fresh 只採交辦方明確給定摘要，不重播舊工具命令。解除指定 blocker／paused→queued 原子完成，其餘 blocker 不變。

**退出條件 G4：**真 Claude 經 MCP 提問，由另一個同 scope principal 回答後同 Task 繼續；也要通過重送、衝突、逾期及取消分支。原生 Session 失效後，可明確 fresh_session 繼續原 queue，沒有默默遺失或重新建立已接受的 Task。

## 9. S5 — 故障、保存與容量驗證

**成果：**所有已實作控制契約在崩潰及容量壓力下仍成立；沒有依賴正常流程才安全的缺口。

工作：

- 建立可重現 fault hooks，逐一覆蓋 admission commit／response、execution claim／launch、generation revoke／late start、answer commit／delivery／ack、candidate outcome／cleanup／terminal commit 的 crash windows。
- 驗證 daemon、worker、supervisor 各自重啟，與重啟時再次 crash；核對命令不造成新 generation 啟動，未知結果不被 TTL 清除。
- 實作並驗證 30 天終態保存、未結案保留、receipt tombstone、cursor 過期、Context 保存及結果容量；提前淘汰新結果不能用來解決磁碟預算。
- 壓滿一般 tombstone 時仍能 reply／cancel／ack；控制 reserve 耗盡或實體儲存失敗時停止負載、由 supervisor 收斂並回 unavailable，不能假接受或放行 claim。
- 測試 DB 延遲／磁碟滿、worker 同步卡死、大量事件、慢 Client、輪詢壓力、巨量序列化、權限撤銷與跨 scope cursor。完成必要的 backpressure、限額與 allowlist 日誌。
- 定義並量測外側回應：在記錄硬體／負載、包含預設 4 個 execution 的可重現情境下檢查 2 秒目標；另外注入無法連線，驗證 Client 5 秒明示不可取得狀態。報告樣本數、最大值與分位數，不只列平均值，也不把 unavailable 算正常查詢成功。

**退出條件 G5：**fault matrix 每列有結果與持久狀態／啟動次數／停止證據；縮短時間或假時鐘測到期限分支，且真 Linux 停止測試不被 fake clock 取代。存在資料遺失、重跑、越權或假停止時不得進 S6。

## 10. S6 — 發行前驗收與操作交付

**成果：**可由相容 MCP AI 交辦方使用的 Linux 首版，並有完整安裝、診斷、停止及恢復文件。

工作：

- 選定至少一個實際可使用指定 MCP revision／認證模式的 AI Agent 跑全流程；官方 SDK Client fixture 留作自動化測試，不能代替真交辦方的相容性紀錄。不指定 Grok 私有介面。
- 在指定測試專案驗證：提交→取得 Task ID→查詢→追加→回答→完成；另跑取消、斷線再查、daemon 重啟、未知結案及明確恢復 queue。
- 驗證最終摘要、檔案清單、檢查證據、未完成事項與實際 Git 資訊。分支／PR 的判斷先用本機 bare remote／模擬 GitHub 命令回應驗證 Runtime 的任務政策，不新增 AgentPort GitHub adapter；實際遠端推送與 PR 只在明確授權的測試 repository 驗證，不從產品能力推定本次外部寫入授權。
- 交付配置範例、Linux supervisor／啟動整合、受保護資料目錄、readiness／doctor、TLS／Client 設定、憑證輪替、停止、故障核對與結果查詢說明。範例不用真秘密；管理者設定路徑，不讓遠端任務改寫。
- 驗證升級／migration、一致備份（包含 WAL 語意）、不相容 schema 拒絕啟動、離線回滾；舊備份恢復後進 recovery，不自動派送。
- 更新 requirements／Technical Design／ADR 與 verification，移除被取代的 fixture-only 啟動方式及未實作工具宣告。macOS 等延後項目明列，不留空實作作為支援證據。

**退出條件 G6：**AC-01–AC-12 全部有可追溯的通過紀錄；安全／儲存／並行經 Sol/high 獨立審查且 material findings 已解決。工具包可交付不等於已發布／部署；正式環境部署、Git 推送或 release 仍依實際任務授權處理。

## 11. 品質命令與驗收對照

`make verify` 是唯一 canonical gate；S0 已接入 repository contract／Story 結構、固定工具鏈、MCP／SQLite compatibility fixture、format、lint、typecheck、build 與 test，後續階段再加入相關產品檢查。依使用者指定採 pnpm 12 作唯一套件管理工具，只保留 pnpm-lock.yaml；本機、Linux 驗證與 CI 使用相同的 exact patch 及 frozen lockfile 安裝，不另產生 package-lock.json 或 yarn.lock。若指定版本與 Node／依賴有實際相容性問題，先記錄證據並交由 ForgePilot Gate，不擅自切換套件管理器或主要版本。

下表是底層檢查，不是平行 PASS authority。無 vendor 憑證的檢查由 `make verify` 統合；Linux／Claude／release 所需外部環境證據另行明確執行並與同一 revision 的 local verify 一起交付。缺必要環境保持未驗證，不能因 local PASS 宣稱該階段完成。

| 命令                           | 用途／環境                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| pnpm install --frozen-lockfile | 根據 pnpm-lock.yaml 重現安裝                                                                   |
| pnpm run check                 | lint、typecheck、build 及不需 vendor 憑證的核心／儲存／fixture 整合檢查                        |
| pnpm run test:mcp              | 官方 Client 驗證版本、認證、工具 schema 及應用結果                                             |
| pnpm run test:linux            | Linux cgroup／supervisor／子程序與 generation fence 契約；缺環境需明確失敗／待執行             |
| pnpm run test:claude           | G1-C 與後續整合使用：真 Claude 非互動及正向澄清／取消／續接；需指定 Runtime authentication     |
| pnpm run test:faults           | 持久 crash windows、容量／DB 故障與恢復；標示各案例需要的 Linux 條件                           |
| pnpm run verify:release        | check＋MCP＋Linux＋Claude＋faults 與發行證據完整性；不得因環境缺少而把必要套件全 skip 後報成功 |

每個切片先跑受影響的最小測試，再於整合 checkpoint 跑該階段必需完整 gates。來源與環境未變的通過結果可重用；修正後重跑受影響測試與同一 reviewer 的 delta，不以重複全掃代替修正。

| Technical Design 驗收 | 首次落地／最終收斂                            |
| --------------------- | --------------------------------------------- |
| AC-01 MCP             | S0、S2／S6 真交辦方                           |
| AC-02 提交／去重      | S2／S5 crash matrix                           |
| AC-03 外側觀察        | S3／S5 量測                                   |
| AC-04 queue           | S4／S5 競爭與容量                             |
| AC-05 澄清            | S1 能力、S4 完整產品／S5 故障                 |
| AC-06 取消／完成      | S1 平台、S3 核心／S5                          |
| AC-07 Crash windows   | S1 fence、S2–S4 各 commit 邊界／S5            |
| AC-08 恢復／續接      | S3 基本恢復、S4 queue／Session／S5            |
| AC-09 資源／期限      | S2 reserve、S3–S4 時鐘／S5                    |
| AC-10 授權            | S0 相容性、S2 scope、S3 launcher、S4 回答／S5 |
| AC-11 交付／通知      | S2 事件、S3 結果／S5 保存、S6                 |
| AC-12 平台／回滾      | S0–S1 版本／Linux／S6 migration 與操作演練    |

## 12. 證據、阻擋與接手方式

verification 每次紀錄包含：階段／AC、source revision 或檔案摘要、OS／版本、命令、fixture、預期與實際、執行／停止次數、結果位置、時間及限制。Task／execution／question ID 可作關聯，但不記 token、環境變數值、完整私密 prompt 或未遮罩 stderr。

Linux metadata、G1-L Linux 執行權限及 G1-C Claude 純等待／停止能力是此計畫的分離外部前提。沒有指定 Linux target 時，macOS、Docker、fake worker、放寬權限、取消 persistence、忽略 generation fence 或改稱不支援互動都不能取代相關驗收；本機已登入的 Claude CLI 也不能取代指定 Runtime account 的 G1-C evidence。所有 Work Item 的 blocker、Gate、verification 與 review 狀態只可由 ForgePilot 宣告；本計畫不直接授權其他階段，也不提供未量測的工期／完成日期。
