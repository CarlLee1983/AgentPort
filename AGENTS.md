# AgentPort

## Development workflow

本 repository 採 ForgeFlow engineering protocol；ForgePilot 管理正式 implementation lifecycle。
兩者都是開發治理工具，不是 AgentPort runtime dependency，也不定義產品 domain。

1. 先讀 `CONTEXT.md`；探索程式、撰寫 Story 或處理票據時，依下方 Domain docs 讀取相關 ADR 與設計。
2. Product requirement 以目前已核准 Story 為準。實作前讀 `story.md`、`acceptance.md` 的每項 AC 與 Acceptance Evidence，確認方法、fixture／前提與預期觀察完整；再讀 `task.md` 的工作計畫。
3. 讀 `guidance/ENTRY.md`，僅載入相關 guidance；AgentPort domain／ADR 優先於通用 guidance。Story 若與既有架構或 ADR 衝突，先開 Gate，不默默重設 domain。
4. 在 ForgePilot 領取已授權的 Work Item 後，檢查相關程式與 callers，以最小內聚變更完成 Story。不得自行擴大 scope、改寫需求或超出 Story Authority；能力與 READY 狀態本身不授予執行權限。
5. 修改行為必須新增或更新相應測試。文件與純機械修改不製造無意義測試。
6. 執行唯一 canonical verification command：`make verify`。修正失敗原因；不得為了 PASS 弱化 acceptance criteria、刪除失敗測試或繞過檢查。
7. 依 `docs/development-workflow.md` 保存 ForgePilot verification evidence，逐項對應 AC、命令、revision、實際觀察及未通過項目。修改影響行為的內容後重新執行完整 `make verify`。
8. `make verify` PASS 只代表可準備 Human Review；所有必要 AC 與 environment evidence 仍須滿足。只有人類能接受 review 並完成工作，不自行批准 DONE。

遇到未定義的架構、scope 或 security decision，停止受影響工作並使用 ForgePilot Gate；
domain boundary、workspace access、runtime isolation、task lifecycle、protocol compatibility、scope expansion、public API semantic change 的判斷範圍與指令見 `docs/development-workflow.md` 的 Gate 規則。

交付時報告變更檔案、行為摘要、測試／verification evidence、AC 對照、架構影響與未解 Gate／風險。
治理規則不授予 commit、push、publish 或 deploy；依使用者實際授權處理。

## Agent skills

### Issue tracker

建立、讀取或發布規格與票據時，使用本機 Markdown tracker；先讀 `docs/agents/issue-tracker.md`。

### Triage labels

分類票據或設定 triage 狀態時，依 `docs/agents/triage-labels.md` 的標籤映射。

### Domain docs

本專案採 single-context；探索程式或撰寫規格前，依 `docs/agents/domain.md` 讀取術語與相關決策。
