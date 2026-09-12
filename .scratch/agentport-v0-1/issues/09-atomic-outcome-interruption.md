# 09: 結果結案與未知結果確認

**What to build:** Caller 查到終態時立即取得同一交易保存的結果；完成與取消競爭不會互相覆寫，重啟後結果未知的工作可在證實停止後明確結案。

**Blocked by:** 08 — 受控派送與外側取消.

**Status:** ready-for-agent

- [ ] worker event 帶 executionId、連續單調 ordinal 與有界 payload；核心僅接受目前 execution 的完整序列，不以 EOF、exit 0 或 SDK resolve 判定成功。
- [ ] 候選 outcome／finalOrdinal 全部保存後進 stopping，worker 收到保存確認才退出；可信停止證據齊全後，結果、終態 event、Context reference 及 claim 釋放同交易提交。
- [ ] 先 commit 的候選完成或取消意圖決定結果；完成先到取消回 too_late 及快照，取消／deadline／政策失敗先到則晚到成功不得 completed，終態不可被遲到事件改寫。
- [ ] 正常運行 worker 丟失且無 outcome，證實停止後 failed/runtime_lost；daemon crash 先 recovering，完整持久候選＋finalOrdinal＋停止證據才可還原對應終態，不解除 Context 重啟 pause。
- [ ] 無完整證據維持 recovering/outcome_unknown；acknowledge_interruption 驗 operationId／expectedRevision／當前權限，只有資源已證實停止才原子 interrupted，不造成功或重跑，後項仍暫停。
- [ ] 安全 Session reference 只在 binding 相容、成功結果持久化且清理完成後發布；使用中、失敗、取消或未知 reference 不可退回更舊 Session。
- [ ] 結果保存摘要、檔案、檢查證據、未完成事項、實際 Git 資訊及已知副作用，區分 Runtime 自述與服務驗證；公開內容超限明示 output_limit，不假報完整成功。
- [ ] 以真 SQLite／受控 worker 驗 outcome→cleanup→terminal commit 各 crash window、ordinal 缺漏、取消競爭與重啟結案，更新 AC-06／AC-07／AC-08／AC-11、相關 gates 與操作說明。
