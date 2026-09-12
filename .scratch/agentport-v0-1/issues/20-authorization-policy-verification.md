# 20: 授權與執行政策對抗驗證

**What to build:** 本人與 bot 能以各自身份安全共用工作範圍，未授權者、被撤權者或 Runtime 本身不能藉 ID、回答、設定或輸出越過執行政策。

**Blocked by:** 13 — 修改尚未開始的 Task；16 — 明確恢復 Context 與 Session.

**Status:** ready-for-agent

- [ ] G4 完成後對所有 10 工具驗當前 membership／Agent allowlist，包含 get/list/events/reply/edit/cancel/resume/ack；同 scope 不同 actor 可接手且 audit 正確，跨 scope／Agent／Question／cursor 不可枚舉。
- [ ] 未知或無權目標統一 not_found，缺失／無效 token 401；schema／未知工具不建立 Task，業務錯誤穩定 code，查 failed Task 不當 tool failure。
- [ ] 驗執行前權限撤銷、目錄 identity 被換、重疊 Workspace 或 binding revision 變化；暫停／拒絕，不靜默改綁或換空白 Session。
- [ ] 真 Runtime 帳號無核心 DB、AgentPort credential、supervisor/generation 控制權；只注入所需 vendor credential，不承諾各 Agent 同帳號檔案隔離。
- [ ] AskUserQuestion 答案不得授予新權限，一般 canUseTool 依既定政策，拒絕任意 path/binary/options 與 shell 插值；URL 不自動抓附件。
- [ ] 驗 loopback／可信 TLS proxy、Origin／Host、body 上限與 proxy trust，不接受外來 forwarded identity；bearer Client 限制與非完整 OAuth 說明一致。
- [ ] 輸出、錯誤、audit、stderr／argv／env 僅核准 metadata，不洩漏 token／環境值；完整私密指令／答案只在授權資料區，沒有任意檔案下載或通用 DLP 聲稱。
- [ ] 使用合成非秘密測試資料與受控 adversarial fixtures，保存 AC-10／AC-01 證據及限制；不改成公開多租戶或遠端提權，Sol/high 獨立審查並解決重要 findings。
