# 01: 固定版本與 MCP 相容性

**What to build:** 管理者能在確認的程式工作目錄重現安裝與檢查；相容的官方 MCP Client 能以個別身分呼叫受限 fixture，並取得協定、Runtime 與 Linux 前置條件的實測紀錄。本票完成 S0／G0，不派送 coding 工作。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 確認實際程式工作目錄與指定 Linux 測試目標；來源目錄已依使用者要求初始化 Git，但仍只有文件、沒有產品程式骨架。沿用既有 Git 歷史，不假設已有 Linux 權限；規格所述「非 Git worktree」是初始化前的紀錄。
- [ ] 建立最小 TypeScript／Node 工具鏈，以 pnpm 12 為唯一套件管理器；固定 exact Node／pnpm patch、唯一 lockfile、frozen-lockfile 安裝及 check（lint、typecheck、build、基本測試），不建立未使用的框架或空模組。
- [ ] 以規格候選 Node 24、MCP revision 2026-07-28、官方 MCP v2 packages 2.0.0、Claude Agent SDK 0.3.269 為查證起點；核對 exact SDK／Claude binary、SQLite binding 與實際 SQLite library，確認適用 WAL 修正及 Node 相容性，不把候選版本或浮動 latest 當通過結果。
- [ ] 用官方 Client 驗證指定 revision 的每請求 version／client info／capabilities、Streamable HTTP、tools/list／call、outputSchema、structuredContent 與同內容 JSON TextContent；未知版本、工具與無效 schema 明確拒絕。
- [ ] 獨立 bearer 映射個別 Principal，缺少／無效 token 回 401；fixture 僅受限本機協定操作，不啟動 Runtime。不宣稱完整 OAuth、任意 Client 或 legacy fallback；不相容先記錄證據，不放寬認證。
- [ ] 檢查固定 Claude SDK 型別的 query streaming input、AskUserQuestion／canUseTool、取消、cwd／settingSources／resume，以及 SQLite I/O 不阻塞控制事件迴圈的方式；這不是正向 Runtime 能力驗收。
- [ ] 記錄 Linux OS、cgroup v2、專用帳號、launcher 權限、受保護資料目錄與 vendor 認證來源 metadata，不複製秘密；缺必要環境標待環境，不記通過。
- [ ] 保存 AC-01／AC-12、G0 的版本、命令、fixture、來源 revision 或摘要、預期／實際與限制；乾淨安裝、check、test:mcp 可重現。僅本票相關 gates 通過才可開始後票。
