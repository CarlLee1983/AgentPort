# 04: Claude Driver 真 CLI 單輪

**What to build:** 設定檔把 agent 指到 `runtime = "claude"`，`submit_task` 後 Claude Code 真的在該資料夾跑一輪，caller 拿回最終文字、usage、被拒絕的工具呼叫。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 以 `claude -p --output-format stream-json --verbose --permission-mode <對應> --permission-prompts none` 啟動；policy 三級對應 `plan` / `acceptEdits` / `bypassPermissions`；`extra_args` 原樣附加；`[runtimes.claude].command` 生效
- [ ] stream-json 對映到六種事件；`started` 帶 `session_id`；失敗判定看 `result.is_error` / `subtype` 而非 exit code；未登入視為 failed
- [ ] 子程序 `stdio: ['ignore','pipe','pipe']`，環境確保 `USER` 存在；不加 `--ignore-user-config` / `--setting-sources`
- [ ] 錄下的 JSONL fixture 回放測試涵蓋成功、失敗、permission_denied
- [ ] 真 CLI 測試僅在本機有 `claude` 且已登入時執行，否則 skip 並說明
