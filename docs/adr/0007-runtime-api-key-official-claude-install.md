---
status: superseded by ADR-0010 (authorization); installation decision remains in force
---

# Runtime 授權僅用 API key，Claude Code 由官方套件庫安裝

首版 Claude Runtime 只接受 `ANTHROPIC_API_KEY`，由主機管理者透過 `agentport setup` 以 TTY 輸入，存於 root 保護的 credentials 目錄，並經 launcher 既有的 systemd `LoadCredential` 只在 Execution 期間提供給 worker，不寫入 Runtime 帳號的 HOME。Anthropic 官方條款（2026-09-17 核對 code.claude.com legal-and-compliance）將訂閱 OAuth，包括 `claude setup-token`，限定於訂閱者本人的一般使用，並要求產品後端改用 API key 或受支援的雲端供應商；支援訂閱 token 會讓產品文件替違反條款的用法背書。Bedrock／Vertex 留作增量工作。

Claude Code 不內附於 AgentPort 發行包：其授權為「All rights reserved」，查無再散佈授權。安裝時改由官方簽章的 apt 套件庫安裝指定版本並 `apt-mark hold`，AgentPort manifest 記錄已驗證的 Claude 版本範圍，就緒度檢查版本落在範圍內。apt 套件不自動更新、安裝於系統路徑，較 native installer（依賴使用者 HOME、預設自動更新）或 npm（需另一份 Node）更符合固定版本與非 root 服務帳號。

Runtime Session 延續依賴 Claude 存於固定 runtime-home 的 session 檔，因此 runtime-home 屬於需備份、反安裝預設保留的資料，不是快取。

**Falsified if:** Anthropic 條款允許訂閱憑證用於代理其他使用者的後端服務，或授權明確允許再散佈 Claude Code；或 `src/supervisor/linux/launcher-server.ts` 不再以 `LoadCredential` 傳遞 Runtime 憑證；或 `src/runtime/claude/driver.ts` 的續接不再依賴 runtime-home 中的 session 檔。
