# 02: Linux execution 啟動與停止

**What to build:** 管理者在指定 Linux fixture 啟動一個受控 execution，能從外側觀察、停止它與其子程序，並取得可信停止證據；不提供遠端 shell 或產品 Task 派送入口。

**Blocked by:** 01 — 固定版本與 MCP 相容性.

**Status:** ready-for-agent

- [ ] 透過可沿用的可信 supervisor／launcher 在 worker 或 vendor 執行前建立獨立 cgroup v2 execution unit，持有 executionId／generation；Runtime 不持有建立、migration、kill 或監督狀態控制權。
- [ ] 限定測試目錄與低權限 Runtime 帳號；控制狀態、AgentPort credential 與未來核心 DB 位於不同受保護邊界，fixture 不可修改。
- [ ] 以不呼叫模型的 worker 驗證正常執行、同步卡住、子程序及 detached 子程序；外側觀察與停止不等待 worker 主動配合。
- [ ] 停止先 cooperative cancel，5 秒未完成由外側強停 cgroup，再最多 5 秒核對；送 signal、SDK 回應、PID 消失均不能單獨當停止。
- [ ] 同 execution 的 start／stop 序列化，撤銷後不再放行該 generation；停止完成同時要求 generation 封閉及 cgroup populated=0，不以暫空判斷。後票擴大跨重啟／延遲 start 驗證，不延後此基本契約。
- [ ] 停止證據不足明示 unknown／degraded，不宣稱已停止；不承諾跨 Agent 檔案硬隔離或撤回外部服務副作用。
- [ ] test:linux 提供可重現 fixture、啟動／停止次數、unit 證據、命令與版本；沒有 Linux／必要權限明確待環境，不能用 mock 或 skip 宣稱 AC-06／AC-12 通過。
