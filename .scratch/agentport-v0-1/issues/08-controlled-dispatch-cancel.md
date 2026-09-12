# 08: 受控派送與外側取消

**What to build:** Caller 提交的測試工作可由核心派送至受控 fixture worker，並能立即從外側要求取消；派送從第一天就受持久 claim、generation fence 與重啟核對約束。

**Blocked by:** 07 — 啟動時核對舊 execution.

**Status:** ready-for-agent

- [ ] 短交易重新驗證授權、binding／目錄 identity、能力、容量，取得唯一 Workspace claim、建立 execution 並 queued→starting，commit 後才交 supervisor launch；無跨 Runtime I/O 交易。
- [ ] 僅已驗證的 fixture Driver 執行，未開真 Claude 產品派送；同 Workspace 最多一 execution、全域 active 初值 4，未釋放的 starting／stopping／recovering 計入；不把缺少完整 queue 行為宣稱 G4。
- [ ] 公開 cancel_task 先 commit 取消意圖、receipt 與 stopping，再要求 generation 撤銷及 cooperative cancel；API 不等待清理，查詢可看到停止中。
- [ ] 5 秒 cooperative 未完成強停 unit，再最多 5 秒核對；generation 封閉且 cgroup 空才 canceled／釋放 claim，證據未知維持 stopping／quarantine、stopConfirmation=unknown、degraded。
- [ ] 執行預設累計期限與 worker／supervisor 失聯兜底，不允許 fixture 無限執行；取消／超時保留已知部分產出及 side effects，不宣稱回復檔案。
- [ ] 程序內以 monotonic clock 累計執行時間，持久保存累計值與階段；以可控時鐘驗 wall-clock 跳動不重設執行預算，daemon 重啟保留紀錄並核對／停止，不自動續跑。
- [ ] 取消前項暫停其 Context 後項；結果成功發布尚待後票，fixture 正常退出不得僅憑 exit 0 產生 completed。
- [ ] MCP→核心→真 SQLite→Linux fixture 驗 cancel-before-start、延遲 start、running 同步卡住、detached 子程序、停不乾淨與 claim→launch crash；晚到 start 不得放行。
- [ ] 每次新增派送行為都通過既有 recovery、test:linux 與受影響 check／test:mcp，保存 AC-04／AC-06／AC-07／AC-09 證據及操作說明；重要 Sol/high 審查問題先解決。
