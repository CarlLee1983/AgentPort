# 19: 崩潰窗口完整驗證

**What to build:** Caller 在服務、worker 或 supervisor 於關鍵窗口崩潰後，仍能查回可證實的狀態，不遭遇重跑、重送答案或錯誤解除 Workspace 占用。

**Blocked by:** 13 — 修改尚未開始的 Task；16 — 明確恢復 Context 與 Session.

**Status:** ready-for-agent

- [ ] 在 G4 已具控制語意上建立可重現 fault matrix，包含 admission commit／response、claim／launch、generation revoke／late start、answer commit／delivery／ack、candidate outcome／cleanup／terminal commit 前後。
- [ ] 逐列驗 daemon、worker、supervisor 各自重啟以及恢復時再次 crash；記錄持久 Task／Execution／Question／receipt／claim、實際啟動次數與可信停止證據。
- [ ] 同鍵重試僅回原 Task，commit 前無 execution，claim 後不推定尚未啟動；恢復核對不建立新 generation，不重播指令。
- [ ] 撤銷早於 start、延遲 launcher I/O、supervisor 重啟及暫空 cgroup 不得放行舊工作；停止未知保持 quarantine。
- [ ] 答案 commit 後 callback 或 ack 遺失保留首答案且 delivery=unknown，不重送；原問題 expiry 不錯殺已接受答案，執行時計仍受限制。
- [ ] 完整持久 outcome／ordinal 與停止證據才還原終態；未知結果不 TTL 清除，ack 只在停止後 interrupted，resume 不略過其他 blocker。
- [ ] 每列具預期／實際、來源摘要、版本、時間、命令、fixture、持久狀態與結果位置；不能把 mock 的 stop 證據當真 Linux 清理。
- [ ] 更新 test:faults 及 AC-02／AC-06／AC-07／AC-08／AC-09；發現缺口在擁有該行為邊界修復並重跑受影響案例，Sol/high 獨立複查 delta。
