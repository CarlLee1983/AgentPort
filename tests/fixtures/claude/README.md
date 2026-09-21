# Claude stream-json fixture

用本機 `claude` 2.1.278（已登入 claude.ai / Max 訂閱）在一個乾淨的暫存 git workspace 錄製，
供 `tests/driver/claude/driver.test.ts` 回放測試用。三份都用同一個 workspace：

```sh
git init -q && git config user.email test@test.com && git config user.name test \
  && git commit --allow-empty -q -m init
```

## success.jsonl

一輪成功，含一次 `Write` tool_use（被本機 `~/.claude/hooks/write-guard.sh` 的 PreToolUse
hook 擋下，因此拒絕只出現在 `result.permission_denials[]`，串流沒有獨立的
`system/permission_denied` 事件——這正是要涵蓋的情況之一，見 events.ts 註解）：

```sh
claude -p "在 hello.txt 寫入 hi，然後回覆 done" \
  --output-format stream-json --verbose \
  --permission-prompts none --permission-mode acceptEdits
```

## permission-denied.jsonl

`--permission-mode default`（沒有 approval surface）下要求跑 shell 指令，觸發真正的
`system/permission_denied` 事件（`decision_reason_type: "asyncAgent"`），同時
`result.permission_denials[]` 也會列出同一筆、且帶 `tool_input`：

```sh
claude -p "執行 shell 指令 touch denied.txt" \
  --output-format stream-json --verbose \
  --permission-prompts none --permission-mode default
```

## resume-not-found.jsonl

`--resume` 一個不存在的 session id；只有一行 `result`（沒有 `system/init`），
`is_error: true`、`subtype: "error_during_execution"`、`result: null`，錯誤文字要退回
`errors[]`：

```sh
claude -p "hi" --output-format stream-json --verbose \
  --permission-prompts none --permission-mode acceptEdits \
  --resume 00000000-0000-0000-0000-000000000000
```

（exit code 1；`result.result` 為 `null`，錯誤文字只在 `errors[]` 與 stderr。）

## 清洗

錄製時的暫存路徑（含使用者帳號）已用 `sed` 換成 `/workspace/fixture`、`/home/user`；
`system/init.tools` 只留前 5 項、`mcp_servers` / `plugins` / `agents` / `skills` /
`slash_commands` 只留前 1 項、assistant 的 `thinking` block 的 `signature` 換成
`"TRUNCATED_FOR_FIXTURE"`——這些欄位 driver 不解析，純粹是縮小檔案體積，內容仍是本機真實
輸出的一部分（未杜撰欄位或事件型別）。
