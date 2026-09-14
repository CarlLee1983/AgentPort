# Acceptance Criteria

## Happy Path

- [ ] AC-01: 指定 Linux target 的 Supervisor 對已持久授權的同一 Execution Reference
      idempotent start，只建立一個 cgroup v2 Execution Unit；worker 在 unit 內以專用低權限
      account 執行，核心於放行前可觀察 ledger 與 unit identity。
- [ ] AC-02: isolated Runtime worker 以 bounded、連續 ordinal、完整 Execution Reference-bound
      IPC 回報 progress／candidate；錯 Reference 或跨 execution candidate 不可被接受。

## Failure Cases

- [ ] AC-03: revoke 早於、同時或晚於 start 都先永久封閉 generation；一般、同步卡住、
      child 與 detached descendant 全部離開 cgroup 後才回 Stop Evidence，late start 永遠不放行。
- [ ] AC-04: daemon／Supervisor restart、ledger-only／unit-only orphan、reference mismatch、
      cgroup／launcher timeout 或 unknown 狀態不啟動／重播 Runtime；無法證明時回
      indeterminate／unavailable，且不產生 Stop Evidence。
- [ ] AC-05: worker IPC 的錯 Reference、重複／跳號 ordinal、過大 payload 或未綁定
      candidate 拒絕，錯誤只投影 bounded sanitized failure。

## Business Rules

- [ ] AC-06: Runtime worker 無 AgentPort DB、Supervisor ledger、launcher privilege 或其他
      execution secrets；每次只取得指定 Workspace、launch profile 與最小固定環境，且不能
      讀取受保護 host paths。
- [ ] AC-07: `start`、`revokeAndStop`、`reconcile` 仍是唯一 Supervisor interface；
      Linux Adapter 才可產生 verified Stop Evidence，native macOS／scripted fixture／PID／
      process group／worker cooperative cancellation 都不能替代。
- [ ] AC-08: 本 Story 的 harness、Driver、worker 與 Linux Adapter 不可由 production
      bootstrap／MCP mutation path 到達；不建立公開 dispatch、terminal result 或 claim release。

## Regression Requirements

- [ ] AC-09: `make verify` 在固定 Node／pnpm、無 vendor credential 的 fresh checkout 通過；
      指定 Linux target 的 `test:linux` 保存 nonzero-on-failure evidence，且沒有 skipped-all PASS。
- [ ] AC-10: G1 evidence 明確記錄 target OS／kernel／cgroup v2、service account、launcher
      privilege、data／ledger path、命令、event ordering、Stop Evidence 與限制；Human Review
      只接受 G1-L，並明示 G1-C Claude capability 仍未證明、不可單獨解除 S3 dependency。

## Acceptance Evidence

<!-- prettier-ignore -->
| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/linux/execution-supervisor-start.test.ts` | `designated Linux target with cgroup v2 delegation and dedicated Runtime account` | `one persisted generation and one opaque Execution Unit; duplicate start is idempotent` |
| `AC-02` | test | `tests/contracts/runtime-worker-ipc.test.ts` | `bounded progress/candidate sequences with mismatched, cross-execution and oversized fixtures` | `only continuous Reference-bound observations are accepted` |
| `AC-03` | test | `tests/linux/execution-supervisor-stop.test.ts` | `cancel-before-start, racing start, blocked worker, child and detached descendant fixtures` | `generation sealed before release; verified unit empty; late start denied and no orphan remains` |
| `AC-04` | test | `tests/linux/execution-supervisor-reconcile.test.ts` | `daemon and Supervisor restart with ledger-only, unit-only, stale and timeout fixtures` | `no Runtime replay; orphans converge or remain indeterminate without Stop Evidence` |
| `AC-05` | test | `tests/contracts/runtime-worker-ipc.test.ts` | `malformed Reference, ordinal, candidate, raw host-error and bounded-payload fixtures` | `invalid observations are rejected and failures remain bounded and sanitized` |
| `AC-06` | test | `tests/linux/runtime-isolation.test.ts` | `dedicated Runtime account and protected DB, ledger, launcher, Runtime home and Workspace` | `worker reaches only the assigned Workspace and minimal environment; protected resources reject` |
| `AC-07` | test | `tests/contracts/linux-stop-evidence.test.ts` | `real Adapter plus PID, scripted, process-group and worker-cancel counterexamples` | `only sealed-generation plus cgroup-unit-empty result authenticates Stop Evidence` |
| `AC-08` | test | `tests/contracts/g1-no-production-dispatch.test.ts` | `all production composition variants and import/process tripwire` | `zero production reachability to harness, Driver, worker, launcher or Linux Adapter` |
| `AC-09` | command | `make verify && pnpm run test:linux` | `fixed local toolchain plus designated Linux target` | `both required suites execute and exit 0; any missing prerequisite or failing case is nonzero` |
| `AC-10` | human | `G1-L environment and architecture review` | `candidate-bound local and Linux evidence with sanitized metadata` | `Linux target and trust boundaries accepted; G1-C and S3 remain separate prerequisites` |

## Security Fixture Matrix

<!-- prettier-ignore -->
| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `executionReference` | `caller-selected-reference` | reject | `sanitized harness error` | `tests/contracts/runtime-worker-ipc.test.ts` |
| `generation` | `revoked-generation-late-start` | reject | `Supervisor ledger and sanitized event trace` | `tests/linux/execution-supervisor-stop.test.ts` |
| `launchProfileId` | `worker-overridden-profile` | reject | `sanitized launcher error` | `tests/linux/runtime-isolation.test.ts` |
| `workspaceIdentity` | `worker-selected-host-path` | reject | `sanitized worker error` | `tests/linux/runtime-isolation.test.ts` |
| `worker.observation` | `oversized-or-unbound-observation` | reject | `sanitized IPC error` | `tests/contracts/runtime-worker-ipc.test.ts` |
| `stopEvidence` | `pid-missing-or-scripted-stopped` | reject | `sanitized Supervisor result` | `tests/contracts/linux-stop-evidence.test.ts` |
| `error.details` | `credential-path-and-host-cause` | redact | `bounded harness error` | `tests/contracts/runtime-worker-ipc.test.ts` |

## Verification Notes

`make verify` 不需要 Linux target 或 vendor credential；它驗證 repository 與
platform-neutral contracts。G1-L 必須另外在 Human 指定的 Linux target 執行完整
`test:linux`，並將結果綁定同一 candidate。任何 skip、mock、Docker Desktop、macOS
process group 或 scripted Stop Evidence 都不能滿足 AC-01～AC-04、AC-06、AC-07、AC-09
或 AC-10。`test:claude`、真實 authentication、AskUserQuestion、SDK cancellation 與 Session
reference 明確不屬於本 Story acceptance，必須由後續 G1-C Story 獨立驗證。
