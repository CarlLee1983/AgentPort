---
status: accepted
---

# Runtime 授權：首版沿用訂閱 OAuth，API key 為後續增量

取代 [ADR-0007](0007-runtime-api-key-official-claude-install.md) 的授權部分。首版 Claude Runtime 沿用 GATE-020 與 AP-007 已驗證的政策：專用 `agentport-runtime` 帳號的 Claude subscription OAuth，credential 只存在 mode 0700 的 runtime home，driver 拒絕 `ANTHROPIC_API_KEY` 與環境注入的 OAuth token。ADR-0007 在 grill 時只核對了 Anthropic 條款，沒有核對既有 driver 與 G1-C 證據；直接改為只用 API key 會推翻已驗證的 Runtime capability 證據，並要求重跑 G1-C。

Anthropic 條款（2026-09-17 核對）將訂閱 OAuth 限於 Claude Code 的一般使用，且不允許第三方開發者代其使用者透過訂閱憑證發送請求。管理者以本人訂閱、在本人專用主機、服務本人與自有 bot 是否屬一般使用並不明確，因此產品文件必須寫明：只能使用管理者本人的訂閱、合規責任由管理者承擔、不得以他人訂閱服務其他使用者。API key 授權路徑另立 Story 補上，完成後管理者擇一，就緒度顯示目前授權方式，兩條路徑各自需要 G1 證據。

Claude Code 不內附於發行包、由官方 apt 套件庫安裝指定版本並 hold 的決定不變，沿用 ADR-0007。runtime-home 同時保存 OAuth credential 與 Runtime Session 檔，屬於需備份、反安裝預設保留的受保護資料。

**Falsified if:** `src/runtime/claude/driver.ts` 的授權判定不再要求 subscription OAuth 且沒有對應的 API key 路徑 Story；或 Anthropic 條款明確禁止訂閱憑證用於此部署型態；或 `tests/contracts/claude-driver-boundary.test.ts` 改為接受環境注入的憑證。
