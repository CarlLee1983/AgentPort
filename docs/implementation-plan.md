# AgentPort v0.1 實作計畫

日期：2026-09-12。狀態：計畫文件；所有實作階段尚未開始，沒有安裝依賴、建立程式骨架、啟動 Runtime 或部署。

依據：[已確認需求](delegation-requirements.md)、[Technical Design](technical-design.md)、[術語表](../CONTEXT.md)。技術設計定義行為，本文件定義執行順序與驗收；兩者衝突時先修正計畫，不以方便實作為由降低已確認需求。

## 1. 首版成果與範圍

完成的使用流程是：具相容 MCP 能力的交辦方選取已配置 Agent，提交工作取得 Task ID；Linux 上的 Claude Code 執行修改／測試，交辦方可從外側查詢、追加、回答問題或取消，最後取得結果。服務重啟仍可查任務，且不自動重跑或重送答案。

首版必須同時具備外側控制、持久任務、可靠停止及正向澄清往返；只有 fake worker、SDK 呼叫成功或 MCP tools/list 成功，都不能宣告首版完成。分支推送與 PR 依任務／專案規則，不是所有任務的必需產出。

macOS、A2A、其他 Runtime、排程、LINE／Telegram、公開多租戶、遠端提權與任意檔案下載不列入這次實作。現有目錄只有文件，且不是 Git worktree；本計畫不建立 Git 歷史，後續若要以 PR 交付程式，須先確定實際 repository。

## 2. 順序與階段門檻

| 階段 | 交付的可觀察能力 | 依賴 | 狀態 |
| --- | --- | --- | --- |
| S0 | 可重現工具鏈與版本／契約檢查；MCP Client 相容性已證實 | 無 | 未開始 |
| S1 | 本機受控 execution 可啟動／停止，真 Claude 可提問並取得回答 | S0 | 未開始 |
| S2 | 經授權 MCP 提交→持久 queued Task→查詢／取消；重啟不遺失 | S0、S1 的必要能力證據 | 未開始 |
| S3 | MCP→核心→受控 Claude execution→結果／取消，並具基本恢復 | S1、S2 | 未開始 |
| S4 | 完整追加佇列、修改、澄清往返與明確續接操作 | S3 | 未開始 |
| S5 | 崩潰、容量、儲存及效能情境下仍符合控制與恢復契約 | S4 | 未開始 |
| S6 | 通用 MCP 交辦方的首版全流程驗收與可操作的 Linux 發行包 | S5 | 未開始 |

主要路徑為 S0 → S1 → S2 → S3 → S4 → S5 → S6。S0 內的 MCP 相容性與 Linux 靜態環境檢查可獨立進行；不因可並行而讓多個人同時修改生命週期／儲存邊界。

S1 將最可能推翻整合選擇的能力提早驗證；其 harness 只在指定 Linux fixture 使用，不是略過核心授權與持久化的產品入口。S3 開始真正派送前就必須有持久 claim、啟動撤銷、取消及重啟停止規則，不能留到 S5 才補上；S5 是擴大故障驗證，不是延後可靠性實作。

每階段完成時保存檔案變更、命令、版本、測試結果及未解事項。階段只有在退出條件通過後才標完成；缺少 Linux 或 Runtime 憑證標記待環境，不以跳過測試作為通過。

## 3. 建議程式邊界

下列是實作時逐步建立的責任位置，現在並不存在；以最小內聚檔案開始，不預建空 class、通用 repository framework 或第二份狀態機。

| 建議位置 | 責任／主要擁有者 |
| --- | --- |
| src/core/ | Task／Context／Question、唯一應用服務、狀態及授權；主代理 |
| src/storage/、migrations/ | SQLite 交易、receipt、claim、事件、reserve 與恢復資料；主代理 |
| src/mcp/ | 官方 SDK、工具 schema、Principal 轉換與錯誤投影；穩定核心契約後可分派 |
| src/runtime/claude/、src/runtime/worker/ | Claude Driver、受限 IPC、事件及回答 ack；主代理負責控制語意 |
| src/supervisor/ | Linux execution generation、啟動／撤銷／停止證據；主代理 |
| src/bootstrap/ | 配置、Registry、組裝、readiness／doctor；不含另一套排程 |
| tests/unit/、tests/integration/、tests/contracts/、tests/e2e/、tests/fixtures/ | 對應行為、真儲存、worker、MCP、Linux／Claude 及故障 fixture |
| docs/operations.md、docs/verification.md | 操作程序與實際驗證紀錄；隨切片更新 |

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

## 5. S1 — 受控 Linux execution 與真 Claude 可行性

**成果：**本機 harness 能觀察與停止 execution，並證明 Claude 的必要互動能力。此階段只操作指定測試目錄，不開放遠端任務派送。

工作：

- 實作最小可重用 supervisor／launcher 及 worker IPC 契約：executionId／generation、持久撤銷、開始前放行點、停止證據；supervisor 狀態與 Runtime 帳號權限分離。
- 先用不呼叫模型的 fixture 驗證啟動、取消早於啟動、延遲 start、supervisor 重啟、同步卡住 worker、子程序／detached 子程序的停止。generation 封閉且 cgroup 空才可說停止完成。
- 在已驗證的受控 execution 內接入真 Claude SDK：明確 cwd／設定來源，取得結構化結果；刻意觸發 AskUserQuestion、保留原生待決回呼、提供有效答案並繼續同一 harness 工作。
- 驗證 AskUserQuestion 與一般權限請求分流；確認進入純等待前沒有仍在執行的平行工具。不能把所有 canUseTool 自動 allow 或將普通 assistant 問句當成等待回呼。
- 驗證執行中／等待中取消、成功後 cleanup 與安全 Session reference；記錄事件順序、原生 tool-use 關聯及 SDK 控制行為，形成後續 Driver contract fixtures。

**退出條件 G1：**真 Claude 正向「提問→回答→繼續」及可靠停止有證據；沒有孤兒 execution，晚到 start 無法在取消後重新啟動。若 SDK 模式無法保證純等待或控制邊界，暫停依賴此能力的 S2–S4，先以證據修正 Driver 選擇；不能改用 fake 通過或刪掉澄清要求。

## 6. S2 — MCP 到持久任務的第一個切片

**成果：**交辦方取得穩定 Task ID，能跨重啟查詢並取消尚未啟動的工作；此切片尚未派送 Runtime。

工作：

- 建立核心公開型別與唯一 AgentExecutionService；SQLite 初始 migration 保存 Task、Context、BindingSnapshot、receipt、event、claim，以及接下來問題／execution 所需的穩定關聯。
- 實作管理者 Registry、scope／principal 分離、固定 Workspace identity 與 Agent allowlist；MCP 請求不能覆寫路徑、binary、政策或身分。
- 完成 list_agents、submit_task、get_task、list_tasks、get_events 及未啟動 cancel_task。僅發布已實作且具正確語意的工具，不以空成功結果代替其他工具。
- submit 的 Task／receipt／事件先原子 commit 再回覆；原始 operation fingerprint 不隨後續 Task 更新改變；跨重啟去重、queued→paused、取消 queued、事件 cursor 與基本 result projection 一起落地。
- 從一開始區分一般 admission 與既有 Task 控制容量，確保 accepted Task 已保留取消／結案紀錄空間。SQLite I/O 不在控制事件迴圈阻塞。

**退出條件 G2：**真 SQLite＋官方 MCP Client 驗證同鍵同時提交只建一個 Task、回應遺失後同鍵取得原 ID、重啟保留紀錄且 queue 暫停、跨 scope 操作拒絕。提交或 DB commit 失敗時沒有執行副作用；這只是 durable admission 切片，不是首版完成。

## 7. S3 — 派送、結果、取消與基本恢復

**成果：**單項 MCP 工作能經核心交給 S1 的受控 Claude worker，回傳最終結果；外側查詢／取消不等模型。

工作：

- dispatcher 在短交易內建立 execution、取得唯一 Workspace claim、標 starting，再呼叫 launcher。將核心取消／recovery 與 supervisor generation 撤銷接起來；所有停止確認含「不會再有未來 start」。
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

目前沒有下列命令；由 S0 建立，後續階段加入對應實際測試。依使用者指定採 pnpm 12 作唯一套件管理工具，只保留 pnpm-lock.yaml；本機、Linux 驗證與 CI 使用相同的 exact patch 及 frozen lockfile 安裝，不另產生 package-lock.json 或 yarn.lock。若指定版本與 Node／依賴有實際相容性問題，先記錄證據處理，不擅自切換套件管理器或主要版本。

| 擬建立命令 | 用途／環境 |
| --- | --- |
| pnpm install --frozen-lockfile | 根據 pnpm-lock.yaml 重現安裝 |
| pnpm run check | lint、typecheck、build 及不需 vendor 憑證的核心／儲存／fixture 整合檢查 |
| pnpm run test:mcp | 官方 Client 驗證版本、認證、工具 schema 及應用結果 |
| pnpm run test:linux | Linux cgroup／supervisor／子程序與 generation fence 契約；缺環境需明確失敗／待執行 |
| pnpm run test:claude | 真 Claude 的非互動及正向澄清／取消／續接；指定測試目錄與 Runtime 認證 |
| pnpm run test:faults | 持久 crash windows、容量／DB 故障與恢復；標示各案例需要的 Linux 條件 |
| pnpm run verify:release | check＋MCP＋Linux＋Claude＋faults 與發行證據完整性；不得因環境缺少而把必要套件全 skip 後報成功 |

每個切片先跑受影響的最小測試，再於整合 checkpoint 跑該階段必需完整 gates。來源與環境未變的通過結果可重用；修正後重跑受影響測試與同一 reviewer 的 delta，不以重複全掃代替修正。

| Technical Design 驗收 | 首次落地／最終收斂 |
| --- | --- |
| AC-01 MCP | S0、S2／S6 真交辦方 |
| AC-02 提交／去重 | S2／S5 crash matrix |
| AC-03 外側觀察 | S3／S5 量測 |
| AC-04 queue | S4／S5 競爭與容量 |
| AC-05 澄清 | S1 能力、S4 完整產品／S5 故障 |
| AC-06 取消／完成 | S1 平台、S3 核心／S5 |
| AC-07 Crash windows | S1 fence、S2–S4 各 commit 邊界／S5 |
| AC-08 恢復／續接 | S3 基本恢復、S4 queue／Session／S5 |
| AC-09 資源／期限 | S2 reserve、S3–S4 時鐘／S5 |
| AC-10 授權 | S0 相容性、S2 scope、S3 launcher、S4 回答／S5 |
| AC-11 交付／通知 | S2 事件、S3 結果／S5 保存、S6 |
| AC-12 平台／回滾 | S0–S1 版本／Linux／S6 migration 與操作演練 |

## 12. 證據、阻擋與接手方式

verification 每次紀錄包含：階段／AC、source revision 或檔案摘要、OS／版本、命令、fixture、預期與實際、執行／停止次數、結果位置、時間及限制。Task／execution／question ID 可作關聯，但不記 token、環境變數值、完整私密 prompt 或未遮罩 stderr。

最優先處理的阻擋是 S0 Client／版本相容、S1 Linux 執行權限及 Claude 純等待／停止能力；沒有證據時先完成可獨立驗證的部分，保留依賴階段為未完成。不得以放寬權限、取消 persistence、忽略 generation fence 或改稱不支援互動來通過驗收。

下次開始實作的第一步是 S0：確認實際程式工作目錄與 Linux 測試目標、建立最小工具鏈並固定版本。這份計畫不直接執行任何階段，不提供未量測的工期／完成日期；S1 通過後再按實際 fixture、依賴及問題量估算剩餘工作。
