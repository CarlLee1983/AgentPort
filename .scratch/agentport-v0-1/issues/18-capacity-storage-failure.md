# 18: 容量耗盡與儲存故障收斂

**What to build:** 一般容量耗盡時 Caller 仍能控制已接受工作；真儲存故障時服務明示不可用並由 supervisor 收斂 execution，不捏造接受或停止結果。

**Blocked by:** 17 — 結果保存與過期查詢.

**Status:** ready-for-agent

- [ ] 擴大驗證自 admission 即存在的 reserve：2 GiB 一般預算外留 256 MiB 結案／控制，Task 接受時預留回答、取消、恢復與終態 receipt/event，提出 Question 前再保留首答案。
- [ ] 一般 tombstone／queue 滿仍可 reply／cancel／acknowledge；同答案重送不再投遞，新問題或非必要操作將耗盡預留時拒絕增加負載並用保留紀錄停止／結案。
- [ ] 容量核算包括 JSON escaping、audit、DB 頁面、WAL 與 checkpoint；不得以內容大小冒充磁碟上限或提早淘汰 30 天內結果。
- [ ] 注入 DB commit 錯誤、磁碟滿、DB 長延遲／鎖住及控制 reserve 實體不可用；停止 admission／dispatch，不回 mutation 已持久接受。
- [ ] DB 失敗時獨立 supervisor 仍撤銷 generation／停止 execution；未持久化或未證實停止維持 unavailable／quarantine，不丟 claim 或無限執行。
- [ ] 有可靠已提交快照才回 stale，無可靠資料回 observation_unavailable；儲存恢復後核對原狀態，不自動重播 Task／答案或捏造終態。
- [ ] 覆蓋等待回答、答案待 ack、取消與候選結案時的故障，記錄 API 回應、磁碟／DB 狀態、啟動／停止次數及證據。
- [ ] 保存 AC-09／AC-07、相關 test:faults／Linux 結果與容量故障操作手冊；不是將 baseline 延至本票才實作。
