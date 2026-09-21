---
status: accepted
---

# 服務以管理者本人身分常駐、直接使用其已登入的 CLI 憑證

v2 的 MCP 服務以「已經在主機上登入 `claude` / `codex` 的那個 OS 使用者」身分常駐（macOS LaunchAgent `gui/<uid>`、Linux `systemd --user`），子程序繼承服務的環境與 HOME，直接使用該使用者的 Claude Code 訂閱憑證（macOS login Keychain、Linux `~/.claude/.credentials.json`）與 Codex 的 `~/.codex/auth.json`。這刻意偏離 v1 的 [ADR-0006](../../../AgentPort/docs/adr/0006-non-root-daemon-launcher-privilege-boundary.md)（非 root daemon + root launcher 特權邊界）、[ADR-0007](../../../AgentPort/docs/adr/0007-runtime-api-key-official-claude-install.md)（API key、官方 apt 安裝並 hold）與 [ADR-0010](../../../AgentPort/docs/adr/0010-runtime-authorization-subscription-first.md)（專用 `agentport-runtime` 帳號的訂閱 OAuth）。v1 為了多操作者、特權分離與可重現安裝，堆出 launcher、專用帳號、credentials 目錄與就緒度檢查，結果裝不起來也改不動；v2 的使用情境是單一管理者、單一主機、服務本人與自有 bot（[ADR-0009](0009-single-operator-dedicated-host-no-agent-isolation.md)），這些機制保護的對象不存在，代價卻全數保留。

## 政策灰區

Anthropic 條款（v1 於 2026-09-17 核對，見 ADR-0007 / 0010）將訂閱 OAuth 限於 Claude Code 的一般使用，並不允許第三方開發者代其使用者透過訂閱憑證發送請求。管理者以本人訂閱、在本人主機上、服務本人與自有 bot 是否屬一般使用並不明確。因此：

- 文件必須寫明只能使用管理者本人已登入的訂閱，合規責任由管理者承擔，不得以他人訂閱服務其他使用者。
- AgentPort 不提供任何登入、代登入或憑證轉送功能；憑證只在主機端由管理者以 CLI 本身處理（地圖 Out of scope）。

**逃生口**：若政策收緊或管理者不願承擔灰區，改用 API key 不需改架構——Codex 設 `CODEX_API_KEY`，Claude 設 `ANTHROPIC_API_KEY`，都放進同一份 env file（`~/.config/agentport/agentport.env`）由服務繼承即可。v2 不在程式內拒絕這些變數，這點與 v1 ADR-0010 相反。

## 同時修訂 v1 ADR-0002 第二段

[ADR-0002](0002-task-records-survive-restart.md) 的「重啟後保留尚未開始的佇列，但先暫停，待交辦方確認；先前執行中的任務先核對」在 v2 改為：重啟時 running 一律 `failed{interrupted}`、不從原始 JSONL 回填部分結果；queued 依原建立順序自動續跑，不暫停等 caller 確認。理由是 queued 尚未產生任何副作用、單操作者可自行在同一 Context 續派中斷的工作；而 v1 的「核對」依賴 receipt / fencing，v2 已刪除。此語意成立的前提是同一個 `db_path` 只有一個服務程序（單實例鎖，建置票 11），否則新程序會把另一個仍存活程序的 running Task 誤判為中斷。

## Consequences

- Agent 之間、Agent 與管理者之間都不隔離：Runtime 能讀寫管理者 HOME 可及的一切，policy（`read-only` / `workspace-write` / `full`）只是傳給 CLI 的權限等級，不是作業系統邊界。
- 服務行為與管理者自己在終端機跑 CLI 一致（hooks、model、`~/.codex/config.toml` 都生效），這是刻意的（spec User Story 12）。
- 憑證失效（登出、token 過期）表現為 Task `failed{runtime_failed}`，修復方式是管理者在主機上重新登入 CLI，服務不需重啟。

**Falsified if:** Anthropic 條款明確禁止或明確允許以本人訂閱服務本人自有 bot 的部署型態；或 `src/driver/claude/driver.ts` 不再讓子程序繼承服務環境（例如改為清空環境或拒絕 ANTHROPIC_API_KEY）；或 `src/service/index.ts` 的服務定義渲染模組改以專用服務帳號執行；或 `src/app.ts` 的重啟掃描不再把 running 收斂為 interrupted、或 `src/store/sqlite.ts` 不再持有單實例獨佔鎖。
