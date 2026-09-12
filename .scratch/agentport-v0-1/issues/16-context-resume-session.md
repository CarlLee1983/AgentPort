# 16: 明確恢復 Context 與 Session

**What to build:** Caller 能明確接受前項部分成果，選擇保留原生對話或以指定摘要開新 Session，恢復同 Context 已接受的工作，而不重跑舊 Task。

**Blocked by:** 12 — Context 追加佇列與 Workspace 並行；15 — 真 Claude 澄清投遞與計時.

**Status:** ready-for-agent

- [ ] resume_context 接受 operationId、contextId、expectedRevision、preserve／fresh_session，驗當前權限與 Context binding；交易記錄接受哪個已結 predecessor 的部分成果。
- [ ] 只原子解除失敗／取消／重啟等可解除 blocker，符合資格的 paused→queued；未停止 execution、quarantine、無效 binding 或未授權等不能略過。
- [ ] preserve 需安全可用且相容的原生 Session reference，否則 continuation_unavailable 且 queue 不變；不回退曾失效的更舊 Session。
- [ ] fresh_session 必須 Caller 明確選擇並提供 contextSummary（可明確為空），事件與回應說明原生對話不延續；核心不自產摘要、不重播舊命令、不改 Agent／Workspace／政策。
- [ ] 既有 Task ID／queueOrder／predecessor 保存，只派送從未開始的 Task；不恢復已啟動舊 Task、未知答案 callback 或未證實停止的 execution。
- [ ] claim 時 reference 標使用中，只有成功且停止後發布新 reference；取消／失敗／未知使其失效，等待也保持 Workspace 占用。
- [ ] 真 SQLite／MCP 驗 revision／resume 競爭、同鍵重送、多 blocker、重啟、前項取消及 Session 失效；真 Claude 驗 preserve 及明確 fresh 後既有後項按序執行。
- [ ] 本票與修改票共同收斂 G4：10 工具都具真實行為、正向澄清與 queue／edit／resume 證據齊全；G4 完成前不得進 S5。更新 AC-04／AC-05／AC-08 與操作文件。
