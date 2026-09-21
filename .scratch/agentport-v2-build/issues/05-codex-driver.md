# 05: Codex Driver 真 CLI 單輪

**What to build:** 設定檔把 agent 指到 `runtime = "codex"`，`submit_task` 後 Codex 真的在該資料夾跑一輪，caller 拿回最終文字與 usage；非 git 目錄也能跑。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 以 `codex exec --json --sandbox <對應> --skip-git-repo-check` 啟動；policy 對應 `read-only` / `workspace-write` / `danger-full-access`；`extra_args`、`[runtimes.codex].command` 生效
- [ ] JSONL（`thread.started` / `turn.*` / `item.*`）對映到六種事件；`started` 帶 `thread_id`；`turn.failed` 或非 0 exit → failed
- [ ] stdin 為 ignore（Codex 讀到 EOF 才開始）；尊重主機 `~/.codex/config.toml`
- [ ] fixture 回放測試涵蓋成功、失敗、`file_change` item 轉 activity
- [ ] 真 CLI 測試僅在本機有 `codex` 且已登入時執行
