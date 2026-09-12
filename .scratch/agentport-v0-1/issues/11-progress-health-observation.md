# 11: 進展、工具活動與停滯觀察

**What to build:** Caller 在 Runtime 忙碌、卡住或觀察失聯時，仍能從外側取得有時間與證據的工作快照，分辨程序存活、實際進展與工具活動；本票收斂 S3／G3。

**Blocked by:** 10 — MCP 到真 Claude 執行.

**Status:** ready-for-agent

- [ ] get_task 分別回 state、revision、reason、lastProgressAt、executionLiveness=alive/dead/unknown、livenessCheckedAt、observedAt、observationStatus=current/stale/unavailable、問題及結果。
- [ ] toolActivityStatus=active/idle/unknown 附 observed time 與有界核准工具名稱／開始時間，不含參數、環境或完整輸出；缺可靠 Driver 事件或證據過期即 unknown。
- [ ] 心跳、網路存活不刷新 lastProgressAt；starting／running 連續 10 分鐘無進展產生疑似停滯事件，不宣告死亡或終態；queued／paused 顯示阻擋原因。
- [ ] 查詢只取已提交資料與有界健康快照，不等待模型、worker IPC、長寫入或停止確認；DB 讀取超時標 stale，無可靠快照 observation_unavailable。
- [ ] worker 同步卡住、大量輸出／JSON 解析、IPC 不回覆時，外側查詢仍可進行；消息、序列化與輸出有界，慢 Client 不阻塞 worker 消費。
- [ ] 以可重現基本負載量測正常查詢 2 秒目標；Client 超過 5 秒連不上明示無法取得最新狀態，不把 unavailable 算正常成功；壓力下完整量測由後票擴大。
- [ ] G3 驗證真 MCP→Claude→結果、外側取消、基本期限、重啟不重跑、候選結果及停止未知，包含來源 plan 的所有退出條件。
- [ ] 更新 AC-03／AC-06／AC-08／AC-09 證據、查詢／健康操作說明與受影響 gates；缺真 Linux 或 Claude 驗證不宣告 G3 通過。
