# Acceptance Criteria

## Happy Path

- [ ] AC-01: 在 AP-004 G1-L accepted Linux boundary 內，真 Claude subscription OAuth harness
      以固定 SDK／binary 完成 non-interactive execution，Driver 只發出 Reference-bound、連續 ordinal、
      bounded structured result observation；它不發布 Task terminal result、event 或 claim release。
- [ ] AC-02: 真 Claude native AskUserQuestion 可被 Driver 與一般 permission request 分流；對有效、
      schema-bound answer，原 native callback 在同一 controlled execution 續行並產生後續 observation。

## Failure Cases

- [ ] AC-03: missing／expired／wrong-account login、runtime home mode／ownership 不符、SDK／binary
      mismatch，或 external capability failure 使 `test:claude` nonzero；不得 skip、mock 或以 synthetic
      result 報 PASS，且輸出不包含 credential。
- [ ] AC-04: stale／cross-execution Reference、ordinal gap／replay、oversized result／question／answer、
      native tool-use mismatch、invalid answer schema 或 arbitrary assistant question 一律拒絕，不續行、
      不洩漏跨 execution state。
- [ ] AC-05: active execution cancellation 與已證明無平行 tool activity的 pure-waiting cancellation
      都呼叫 AP-004 Supervisor revoke-and-stop；SDK abort、signal、EOF 或 callback acknowledgement
      不能單獨構成 Stop Evidence，unknown／timeout 不產生 stopped 或 terminal projection。

## Business Rules

- [ ] AC-06: Claude subscription OAuth 僅位於專用 `agentport-runtime` account mode `0700` runtime
      home，並僅可供指定 worker 使用；worker 無 AgentPort DB、Supervisor ledger、launcher privilege、
      other execution credential 或 credential-source selection ability。
- [ ] AC-07: credential-shaped marker、OAuth／cookie／env value、prompt、answer、raw SDK error、
      sensitive host path 和 cross-scope identity 不出現在 repository、IPC、log、test output、evidence、
      Driver result、Session reference 或 error projection；所有 derived error／evidence 保持 bounded redact。
- [ ] AC-08: Session reference 僅由 current Claude execution 外部衍生、bounded 且 sanitized；不能作為
      Task／Context identity、包含 credential／raw state、跨 execution resume token 或 production result。
- [ ] AC-09: harness、`src/runtime/claude/` Driver、worker composition、OAuth source 與 `test:claude`
      不可由 production bootstrap、MCP mutation／dispatch path 到達；本 Story不建立 public Runtime capability。

## Regression Requirements

- [ ] AC-10: `make verify` 在 fixed Node／pnpm、無 Claude credential 的 fresh checkout 通過；指定
      Linux target 的 `pnpm run test:claude` 實際執行 real subscription capability fixtures，任何
      prerequisite／assertion failure 都非零，沒有 skipped-all PASS。
- [ ] AC-11: candidate-bound Claude evidence 記錄 AP-004 G1-L accepted candidate、target OS／kernel／
      cgroup v2、runtime account role、runtime-home permission check、SDK／binary versions、commands、
      result／question／answer／continuation／cancel event ordering、Stop Evidence linkage 與 scope limits；
      AP-005 S3-B 的 ForgePilot dependency 或 blocking Gate 只有在 Human Review 接受後才可解除。

## Acceptance Evidence

<!-- prettier-ignore -->
| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/claude/runtime-capabilities.test.ts` | `accepted AP-004 G1-L Linux target, pinned SDK/binary, dedicated subscription account` | `bounded sequential structured-result observation in one controlled execution; no terminal product projection` |
| `AC-02` | test | `tests/claude/runtime-question-continuation.test.ts` | `native AskUserQuestion fixture with valid schema-bound answer` | `native tool-use identity is preserved and same execution continues after answer` |
| `AC-03` | test | `tests/claude/runtime-authentication.test.ts` | `missing, expired, wrong-account, permission and incompatible-version fixtures` | `external suite exits nonzero for unavailable capability and every projection is sanitized` |
| `AC-04` | test | `tests/contracts/claude-driver-boundary.test.ts` | `stale reference, ordinal, payload, tool-use and answer-schema counterexamples` | `invalid external values are rejected without Runtime continuation or cross-execution disclosure` |
| `AC-05` | test | `tests/claude/runtime-cancellation.test.ts` | `active and pure-waiting fixtures on accepted Linux Supervisor boundary` | `both cancellation paths require revoke-and-stop and verified Stop Evidence; unknown stays nonterminal` |
| `AC-06` | test | `tests/linux/claude-runtime-isolation.test.ts` | `dedicated account, mode 0700 runtime home and protected DB/ledger/launcher markers` | `only assigned Workspace and needed OAuth are reachable; protected resources and source selection reject` |
| `AC-07` | test | `tests/claude/runtime-redaction.test.ts` | `credential, prompt, path and raw-SDK-error sentinel fixtures` | `sentinels are absent from all bounded IPC, result, error, log and evidence projections` |
| `AC-08` | test | `tests/unit/claude-driver-session.test.ts` | `valid, oversized, credential-shaped and cross-execution session fixtures` | `only bounded sanitized current-execution reference is accepted` |
| `AC-09` | test | `tests/contracts/claude-no-production-dispatch.test.ts` | `all production composition, import and process/credential reachability variants` | `zero production reachability to Driver, worker, OAuth source or Claude SDK call` |
| `AC-10` | command | `make verify && pnpm run test:claude` | `fresh checkout for local gate; designated Linux target and valid dedicated OAuth for external suite` | `local and real external suites execute and exit 0; missing prerequisites or failures are nonzero` |
| `AC-11` | human | `G1 Claude capability and S3-B prerequisite review` | `accepted AP-004 candidate evidence plus candidate-bound AP-007 sanitized evidence` | `Human accepts bounded capability evidence and AP-005 remains blocked until this Story is DONE and reviewed` |

## Security Fixture Matrix

<!-- prettier-ignore -->
| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `executionReference` | `stale-or-cross-execution-reference` | reject | `sanitized Driver error` | `tests/contracts/claude-driver-boundary.test.ts` |
| `worker.observation` | `replayed-gap-or-oversized-observation` | reject | `bounded IPC error` | `tests/contracts/claude-driver-boundary.test.ts` |
| `nativeToolUseId` | `unbound-or-replayed-tool-use-id` | reject | `sanitized question error` | `tests/claude/runtime-question-continuation.test.ts` |
| `questionPayload` | `assistant-text-question-not-native-callback` | reject | `bounded Driver observation` | `tests/contracts/claude-driver-boundary.test.ts` |
| `answerPayload` | `cross-execution-or-schema-invalid-answer` | reject | `sanitized answer error` | `tests/claude/runtime-question-continuation.test.ts` |
| `toolActivity` | `unknown-parallel-tool-state` | reject | `sanitized waiting-state error` | `tests/claude/runtime-cancellation.test.ts` |
| `vendorCredential` | `credential-shaped-marker` | omit | `no repository IPC log output evidence or error location` | `tests/claude/runtime-redaction.test.ts` |
| `sessionReference` | `oversized-credential-shaped-or-cross-execution-reference` | reject | `sanitized Driver result` | `tests/unit/claude-driver-session.test.ts` |
| `error.details` | `raw-sdk-error-with-oauth-and-host-path` | redact | `bounded harness error` | `tests/claude/runtime-redaction.test.ts` |
| `evidence.label` | `oauth-or-full-prompt-marker` | omit | `candidate-bound evidence metadata` | `tests/claude/runtime-redaction.test.ts` |

## Verification Notes

`make verify` remains the credential-free repository gate. `test:claude` is an external,
real capability gate only on the AP-004 G1-L accepted designated Linux target and only with
the GATE-020 dedicated runtime-account OAuth policy in force. A mock, skip, macOS run,
Docker Desktop run, SDK cancel acknowledgement, EOF, exit code, or raw Session reference
cannot satisfy AC-01, AC-02, AC-03, AC-05, AC-06, AC-08, AC-10, or AC-11. Passing this Story
proves no production dispatch; AP-005 alone owns later production integration.
