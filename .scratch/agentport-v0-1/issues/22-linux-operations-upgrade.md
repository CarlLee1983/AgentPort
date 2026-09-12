# 22: Linux 操作、升級與回滾

**What to build:** 管理者可依交付文件安裝、診斷、停止並升級 Linux AgentPort，也能一致備份或離線恢復而不自動重跑舊工作。

**Blocked by:** 21 — 負載下的查詢與控制驗收.

**Status:** ready-for-agent

- [ ] 在指定測試環境提供可用配置範例與 supervisor／啟動整合，涵蓋低權限帳號、cgroup v2、固定 executable、DB／credential 目錄、TLS／Client 與 vendor 認證；範例不含秘密。
- [ ] readiness／doctor 分別說明可查詢與可派送、Agent 能力／不可用原因、版本與權限前置；停止未知／recovery 不可顯示派送 ready。
- [ ] 正常 shutdown 先停 admission／dispatch 並暫停 queue，停止活動 execution、保存終態或未知，再關 listener/storage；非正常終止由 supervisor／generation 撤銷與 recovery 收斂。
- [ ] 驗 schema version，不相容新 schema 拒絕 dispatch 並保留原 DB；升級前暫停、確認 execution 已停止、一致備份後再 migration。
- [ ] 備份涵蓋 WAL 語意，不能只複製未 checkpoint 主 DB；驗一致備份還原與相容 reader/schema 或離線回滾，不切回 in-memory 或重建空 DB。
- [ ] 恢復較舊備份時明示較新副作用紀錄可能缺失，進 recovery 核對，queue 暫停、不自動 dispatch。
- [ ] 文件包含安裝、啟動、查詢、取消、未知結案、Context 恢復、容量／磁碟故障、憑證輪替與回滾的實際步驟和限制。
- [ ] 保存 AC-12 演練、命令／版本／預期實際及相關 gates；只操作指定驗證環境，正式部署與 release 不由本票推定授權。
