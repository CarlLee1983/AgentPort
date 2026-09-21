# AgentPort v2

- 詞彙：`CONTEXT.md`。規格：`specs/agentport-v2.md`。
- 決策地圖與建置工單都是本地 markdown，欄位與操作見 `docs/agents/issue-tracker.md`。`/implement NN` 指的是 `.scratch/service-install/issues/NN-*.md`（`.scratch/agentport-v2-build/` 已全數完成）。
- 驗證一律 `pnpm check`。真 CLI 測試需本機已登入 `claude` / `codex`。
- v1 程式碼在 `../AgentPort`，只搬 Driver 的 JSONL 解析與 `loopback-server`。
