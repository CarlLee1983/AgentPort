# Technical Design 技術依據

## 本輪有效來源與歷史範圍

MCP 優先、Claude Code／Linux 的需求基線已確認。本輪補充來源為 [MCP 查證](mcp-evidence.md)及 [Claude 查證](claude-evidence.md)；下列 E-01／E-02 A2A、E-04 Codex、E-06 Cursor 保留為後續擴充的歷史查證，不代表首版需整合三套 Runtime。E-05 的未擷取限制以新的 Claude 查證為準；來源查證不代替固定版本相容性測試。

### 本輪補充：持久化與執行平台

設計選用本機 SQLite 保存任務、事件與操作去重。官方說明支援原子交易；WAL 允許讀寫並行但仍只有單一 writer，且不適合網路檔案系統。設計採短交易、非主事件迴圈的資料庫執行、FULL 同步及受控 checkpoint；這些是 AgentPort 的可靠性選擇，不代表已量測延遲或驗證磁碟故障。

來源：[SQLite 交易](https://www.sqlite.org/transactional.html)、[WAL](https://www.sqlite.org/wal.html)。使用含適用修正的固定 SQLite 版本，實作時核對官方 WAL 已知問題，不能僅依 Node 或套件名稱推定內嵌 SQLite 版本。

Linux 的 cgroup 存活與子樹停止語意仍支持原 E-07 的執行資源邊界；它不保證模型成功、撤回 GitHub 等外部副作用或隔離同帳號檔案。Node 24 作設計基線，實作時固定受支援 patch 與依賴版本。來源：[Kernel cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)、[Node release 表](https://nodejs.org/en/about/previous-releases)。

查證日期：2026-09-12。這是 [Technical Design](technical-design.md) 的來源紀錄。查證方式為官方文件閱讀與 authenticated gh 唯讀取得 SDK 原始碼；沒有安裝 SDK、啟動 Runtime 或執行生成請求。

「已查證」代表來源中明確存在，不能代替 AgentPort 的相容性／安全測試。主文件中的上限、隔離範圍與介面形狀是 AgentPort 設計選擇，並非官方推薦值。

## E-01 A2A 協定

官方 v1.0 文件採 PascalCase JSON-RPC methods，包括 SendMessage、SendStreamingMessage、GetTask、CancelTask、SubscribeToTask。原提案的 slash methods 屬舊版命名。1.0 SendMessage 的 returnImmediately 未設定時預設等待；SubscribeToTask 不接受終態工作。串流使用 SSE，並以 StreamResponse 包裝事件。

來源：[1.0 變更](https://a2a-protocol.org/latest/whats-new-v1/)、[協定 §3、§9](https://a2a-protocol.org/latest/specification/)。latest URL 會變動，實作時應與固定 SDK 版本一起留存相容性依據；本文不是逐字複製規範。

## E-02 A2A JavaScript SDK

透過 gh 確認官方 repo 為 a2aproject/a2a-js，已發布 v1.1.0，日期 2026-08-26。SDK 套件版本 1.1.0 與協定版本 1.0 是不同維度。此次讀取的 runtime handlers 固定在 tag v1.1.0。

來源：[release v1.1.0](https://github.com/a2aproject/a2a-js/releases/tag/v1.1.0)。

公開 A2ARequestHandler 可由應用實作；包含 send/get/list/cancel/stream/resubscribe、Agent Card 與 push methods。JsonRpcTransportHandler 是公開 export，可使用官方 dispatcher／序列化而保留自有 HTTP 邊界。

來源：[handler contract](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/server/request_handler/a2a_request_handler.ts)、[server exports](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/server/index.ts)、[JSON-RPC transport](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/server/transports/jsonrpc/jsonrpc_transport_handler.ts)。

DefaultRequestHandler 讀寫 TaskStore，建立 execution context 並處理事件／取消。依此推論：若核心已有 Task 生命週期擁有者，直接再套此預設 handler 會需要雙重狀態協調。本設計選 custom A2ARequestHandler，避免該責任重複。

來源：[DefaultRequestHandler](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/server/request_handler/default_request_handler.ts)。

官方 Express handler 有 SSE 格式處理及 v0.3 compatibility 開關，但也直接寫 socket／console error。AgentPort 需要自己的 bounded HTTP 邊界，確保背壓、斷線釋放與敏感錯誤處理；不以預設 middleware 存在就認定這些保證已成立。

來源：[Express handler](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/server/express/json_rpc_handler.ts)、[version validation](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/server/version.ts)、[SDK errors](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/errors/json_rpc.ts)。

本次讀取 package metadata 顯示 Node >=20、Express optional peer，且有獨立 gRPC entrypoints；另以 v1.1.0 tag 核對套件版本與 Node engines。不代表 AgentPort 必須啟用所有 transport。實作時將選定的 1.1.0 套件與 peer requirements 一起固定。[Package metadata](https://github.com/a2aproject/a2a-js/blob/v1.1.0/package.json)

v1.1.0 的 ServerCallContext 在缺少或空版本時採 0.3，因此僅宣告 1.0 的 AgentPort 需拒絕此請求，不能當成 1.0。[Server context](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/server/context.ts)

## E-03 Node 與通用依賴

Node 官方 release 表目前列出 24 為 LTS、20 為 EOL，因此主文件選 Node 24，而非沿用原提案的 >=20 作部署基線。[Node releases](https://nodejs.org/en/about/previous-releases)

TypeScript、Express、zod、yaml、pino、vitest 維持原提案方向，版本在實作前固定。用途分別是程式型別、HTTP、設定驗證、YAML 讀取、結構化日誌與測試；本輪未安裝或執行相容性檢查。程序控制優先使用 Node 內建能力；只有實作顯示 execa 能減少整體複雜度時才新增，不先建立兩套支援。

## E-04 Codex

官方 TypeScript SDK 文件明確提供建立、延續與依 thread ID 恢復本機對話。本文保留 SDK 優先方向，但沒有從簡介頁推定完整取消契約。[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

官方 non-interactive 文件記載 exec 的 JSONL 事件、指定 Session resume，以及自動化的權限／認證注意事項。這支持結構化 CLI 作可行備選；不支持把人類 stdout parser 當穩定契約。[Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

尚待固定版本核對與測試：TypeScript SDK 的 cwd/options、AbortSignal／強制停止、程序樹清理、成功後 quiescence、Project config 載入與不同權限設定下的續接。沒有執行本機 Codex probe 或測試工作。

## E-05 Claude

官方 Agent SDK 支援本機工具執行與 Session；與直接 API Client SDK、Managed Agents 是不同產品，主設計使用 Agent SDK。[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

streaming input 提供互動及中斷能力，single-message 模式有限制，因此主設計選前者作可控 turn 的評估方向。[Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

官方文件另有 Session、權限／使用者輸入及增量輸出流程；這些支援 Driver 邊界設計，但不代表本版已實作遠端批准。[Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)、[User input](https://code.claude.com/docs/en/agent-sdk/user-input)、[Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)

headless 文件區分 SIGTERM 與中斷工作：程序終止可能留下未完成 turn。因此本設計不允許 canceled Session 自動續接，並要求 Driver 的停止證據。[Headless CLI](https://code.claude.com/docs/en/headless)

TypeScript 完整 reference 在本次 web 擷取因頁面過大失敗；其他 URL 曾重導到 overview，未將重導內容當作完整 API reference。精確 SDK option／binary 選擇與版本仍待查證，未引用記憶中的 API 當作定案。

## E-06 Cursor

官方確認 agent acp 使用 stdio、JSON-RPC 2.0 與 newline-delimited framing；涵蓋 initialize、authenticate、session/new/load、session/prompt、session/update 與 session/cancel。

session/request_permission 需要回覆；Cursor 的 ask_question／create_plan 也可能阻塞。文件範例的自動 allow-once 不是 AgentPort 授權政策，不能直接照搬。ACP capability 與安裝版本仍需真實測試。[Cursor ACP](https://cursor.com/docs/cli/acp)

尚待驗證：取消後 stop reason 與工具停止時序、Session idle 是否仍有背景工作、版本差異、子程序終止與 cwd 精確綁定。print mode 不作同一 Task 的自動 fallback。

## E-07 Linux 執行資源邊界

Linux cgroup v2 提供子樹存活狀態 populated，以及透過 cgroup.kill 結束整個子樹的語意。這支持以 execution unit 為本機停止邊界，不代表它隔離檔案／網路或能撤回外部服務工作。[Kernel cgroup v2](https://cdn.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)

每個 Task 使用獨立單位、Runtime 不取得 migration／控制權限、終態前關閉程序並確認 populated=0，是 AgentPort 的設計選擇。受控 launcher 的平台整合與 SDK 相容性尚未實作或驗證；沒有執行 cgroup、服務配置或系統權限變更。

## 查證結論

目前官方來源足以支持協定選擇與整合邊界，未足以宣稱三套 Driver 皆已滿足 AgentPort 的取消、隔離、設定載入與續接契約。這些是後續 contract tests 的對象，不是本輪設計文件的執行成果。
