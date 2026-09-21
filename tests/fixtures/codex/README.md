# Codex `exec --json` fixture

用本機 `codex` 0.155.0（已登入 ChatGPT 帳號）在暫存的非 git 目錄錄製，供
`tests/driver/codex/driver.test.ts` 回放測試用。個人路徑已用 `sed` 換成
`/workspace/fixture`（未杜撰欄位或事件型別，內容仍是本機真實輸出）。

## success.jsonl

一輪成功，含一次 `apply_patch` 造成的 `file_change`：

```sh
codex exec --json --sandbox workspace-write --skip-git-repo-check \
  'Use apply_patch only (no shell commands, no verification) to create note.txt containing exactly: hi'
```

## command-execution.jsonl

一輪成功，含一次 `command_execution`（`ls`）：

```sh
codex exec --json --sandbox read-only --skip-git-repo-check \
  'Run `ls` via shell only (no apply_patch, no file writes) and tell me the file names you see'
```

## turn-failed.jsonl

指定不存在的 model 觸發真正的 `turn.failed`（exit 1；`error.message` 是原始 API
錯誤 JSON 字串，見 research/codex-exec.md §1）：

```sh
codex exec --json --sandbox read-only --skip-git-repo-check -m no-such-model-xyz 'hi'
```

## resume-not-found.jsonl

`resume` 一個不存在的 thread id：**沒有任何 JSONL 輸出**，錯誤只在 stderr，exit 1
（因此檔案本身是空的；driver.test.ts 直接把下面這行 stderr 文字餵給
`AGENTPORT_TEST_STDERR`，不從檔案讀）：

```sh
codex exec resume --json --skip-git-repo-check -c 'sandbox_mode="read-only"' \
  00000000-0000-0000-0000-000000000000 'hi'
```

stderr：

```
Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-0000-0000-000000000000 (code -32600)
```

## `-c sandbox_mode="..."` 在 resume 的行為（本票驗證，補充 research/codex-exec.md）

`codex exec resume --help`（0.155.0）沒有 `-s/--sandbox`，本票另外實測
`-c sandbox_mode="read-only"` 在 resume 時確實擋下寫入（模型收到
「the workspace is read-only」並如實回報，檔案未產生），因此 `buildCodexArgs` 對
resume 一律改用 `-c sandbox_mode="<值>"` 而非 `--sandbox`。
