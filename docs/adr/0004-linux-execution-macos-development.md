---
status: accepted
---

# Linux production execution and macOS platform-neutral development

AgentPort v0.1 的 Runtime execution 與部署維持 Linux-only，可靠停止仍要求 Execution Generation 已永久撤銷且 Execution Unit 已證明為空；Linux Adapter 以 cgroup v2 提供此證據。macOS 是 Node、MCP、SQLite、核心狀態／持久化、Protocol Adapter 與 fake-worker contract tests 的開發平台，可先進行不會建立 Execution、取得 Workspace claim、啟動 worker 或呼叫 Runtime 的 S2 durable-admission 切片；任何 Runtime dispatch 仍須先通過指定 Linux target 的 G1 證據。

核心依賴 platform-neutral Execution Supervisor interface，只傳遞已持久授權的 Execution Generation 並保存不透明 Execution Unit ID。此 interface 必須能放行已授權世代、先封閉世代再停止並於 unit 為空後回傳 Stop Evidence，以及在 daemon／Supervisor 重啟後核對既有 Execution；Adapter 無法確定世代或 unit 狀態時必須拒絕 dispatch 並保留 Workspace quarantine。

不採用 native macOS process group 或 `launchd` 作為等價停止證據，因 descendant 可建立新 session 逃離 process group，而服務管理本身不能證明該世代已封閉且 execution unit 為空。Docker Desktop 或 macOS S2 測試也不替代 AP-001 AC-09、Linux G1 或 release evidence。若未來要支援 native macOS Runtime／deployment，必須另立 platform-baseline Story 與 ADR，驗證 descendant containment、late-start fencing、crash cleanup、credential isolation 及 stop proof。
