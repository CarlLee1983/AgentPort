# 24: 發行包與最終驗收

**What to build:** 維護者取得可交付的 Linux AgentPort 套件與完整驗證紀錄，能判斷 v0.1 是否符合所有要求；完成 S6／G6，不自動發布 release 或部署正式環境。

**Blocked by:** 23 — 真 Caller 全流程與交付政策.

**Status:** ready-for-agent

- [ ] 依 S0–S6／G0–G6 逐項核對退出條件，AC-01–AC-12 都有可追溯通過紀錄與對應來源 revision／摘要，不能以單項 tools/list、fake worker 或 SDK 成功宣告完成。
- [ ] verify:release 整合 check、test:mcp、test:linux、test:claude、test:faults 及證據完整性；缺 Linux、Runtime 認證或真 Caller 必須明確未通過，不能全部 skip 後成功。
- [ ] 本機、Linux 驗證與 CI 使用相同 exact Node／pnpm 12／SDK／binary／SQLite 與 frozen lockfile；可重現組裝 Linux 發行包，記錄必要環境與限制。
- [ ] 核對正式工具只有已實作的 10 個契約，無空成功宣告；移除被取代的 fixture-only 啟動方式，仍有測試用途的 fault fixtures 留在測試邊界。
- [ ] 需求、Technical Design、實作計畫、ADR、operations 與 verification 反映最終驗證事實；proposed 技術決策是否改狀態依實際證據，不把打包當 production readiness。
- [ ] 安全、持久資料、並行與 public API 接受 Sol/high 獨立審查；所有 material findings 解決，固定 checkpoint 後修正以同 reviewer 的 delta 複查。
- [ ] 交付包含安裝配置、查詢／停止／恢復、TLS／憑證、保存、migration／備份／回滾、真 Caller 相容矩陣與已知限制；macOS／其他 Runtime／A2A 等延後項目不宣稱支援。
- [ ] 報告變更、所有必要 gates、證據、剩餘風險及操作限制。正式部署、Git 推送、公開 release 仍須實際任務授權，不因套件可交付而自行執行。
