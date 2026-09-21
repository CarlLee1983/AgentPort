# Driver 介面：兩個 CLI 的統一事件模型

Type: grilling
Status: resolved
Blocked by: 01, 02
Map: ../map.md

## Question

Claude 與 Codex 的子程序輸出要收斂成同一組 Driver 事件（開始、文字、工具使用摘要、需要輸入、完成、失敗）與同一組 Driver 操作（啟動一輪、在既有 session 續一輪、終止）。哪些差異必須暴露到 Task 層（例如 Codex 不會提問、Claude 的 permission 詢問），哪些由 Driver 吸收？Runtime Capability 要不要宣告？

## Answer

2026-09-21 grilling，六題全數依建議定案。

1. **Claude 單向驅動**：`claude -p --output-format stream-json --verbose --permission-mode <對應值> --permission-prompts none`。模型不能提問、權限被拒即記入 `permission_denials`、程序永不等待。與 Codex（exec 模式強制 `approval_policy=never`）行為對齊：**一次執行 = 一個 Turn，結束時只有文字**。不維護 stdin 控制協定。
2. **Driver 事件集合**：`started{runtime_session_id}`、`message{text}`、`activity{kind: command|file_change|tool, summary}`、`permission_denied{tool, input}`（Claude 才會出現）、`completed{final_text, usage}`、`failed{error}`。原始 JSONL 存磁碟供除錯，不進 SQLite。
3. **權限抽象三級** `policy: read-only | workspace-write | full`，各 Driver 對應（Claude `plan` / `acceptEdits` / `bypassPermissions`；Codex `--sandbox read-only` / `workspace-write` / `danger-full-access`），另有 `extra_args[]` 逃生口。Claude `acceptEdits` 仍會拒部分 Bash 操作，此不對稱寫進文件不抹平。
4. **尊重主機使用者的 CLI 設定**：不加 `--ignore-user-config`、不加 `--setting-sources`。主機管理者的個人 hooks / model 就是他要的行為。
5. **不宣告 Runtime Capability**：介面即「所有 Driver 都做得到的事」。第三個 runtime 進來再加。
6. **詞彙**：引入 **Turn**（Runtime Session 內一次 prompt → 最終回覆），一個 Task 恰產生一個 Turn；**刪除** Execution、Execution Generation、Execution Unit、Execution Supervisor、Deployment Readiness。已寫入 `CONTEXT.md`。

Driver 操作：`start(workspace, prompt, policy, extra_args) → events`、`resume(runtime_session_id, workspace, prompt, policy, extra_args) → events`、`kill()`。`git diff --stat` 與 commit 清單由服務層在 Turn 結束後執行，不屬於 Driver。判定失敗：Claude 看 `result.is_error` / `subtype`（exit code 不可靠，未登入也 exit 0）；Codex 看 `turn.failed` / exit code。子程序 spawn 必須 `stdio: ['ignore', 'pipe', 'pipe']`（Codex 讀 stdin 到 EOF 才開始）。

衍生：`needs_input` 是否還需要是獨立狀態 → 交票 05；`kill()` 的取消保證 → 自 fog 畢業為票 10。
