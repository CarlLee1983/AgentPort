# 03: 撤銷 generation 與拒絕延遲啟動

**What to build:** 管理者取消 execution 或重啟 supervisor 後，即使先前啟動請求延遲到達，舊工作也不能再被放行；停止確認涵蓋未來啟動可能性。

**Blocked by:** 02 — Linux execution 啟動與停止.

**Status:** ready-for-agent

- [ ] 持久保存 execution generation 的啟動／撤銷狀態；start 先登記，vendor 執行前檢查仍被核准；撤銷先到也保存不可再啟動的紀錄。
- [ ] 同 generation 啟動、撤銷與停止具序列化契約；延遲 launcher I/O 不得繞過撤銷，不能先執行再補 fence。
- [ ] stop 確認同時證實 execution unit 已空，以及延遲或進行中的 start 都不能再放行；尚不存在或暫空 unit 不能構成完整證據。
- [ ] supervisor 重啟先撤銷舊 epoch 未結 execution，再接受新啟動；持久狀態不明時拒絕放行及停止完成確認。
- [ ] 注入 cancel-before-start、start-before-cancel、延遲 start、撤銷 commit 前後 crash、supervisor 重啟及恢復再次 crash；核對真實啟動次數，不產生新的未授權 generation 或孤兒程序。
- [ ] 重送觀察／停止操作只核對原 execution，不轉成新工作；unit 及 generation 證據可供後續核心 recovery 使用，不建立第二份 Task 狀態機。
- [ ] 執行受影響 test:linux 與 fault fixtures，保存 AC-06／AC-07 證據；launch、持久資料與並行控制經 Sol/high 分析及獨立審查，重要問題解決後交付。
