# 短 storage request timeout 的整合測試在 CI 間歇失敗

Status: needs-triage
Type: task

## 現象

`tests/integration/s5-retention-expiry.test.ts` 的
「evicts a preterminal cache before a timed-out terminal commit completes」
在 GitHub Actions（`ubuntu-latest`）間歇失敗，同一 commit 重跑即通過。

| 觀測 | 值 |
| --- | --- |
| Commit | `6c0ec79a8ccdb66bfd04920ef14b5ebcfd407029`（PR #1，branch `feat/linux-deploy-ap020-ap021`） |
| 失敗 | run `35237698326` attempt 1（`push` 事件），2026-09-17 |
| 通過 | 同 run attempt 2；同 commit 的 `pull_request` run `35237727261` |
| 錯誤 | `ApplicationError: The requested operation could not be completed`，`code: storage_unavailable`，caused by `storage request timed out` |
| 失敗位置 | `tests/integration/s5-retention-expiry.test.ts:319:23`，即 `fixture.service.submitTask(...)` |

該 branch 未修改 retention、storage、SQLite 或 `agent-execution-service` 相關檔案
（`git diff main...HEAD --name-only` 無符合項目）。

## 已確認的事實

- 測試以 `createDurableAdmissionFixture({ requestTimeoutMs: 500 })` 建立 fixture（第 310 行）。
- 失敗發生在場景準備的 `submitTask`（第 319 行），尚未進入要驗證的
  `armCommitBarrier`／`commitVerifiedStop` 逾時路徑（第 348 行起）。

## 推論（未驗證）

500 ms 的 storage request timeout 是為了讓後段 commit barrier 逾時而設定，
但同一個上限也套用在前段一般的 submit／dispatch 請求；CI runner 負載高時，
普通請求就可能超過 500 ms。測試因此在前置步驟誤報，而不是在被測行為上失敗。

## 第二例：storage-responsiveness（2026-09-17）

| 觀測 | 值 |
| --- | --- |
| 測試 | `tests/integration/storage-responsiveness.test.ts` 「lets reserved cancellation overtake a saturated audit queue」 |
| Commit | `5c2b4e108789188613484687669bb6d29384d342`（PR #2，只新增本 Markdown 票） |
| 失敗 | run `35238532826` attempt 1（`push` 事件）；attempt 2 與 `pull_request` run `35238546242` 通過 |
| 錯誤 | `Error: storage request timed out`，`code: storage_unavailable` |
| 堆疊 | 只到 `src/storage/sqlite-durable-admission-store.ts:1336`（`Timeout._onTimeout`），未指出測試行號 |

已確認：此測試以 `requestTimeoutMs: 100` 開 store（第 13 行），並同時送出
2,000 筆 audit 與一筆 reserved cancel。PR #2 不含程式變更，失敗不可能由該 commit 引入。
尚未確認逾時發生在 `submit`、`cancel` 或 audit 的哪一個請求。

## 範圍

同一錯誤類型已在兩個不同測試出現。`tests/` 內以短 `requestTimeoutMs`
（100–500 ms）建立 store 的檔案：

- `tests/integration/s5-storage-failure-recovery.test.ts`
- `tests/integration/s5-storage-failure-convergence.test.ts`
- `tests/integration/storage-responsiveness.test.ts`
- `tests/integration/s5-retention-expiry.test.ts`
- `tests/integration/s5-control-storage-pressure.test.ts`
- `tests/acceptance/s5-outer-mcp-observation-load.test.ts`
- `tests/acceptance/durable-admission.test.ts`

## 待確認

- 本機或 CI 以負載（例如 `stress` 或平行 vitest）能否重現第 319 行逾時。
- 修正方向擇一：只對 commit barrier 階段套用短逾時；或以 barrier probe
  決定性地觸發逾時，不依賴 wall-clock 上限；或提高前置步驟的上限。
- 上列檔案中，哪些逾時是被測行為、哪些只是前置步驟被同一上限波及。

本票為 triage 記錄；若決定修正且屬正式實作，依
[issue tracker](../../../docs/agents/issue-tracker.md) 提升為 PraxisBound Story。

## Comments
