---
status: accepted
inherited_from: ../../../AgentPort/docs/adr/0003-local-transactional-task-store.md (v1, 2026-09)
---

> 自 v1 原樣繼承。「本機 SQLite 短交易作唯一持久來源、不承諾 exactly-once 執行」
> 的核心精神直接適用於 v2 的 Task Store。v1 提到「Runtime worker 不直接寫資料
> 庫、由單控制 daemon 擁有生命週期」的分工在 v2 依然成立，但 v2 沒有獨立的
> execution worker 程序——Driver 是 `createApp` 內管理的子程序，讀寫 SQLite 的
> 是同一個 daemon 程序本身。最後一段提到的 DEPLOY-03（SQLite／binding 版本固定）
> 與 DEPLOY-07（schema 版本、備份／還原）是 v1 一鍵安裝器的工單，v2 沒有對應的
> 一鍵安裝流程，這段不適用；v2 另以 `docs/adr/0011-same-user-subscription-credentials.md`
> 記錄的單實例鎖（`locking_mode = EXCLUSIVE`）取代「跨程序分散式 claim」的顧慮。

# 單主機交易儲存與 execution worker

跨重啟的 Task、回答、取消及操作去重需要一致保存；技術設計選擇本機 SQLite 短交易作唯一持久來源，單控制 daemon 擁有生命週期，Runtime worker 不直接寫資料庫。相較於記憶體狀態可保留已接受的工作，相較於外部 queue／資料庫服務則減少首版單主機的運維與分散式 claim 責任。

代價是需要版本化 schema、容量保留、備份與故障核對；交易不涵蓋 Runtime 或外部 Git 副作用，因此不承諾 exactly-once 執行。實作前須固定 SQLite／binding 版本及驗證磁碟故障。回滾必須相容持久資料與狀態，不能直接切回舊 in-memory 方案。

一鍵安裝會把此儲存設計發佈到使用者主機，故於 2026-09-17 接受。原列「實作前」事項改由部署工作承接：SQLite／binding 版本固定與原生模組相容性由 DEPLOY-03 發行包處理；schema 版本、備份／還原與相容性由 DEPLOY-07 處理。
