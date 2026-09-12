# Story: AP-001 — Establish Toolchain and MCP Compatibility Baseline

## Goal

建立 AgentPort 可重現的 Node / TypeScript 開發與驗證基線，
並確認 MCP、Claude Agent SDK、SQLite 與 Linux execution 所需版本與 capability 契約。

## Context

對應 [Implementation Plan S0 / G0](../../../docs/implementation-plan.md)。
來源為 [原始票據 01](../../../.scratch/agentport-v0-1/issues/01-mcp-version-compatibility.md)；
此 Story 是第一個正式實作需求，原票保留 migration source 身份。
治理導入只建立 Story 與 READY Work Item；本 Story 的實作由下一次明確交辦開始。

產品語意遵循 [CONTEXT](../../../CONTEXT.md)、[Technical Design](../../../docs/technical-design.md)
與 [ADR](../../../docs/agents/domain.md)。ForgeFlow／ForgePilot 不加入產品 domain 或 runtime dependency。
現有版本數字是待查證候選，不是已證實的 exact version 或 capability。

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: mixed

## Authority

以下權限僅適用使用者交辦 Start AP-001 之後；本次治理導入不執行。

* plan: yes
* modify: yes
* add_dependency: yes
* migration: no
* commit: no
* push: no
* deploy: no

依賴僅限 AC 所需 Node／TypeScript 工具與相容性 fixture 的固定套件。
允許檢查固定 Claude SDK 型別／套件 metadata，不允許安裝或啟動真正 Claude coding runtime。

## Architecture

* Impact: low
* Boundary: `development toolchain and loopback-only compatibility fixtures`
* Contract: `AgentPort domain and accepted ADR semantics remain unchanged`
* Owner: `development toolchain and loopback-only compatibility fixtures = AgentPort maintainers`

## Risk

* Level: high
* Reason: `versioned protocol and authentication fixture`

## Scope

### In Scope

* Node / TypeScript toolchain：最小可安裝、檢查與測試的專案基線。
* pnpm 12：查證後的 exact patch，唯一 package manager 與 pnpm-lock.yaml。
* MCP compatibility：官方 Client 與受限本機 fixture 的 Streamable HTTP、每請求協定資料、tools/list、tools/call、schema、回應及失敗契約。
* Claude capability investigation：固定 SDK 的 query streaming input、cancellation、AskUserQuestion／canUseTool、cwd、settingSources、resume 型別與契約查證；不啟動模型。
* SQLite compatibility：binding／實際 SQLite runtime 版本、Node 相容性、WAL 修正來源及 I/O 不阻塞控制事件迴圈的可用方式；不建 Task storage。
* Linux target metadata：OS、cgroup v2、service account、launcher permission、protected data directory 與 credential 來源是否可用的非秘密紀錄。
* Verification baseline：fresh checkout 安裝、deterministic checks、`make verify` 與 AC evidence。

### Out of Scope

* 真正執行 Claude coding task 或啟動 AgentPort coding runtime。
* Task persistence、Runtime dispatch、Agent Registry implementation。
* MCP production API／server、submit_task、list_agents、Runtime Driver、SQLite Task storage。
* A2A、multi-runtime，以及 S1–S6 的產品模組。
* 建立 src/core、src/storage、src/mcp、src/runtime、src/supervisor、src/bootstrap。

## Inputs

* [Technical Design](../../../docs/technical-design.md) 的版本、MCP 與 G0 前提。
* [MCP evidence](../../../docs/mcp-evidence.md)、[Claude evidence](../../../docs/claude-evidence.md)、[technical evidence](../../../docs/technical-evidence.md) 是既有來源線索，執行時重新確認所選 exact version。
* [Local transactional store ADR](../../../docs/adr/0003-local-transactional-task-store.md) 仍為 proposed；相容性調查不會自動批准此 ADR。

## Outputs

* 最小 Node／TypeScript 配置、唯一 lockfile、deterministic format／lint／typecheck／build／test 與 MCP fixture 命令，由 `make verify` 統合 local gate。
* `docs/toolchain-compatibility.md`：exact version matrix、安裝指令、套件來源、Linux prerequisites、SDK／SQLite 能力與限制。
* 本 Story 的 `verification.md`：AC-01–AC-12 的命令、fixture、source revision／摘要、預期／實際結果、時間與限制；ForgePilot 保存該 committed revision 的 local verification evidence。

## Rules

* R1: 官方 Client 必須實測設計選定 revision；「protocol negotiation」指每請求獨立宣告並驗證 version、client info、capabilities。缺必要協定資料／legacy lifecycle 明確失敗；不使用 initialize／initialized／Mcp-Session-Id 生命週期，不加隱藏 legacy fallback。
* R2: fixture 僅綁定 loopback，使用合成且獨立的 bearer 映射測試 Principal；Client 輸入不能指定或覆寫身分，不接收真秘密、不啟動 Runtime、不提供產品工具。錯誤、console、verification 與 ForgePilot log 不保存 token。
* R3: structuredContent 必須符合 outputSchema，JSON TextContent 表達相同內容；未知工具、無效 schema、未支援 revision 與認證失敗有明確可觀察結果。
* R4: 真 Linux／Claude 正向執行屬 S1；SDK 型別查證不冒充 query、提問／回答或可靠停止的 Runtime 實測。缺必要 Linux metadata 記 blocked，不能把缺證據算 AC 通過。
* R5: 不相容、未定義的安全／協定決策或 scope 變更，依 development workflow 停止受影響工作並開 ForgePilot Gate；不得弱化 AC。

## Expected Errors

* 缺少或無效 bearer：HTTP 401，未執行工具，回應與輸出不洩漏 token。
* 未支援 protocol revision：選定 SDK／revision 定義的明確 protocol error，未執行工具，不默默 fallback。
* 未知工具／無效輸入：明確 protocol/schema error，無產品副作用。
* frozen lockfile 不一致、缺工具或驗證失敗：nonzero exit；缺外部前提的 evidence 標 blocked，保留原因。

## Dependencies

* 無前置 Work Item。使用既有 repository contract；目前只有治理檢查，沒有完成 S0。
* 執行時需要可取得固定 dependency 的來源與指定 Linux 目標 metadata；任何不可取得項目保留為未驗證並交由 Gate 處理需人類決策的部分。

## Constraints

* 不建立沒有立即用途的 framework / abstraction。
* 不實作未被 AP-001 驗收要求的 AgentPort product module。
* 版本必須為實際確認後的 exact version；不以浮動 latest 或既有候選數字充當驗證結果。
* fresh checkout + repository-declared dependencies + deterministic setup；local verify 不依賴私人 .env、既有 node_modules／build output、shell alias 或私人 PATH hack。
* `make verify` 永遠是 canonical gate。需要外部環境的檢查明確分開，仍是相關 AC／階段 Human Review 的必要 evidence。

## Guidance

* [Engineering entry](../../../guidance/ENTRY.md)：最小內聚變更、行為測試、明確依賴。
* [Development workflow](../../../docs/development-workflow.md)：權威、Gate、verification 與 Human Review。

## Trust Boundary Fields

* `Authorization` — fixture HTTP bearer，來自測試 Client。
* `protocolVersion` — 每請求外部協定 revision。
* `clientInfo` — 每請求 Client identity metadata。
* `capabilities` — 每請求 Client capability metadata。
* `request.id` — JSON-RPC request correlation，來自測試 Client。
* `request.method` — JSON-RPC method，來自測試 Client。
* `tool.name` — tools/call 的工具名稱。
* `tool.arguments` — tools/call 的外部參數。
* `tool.structuredContent` — fixture 回傳的結構化結果。
* `tool.textContent` — fixture 回傳的 JSON TextContent。
* `error.details` — 外部輸入衍生的錯誤資訊，不得回傳 bearer。
* `evidence.label` — 測試 Client metadata 衍生的 evidence 標籤，不得夾帶 bearer。
