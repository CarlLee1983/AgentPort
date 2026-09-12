# 05: 持久提交與單項查詢

**What to build:** 授權 Caller 能選取已配置 Agent、提交文字工作取得持久 Task ID，並在回應遺失或服務重啟後查詢同一工作；此切片只接受工作，不啟動 Runtime。

**Blocked by:** 04 — 真 Claude 互動能力驗證.

**Status:** ready-for-agent

- [ ] 經公開 MCP list_agents、submit_task、get_task 跑官方 Client→唯一 AgentExecutionService→真 SQLite→結構化結果，僅宣告已實作工具。
- [ ] 第一個 admission 入口即預設 loopback；遠端只經可信 HTTPS／TLS 代理及明確來源限制，驗 Origin／Host、proxy trust、body 上限與偽造 forwarded identity 拒絕。憑證與私密輸入不進未核准輸出／日誌，不延至後段安全對抗票才建立保護。
- [ ] Registry 預設 Agent／Workspace／Runtime／政策；Principal 來自個別認證設定，scope 與 actor 分離；每次讀寫重驗 scope／Agent 權限，無權與不存在統一 not_found，不回傳主機路徑或秘密。
- [ ] 啟動 realpath／核對目錄 identity，同目錄共 identity，祖先／子目錄重疊配置拒絕；建立不可由 Caller 更改的 BindingSnapshot 與 Context 綁定，不接受任意路徑、binary、Driver options。
- [ ] submit 在一個短交易驗證 schema、授權、能力、receipt、Context 與容量，原子 commit queued Task、queueOrder／predecessor、accepted event 及 receipt，之後才回 ID；未 commit 不得有執行副作用。
- [ ] scope 內 operationId／初始 fingerprint 去重；同鍵同請求回原 Task，不同請求 conflict。HTTP 斷線或 MCP request cancellation 不撤銷已 commit 工作；JSON-RPC id 不當 mutation 去重鍵。
- [ ] SQLite 採版本化 migration、WAL、foreign keys、FULL 同步、短交易／單寫通道及獨立短讀；同步 binding 離開控制事件迴圈，DB 存控制帳號專用本機目錄。
- [ ] 從第一個接受的 Task 就預留有界回答／取消／恢復／終態 receipt 與 event 空間；實作規格 admission、queue 及文字/body 上限，commit／磁碟失敗停止 admission、不假接受。
- [ ] 重啟可用原 ID／receipt 查詢並將未開始 queue 暫停，不自動派送；不相容 schema 保留原資料並拒絕使用，不重建空 DB。
- [ ] 真 SQLite＋官方 Client 驗同鍵並發、回應遺失、重啟重試、跨 scope、超限與 commit 故障，保存 AC-01／AC-02／AC-09／AC-10 證據及操作說明；本票不宣稱 G2 或首版完成。
