# Implementation Plan

此檔僅列工作分解與 evidence 提示。Product requirements 在 story.md／acceptance.md；
正式執行狀態與領取由 ForgePilot Work Item 管理，不在此維護另一套 lifecycle 或完成 checkbox。
本次治理導入未開始 AP-001，亦未產生 S0／G0 通過證據。

## Plan

1. 確認 repository、指定 Linux 目標 metadata 與候選版本來源；未定義相容性決策開 Gate。
2. 固定 exact Node／pnpm 12／TypeScript 與必要工具，建立唯一 lockfile 與乾淨安裝指令。
3. 建立受限 loopback MCP fixture，驗證官方 Client 的協定、tools/list／call、身分與失敗契約。
4. 完成固定 Claude SDK 靜態 capability、SQLite runtime 與 Linux prerequisites evidence；不啟動 coding runtime。
5. 擴充 make verify 納入所有 local checks，驗證 fresh checkout 的成功與失敗，逐項記錄 AC evidence。
6. 經授權提交後，以 ForgePilot 對 clean committed revision 產生 verification evidence，準備 Human Review；不自行批准 DONE。

## Notes

* 上述步驟的依賴順序不授權現在實作；下一個工作才是 Start AP-001 / AgentPort S0。
* tools fixture、security 與 protocol decision 依 story.md 與 Gate 規則；不可為相容性放寬產品邊界。
* G0 完成仍需全部必要 AC 與 environment evidence；local PASS 並不批准 S1。
