# AgentPort development workflow

ForgeFlow 是 engineering protocol；ForgePilot 是 engineering control plane；AgentPort 是正在開發的產品。
ForgePilot 管理「開發 AgentPort 的 Work Item」，不是 AgentPort scheduler、runtime manager 或 Runtime Driver。
ForgeFlow／ForgePilot 不加入 AgentPort runtime dependency，也不改寫產品 domain。

```text
Human Intent + Architecture / ADR
    ↓
ForgeFlow Story
    ↓
ForgePilot Work Item
    ↓
Coding Agent
    ↓
make verify
    ↓
ForgePilot Verification Evidence
    ↓
Human Review
```

產品責任仍是 `Caller → AgentPort → Logical Agent → Workspace + Runtime`。
產品術語與邊界由 [CONTEXT](../CONTEXT.md)、[Technical Design](technical-design.md) 及相關 ADR 定義；
讀取順序見 [domain docs](agents/domain.md)。AgentPort domain／ADR 優先於 ForgeFlow guidance。
目前核准 Story 定義該次 product requirement；若它與架構／ADR 衝突，開 Gate 交人類決定，不能自行重新設計。

## Repository contract

本次 selective adoption 來源：ForgeFlowV2 **0.7.0**，clean revision
`cb4bc97673ad3098a4689a1589e1f2c4b5175c63`。`specs/.forgeflow-adoption` 記錄來源。
官方 `scripts/bootstrap --dry-run .` 因現有 AGENTS.md 拒絕覆蓋；以官方 bootstrap 在空暫存目錄產生內容，
採用 guidance／Story templates／marker，人工 merge AGENTS.md，保留 Issue tracker、Triage labels、Domain docs 與 single-context 規則。
沒有執行 `bootstrap --force`，CONTEXT／technical design／ADR 的產品內容保持原樣。

`guidance/ENTRY.md` 路由相關 engineering guidance；它是建議，不新增隱藏 AC。
`guidance/DECISIONS.md` 的官方 Example 不是 AgentPort ADR，也不另建產品決策 authority。
`_template/task.md` 是官方通用模板；在 AgentPort 建立正式 Story 時，將其改為工作分解與 notes，
不要用 execution status／claimed／done checkbox 複製 ForgePilot lifecycle。`acceptance.md` 的 checkbox 只表示 AC 證據。

唯讀官方 Story checker 以固定副本置於 [scripts/forgeflow](../scripts/forgeflow/README.md)，附 MIT notice。
它由 repository Makefile 呼叫，fresh checkout 不必安裝 ForgeFlow 或 ForgePilot。
後續更新須檢查 bootstrap dry-run／diff，保留 repository-owned AGENTS/guidance，再更新 marker、templates 與 checker 來源紀錄並跑 `make verify`。

## Story 與 migration source

`.scratch` 不是 implementation lifecycle authority。它保留 research、temporary planning、historical design material 與 migration source。
正式 implementation 工作需提升為 ForgeFlow Story，其執行狀態由 ForgePilot Work Item 管理。
舊 Status／claimed／resolved 不與 ForgePilot 同步；[tracker](agents/issue-tracker.md) 與 [triage labels](agents/triage-labels.md) 僅管理研究／triage。
Implementation Plan 的階段表只保存依賴與驗收設計，不另維護正式執行狀態。

最初提升 [ticket 01](../.scratch/agentport-v0-1/issues/01-mcp-version-compatibility.md) 為
[AP-001 — Establish Toolchain and MCP Compatibility Baseline](../specs/stories/AP-001-toolchain-mcp-compatibility/story.md)，對應 S0／G0；
後續 [AP-002 — Build Platform-neutral Durable Admission](../specs/stories/AP-002-platform-neutral-durable-admission/story.md) 依平台 sequencing 決策對應 S2／G2。
其餘舊 issues 原樣保留。新 Story 使用 `_template` 的 story／acceptance／task 三檔；
實作前必須確定 scope、authority、AC、evidence map 與必要 security fixture matrix。
Coding Agent 依 AGENTS.md 執行；需求改變須經人類核准，不能從 guidance 或工具能力推定授權。

## Canonical verification 與 fresh checkout

唯一 canonical local gate：

```sh
make verify
```

治理階段僅需 OS 提供的 GNU Make 3.81 或更新版本、POSIX `/bin/sh` 及 `grep`（支援 `-E`）。
在 repository 根目錄執行即可，不需 Node、pnpm、Python、ForgeFlow／ForgePilot CLI、network、Git metadata 或 vendor credential。
Makefile、check scripts、所需 guidance、Story 與文件必須一起納入 Git。
初始 gate 檢查 required nonempty files、merge marker／Makefile 一致性、adoption marker、shell syntax，
並由官方 checker 驗證所有非 template Story 的最低 READY 結構、classification、AC 與 evidence map。
它不執行 map 內的命令，不宣稱工具鏈／產品行為已被測試。

AP-001 才建立 repository-declared exact Node／pnpm 12 與 frozen lockfile setup，將真正的 format、lint、typecheck、build、
unit、integration、contract、acceptance checks 逐步接到 `make verify` 的 prerequisites。
尚未存在的層不建空 PASS target。pnpm scripts 或其他底層命令可以被 Makefile 呼叫，但不成為平行 PASS authority。
不得依賴未 commit 檔案、私人 .env、既有 node_modules／build output、shell alias 或私人 PATH hack。

真 Linux／Claude credential 或其他外部前提的檢查使用 explicit environment/e2e verification，記錄確切命令、目標 metadata、
source revision、expected／actual、結果與限制，避免真秘密进入文件或 log。
local verify 不因缺 vendor credential 被阻擋；必要 environment AC 缺證據仍是 blocked／未完成，不能以 local PASS 代替 G0／G1／release 驗收。
例如 AP-001 的 Linux metadata 是 explicit evidence，真 Claude 正向互動與 Linux execution 屬 S1。

乾淨驗證時使用新的 checkout，只按 repository 文件安裝宣告依賴，執行 `make verify`；既有 cache／.forgepilot 不應被帶入。
尚未獲准 commit 的文件導入可先以獨立暫存 index 與 checkout-index 匯出完整候選 tree，
在清空環境的隔離目錄檢查可重現性。這是 pre-commit snapshot evidence，不能冒稱 ForgePilot 已驗證 HEAD。

## ForgePilot local state 與操作

從 repository 根目錄初始化；這是本次治理導入的操作：

```sh
forgepilot init
forgepilot goal create --id agentport-v0-1 --title "AgentPort v0.1"
forgepilot work add --goal agentport-v0-1 --story specs/stories/AP-001-toolchain-mcp-compatibility
forgepilot status
forgepilot next
```

使用 CLI 回傳的實際 Work ID；不要假定 Story ID 與 Work ID 相同。無前置依賴的第一個 Work Item 應為 READY。
`init` 依 ForgePilot 自身契約建立 `.forgepilot/state.json` 與 locks，並自行將 `.forgepilot/` 加入根 `.gitignore`。
local state、verification logs／worktrees 不進 Git；不手改 state JSON、不自行改變 persistence contract。
fresh checkout 不攜帶這份 local lifecycle；管理者使用 CLI 重新初始化／加入所需工作。不要把重建的狀態說成還原了歷史 evidence。
`init` 可重複執行，goal create／work add 是新增操作；重試先看 status，避免重複 Work Item。

新 Work Item 建立後預設停在 READY，不執行 start、verify 或 review approve。只有使用者明確交辦 Start 該 Story 後，才對實際 Work ID 執行 `forgepilot start`。
Story 的 scope／authority 不因 READY 自動生效為當前執行授權；既有 Work Item 的歷史狀態與 evidence 以 `forgepilot status` 為準。

實作完成並取得 commit 授權後，提交所有必要檔案；保持 worktree clean，再對 RUNNING／REVIEW Work Item 執行：

```sh
forgepilot verify WI-001
forgepilot status
```

上面的 WI-001 僅示例，必須換成 status 的實際 ID。ForgePilot 對完整 committed HEAD 建 detached worktree，執行固定 `make verify`，
保存綁定該 revision 的結果與 log。未追蹤檔案也會使工作樹不乾淨；不以 ignore 必要檔案繞過檢查。
本機手動 PASS 與 Story checker PASS 都不能手填為 ForgePilot Evidence。
來源變更後重新 verification；過期 revision 的 evidence 不能批准新內容。

Human Review 檢查所有 AC 對照、local 與 environment evidence、diff、決策、未解 Gate／residual risks。
PASS 只代表可以準備 review，不自動代表 DONE 或產品 ready；人類才可執行 review approve。
review 要求行為修改時回到實作與 verification；需求／架構改變走 Gate 與人類核准的 Story 修訂。

## Gate 規則

下列**未定義或需要改變既有決策**的問題，Coding Agent 停止受影響工作，使用 `forgepilot gate open`，
提供現有文件／證據、可選方案與影響，交由人類決策：

* domain boundary。
* security policy。
* workspace access semantics。
* runtime isolation semantics。
* task lifecycle semantics。
* protocol compatibility decision。
* scope expansion。
* public API semantic change。

已明確定義的規則直接遵循，不為每個實作細節重開 Gate；未決的必要環境存取則記 blocked，需人類選擇／授權時開 Gate。
範例（僅說明 CLI 語法，不表示此題目前未決，也不授權現在建立）：

```sh
forgepilot gate open \
  --work WI-001 \
  --question "Workspace 是否允許 symbolic link 指向外部目錄？" \
  --option "禁止" \
  --option "允許但 canonicalize" \
  --reason "此選擇會改變 Workspace security boundary"
```

Open Gate 會阻擋相關 Work Item 推進；不要自行 resolve／cancel 以求 PASS。
人類作決策後依 CLI 的 gate resolve 流程記錄，必要時先修訂／核准 Story 或 ADR，再繼續實作。
Gate 是工程治理紀錄，不是 AgentPort Task 的 Clarification Reply 或 runtime 控制訊息。

## 治理導入範圍與回復

初始治理導入沒有 S0 toolchain／產品實作，當時 AP-001 AC 全部待執行；目前進度以 Story verification 與 ForgePilot evidence 為準。治理規則本身不安裝 Claude runtime、建立產品 src 模組或批准 domain／ADR 變更。
規則集中於 repository AGENTS.md，詳細操作在本文件；不改全域 Codex 設定。
驗證包含 make verify 的正反例、隔離候選 tree，以及獨立 agent 的規則／邊界審查。
若需撤回導入，由人類檢閱此次 diff 後回復治理檔案與 tracker 註記；先保存 `.forgepilot` 歷史 evidence，再決定是否移除 local state，避免將它當成可重建的測試 cache。
