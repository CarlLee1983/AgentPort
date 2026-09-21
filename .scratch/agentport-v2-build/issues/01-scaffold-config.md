# 01: 專案骨架與設定檔載入

**What to build:** 管理者寫好 TOML 後執行 `agentport check-config`，服務把所有設定錯誤一次列出，或回報設定有效並印出解析後的 agent 清單。這張同時建立 pnpm / TypeScript / vitest / eslint / prettier 骨架與 `README.md`。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `loadConfig(path, env)` 純函式：尋找順序 `--config` → `$AGENTPORT_CONFIG` → XDG 預設路徑；`~` 展開；相對路徑相對於設定檔目錄
- [ ] spec 列出的每條驗證規則各有測試：agent name 格式與唯一、workspace 存在且為目錄、同 realpath 只綁一個 agent、runtime / policy 列舉、policy 必填、caller name 唯一、`token_env` 非空且 token 值唯一、`long_poll_max_seconds ≤ 55`、runtime 可執行檔存在（含 `[runtimes.*].command` 覆寫）、`agents[]` 非空
- [ ] 多個錯誤同時存在時一次全部列出，exit code 非 0
- [ ] `agentport check-config` 子命令可用；`pnpm check`（format、lint、typecheck、build、test）全綠
