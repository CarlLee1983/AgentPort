# 23: 真 Caller 全流程與交付政策

**What to build:** 至少一個相容 AI Caller 能使用 Linux AgentPort 完成交辦、查詢、追加、回答與取消，並取得符合任務政策的結果與實際 Git 資訊。

**Blocked by:** 22 — Linux 操作、升級與回滾.

**Status:** ready-for-agent

- [ ] 選至少一個真正支援固定 MCP revision／獨立 bearer 的 AI Caller，記錄版本與認證配置；官方 SDK Client fixture 保留作自動化測試，不能代替真 Caller 相容性證據。
- [ ] 在指定測試 Workspace 完整跑提交→持久 ID→查詢→同 Context 追加→真 Claude 問題→另一同 scope actor 回答→原 Task 完成→後項續跑。
- [ ] 另驗未開始修改、取消、斷線再查、daemon 重啟、recovering／未知結案及 preserve／明確 fresh_session；原 Task ID 保留、不自動重跑或重送答案。
- [ ] 結果含摘要、變更檔案、檢查證據、未完成事項、實際 commit／分支／PR 與已知副作用，Runtime 自述和服務驗證分開。
- [ ] 預設交付修改／測試／回報，分析任務無檔案變更或 PR 也可完成；推送與 PR 依任務或已設定專案規則，不增加 AgentPort GitHub Adapter。
- [ ] Git／PR 政策先用本機 bare remote／模擬 GitHub 命令回應驗證；真推送或 PR 僅在明確授權的測試 repository 操作，產品能力不等於外部寫入授權。
- [ ] 完成／待回答／疑似停滯事件可由 Caller 消費，通知失敗仍能直接查結果；失聯訊息與延遲目標符合規格。
- [ ] 保存所有情境的實際 Task／execution 關聯、命令、Client／Runtime 版本與結果，更新 AC-01／AC-05／AC-08／AC-11 及操作文件；任何必要場景缺環境維持未完成。
