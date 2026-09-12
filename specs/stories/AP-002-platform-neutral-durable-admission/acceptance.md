# Acceptance Criteria

## Happy Path

- [ ] AC-01: 官方 MCP Client 可使用六項已發布工具；submit 在持久 commit 後回穩定 Task ID，get／list／events 可立即讀取相同已提交事實，未建立 Execution 的 queued Task 與重啟後 paused Task 都可取消。
- [ ] AC-02: 相同 Access Scope 內 submit 與 cancel 的相同 operationId／fingerprint，在並行、回應遺失與 daemon 重啟後重試都只執行一次並回原 receipt；同一 operationId 改用不同 fingerprint、Task 或 operation type 明確 conflict。
- [ ] AC-03: 真 SQLite migration 保存 Task、Context、BindingSnapshot、receipt、event 與必要 reserve metadata；重啟後 ID／順序／cursor 保留，原 queued Task 轉 paused 且不自動 dispatch。

## Failure Cases

- [ ] AC-04: 缺少／無效 credential 回 401；跨 scope Agent／Task／cursor 與不存在資源使用相同 not_found。完整 membership 撤銷後六項工具都拒絕；單一 Agent allowlist 撤銷後，list_agents、無 filter 的 list_tasks／get_events 成功但濾除該 Agent 資料，針對該 Agent 的 submit／get／cancel 回 not_found。任何 `contextId` 都以 schema error 拒絕，Client 也不能覆寫 Principal、Access Scope、Workspace、binary、Driver options 或 policy。
- [ ] AC-05: schema、operation fingerprint、queue capacity、一般 tombstone capacity 或 SQLite commit 失敗時回穩定錯誤且不建立重複／部分 Task；既有 Task 的 get／cancel 保留可用容量。
- [ ] AC-06: AP-002 diff 沒有新增 dormant 或 feature-flagged production dispatcher、Runtime Driver、worker launcher 或 production／test Supervisor Adapter；S2 build／import／composition graph 的每種配置都無法到達 S1 execution artifacts。所有 S2 fixture 都不建立 Execution／Workspace claim，test-only tripwire 使任何程序建立嘗試失敗，沒有 Claude query、子程序、container、cgroup、process group 或 launchd 副作用。

## Business Rules

- [ ] AC-07: AgentExecutionService 是 Task lifecycle 唯一事實來源；MCP Adapter 與 storage 沒有第二份狀態機，submit 的 Task／Context／BindingSnapshot／receipt／accepted event 在一個 transaction commit。
- [ ] AC-08: SQLite I/O 位於專用 worker，當 DB worker 同步阻塞、延遲或回大量結果時，控制事件迴圈仍可在受控 fixture 中推進；查詢超時明示 stale／unavailable，不等待 Runtime。
- [ ] AC-09: 一般 admission 與既有 Task 控制／結案 reserve 分離；拒絕新 submit 不會淘汰已接受 Task、receipt 或 event，也不阻止保留容量內的 get／cancel。
- [ ] AC-10: 相同 repository revision 的 macOS 與可用 Linux platform-neutral checks 使用相同固定工具鏈與 contract；macOS 結果明示不包含 Runtime execution、Stop Evidence、AP-001 AC-09、Linux G1 或 production readiness。

## Regression Requirements

- [ ] AC-11: `make verify` 在 fresh checkout 重跑 AP-001 compatibility checks 與本 Story 所有不需外部 credential 的 unit／integration／contract tests；任一層失敗傳遞 nonzero，沒有空測試或 skipped-all PASS。

## Acceptance Evidence

<!-- prettier-ignore -->
| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test    | `tests/acceptance/durable-admission.test.ts`       | `official MCP Client, loopback server, real SQLite database, queued and restart-paused Tasks`          | `six tools expose only implemented semantics; commit precedes response; queued and paused cancel without Execution`     |
| `AC-02` | test    | `tests/integration/operation-receipts.test.ts`     | `submit and cancel concurrency, dropped responses, restart retries, changed fingerprint target and operation type` | `one effect and original receipt for safe retries; stable conflict for every operationId reuse mismatch` |
| `AC-03` | test    | `tests/integration/storage-restart.test.ts`        | `versioned migration and real SQLite database reopened by a fresh daemon`                             | `identities order receipts and events survive; queued becomes paused; no dispatch occurs`                              |
| `AC-04` | test    | `tests/acceptance/authorization.test.ts`           | `two Access Scopes, full membership revocation, single-Agent allowlist revocation, contextId and override payloads` | `all requests reauthorize; full revocation rejects, lists filter, targeted tools return not_found, overrides fail` |
| `AC-05` | test    | `tests/integration/admission-failures.test.ts`     | `invalid schema, conflicting operation fingerprint, full capacities, injected SQLite commit failure`  | `stable error and no partial or duplicate Task; reserved existing-Task controls remain usable`                         |
| `AC-06` | test    | `tests/contracts/no-dispatch.test.ts`              | `AP-002 diff inventory, all S2 composition variants, optional pre-existing S1 artifacts, process-creation tripwire` | `AP-002 adds no execution artifact; S1 artifacts remain unreachable; zero Execution claim process or Runtime starts` |
| `AC-07` | human   | `final architecture review`                        | `core storage and MCP diff with transaction trace`                                                    | `one Task lifecycle source; adapter and storage translate or persist without owning a second state machine`            |
| `AC-08` | test    | `tests/integration/storage-responsiveness.test.ts` | `DB worker delay, synchronous blocking probe, bounded large result and query timeout`                 | `control loop advances; reads return committed snapshot or explicit stale/unavailable within fixture bound`            |
| `AC-09` | test    | `tests/integration/storage-reserve.test.ts`        | `general admission and tombstone budgets exhausted with reserved existing-Task operations`            | `new submit rejected; accepted Task receipt event get and cancel are not evicted or blocked within reserve`            |
| `AC-10` | command | `pnpm run test:platform-neutral`                   | `same revision and fixed toolchain on macOS plus designated Linux target when available`              | `platform-neutral contract passes where run; report explicitly lists absent execution and Linux environment evidence`  |
| `AC-11` | command | `make verify`                                      | `fresh checkout, frozen dependencies, no vendor credential or existing build output`                  | `repository AP-001 and AP-002 local checks pass; deliberate layer failure exits nonzero; no skipped-all PASS`          |

## Security Fixture Matrix

<!-- prettier-ignore -->
| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `Authorization`         | `Bearer ap002-invalid-token`                | reject          | `HTTP response; sanitized test output`                    | `tests/acceptance/authorization.test.ts asserts 401 and sentinel absence`                             |
| `Authorization`         | `Bearer ap002-scope-a-token`                | redact          | `Principal mapping only; sanitized audit metadata`        | `tests/acceptance/authorization.test.ts asserts token bytes absent from DB response log and evidence` |
| `protocolVersion`       | `1900-01-01`                                | reject          | `MCP protocol error; sanitized audit metadata`            | `tests/acceptance/authorization.test.ts asserts no application operation`                             |
| `clientInfo`            | `{"name":"ap002-client","version":"1.0.0"}` | preserve        | `bounded request metadata`                                | `tests/acceptance/durable-admission.test.ts asserts normalized metadata`                              |
| `capabilities`          | `{}`                                        | preserve        | `bounded request metadata`                                | `tests/acceptance/durable-admission.test.ts asserts normalized metadata`                              |
| `operationId`           | `ap002-operation-1`                         | preserve        | `operation receipt`                                       | `tests/integration/operation-receipts.test.ts asserts scoped uniqueness`                              |
| `agentId`               | `agent-outside-scope`                       | reject          | `sanitized audit result`                                  | `tests/acceptance/authorization.test.ts asserts indistinguishable not_found`                          |
| `taskId`                | `task-outside-scope`                        | reject          | `sanitized audit result`                                  | `tests/acceptance/authorization.test.ts asserts indistinguishable not_found`                          |
| `contextId`             | `context-existing-in-scope`                 | reject          | `sanitized schema error`                                  | `tests/acceptance/authorization.test.ts asserts S2 rejects all follow-up admission`                   |
| `instruction`           | `AP002-INSTRUCTION-SENTINEL`                | preserve        | `authorized Task content only`                            | `tests/acceptance/authorization.test.ts asserts omission from list audit error and evidence output`   |
| `executionLimitSeconds` | `999999999`                                 | reject          | `sanitized validation error`                              | `tests/acceptance/durable-admission.test.ts asserts configured bound`                                 |
| `inputWaitSeconds`      | `999999999`                                 | reject          | `sanitized validation error`                              | `tests/acceptance/durable-admission.test.ts asserts configured bound`                                 |
| `cursor`                | `scope-a:cursor-from-scope-b`               | reject          | `sanitized audit result`                                  | `tests/acceptance/authorization.test.ts asserts indistinguishable not_found`                          |
| `filter.agentId`        | `agent-outside-scope`                       | reject          | `sanitized audit result`                                  | `tests/acceptance/authorization.test.ts asserts no cross-scope enumeration`                           |
| `filter.state`          | `not-a-state`                               | reject          | `sanitized validation error`                              | `tests/acceptance/durable-admission.test.ts asserts schema rejection`                                 |
| `limit`                 | `1000000`                                   | reject          | `sanitized validation error`                              | `tests/acceptance/durable-admission.test.ts asserts maximum page size`                                |
| `principalId`           | `principal-b`                               | reject          | `sanitized schema error`                                  | `tests/acceptance/authorization.test.ts asserts identity override rejection`                          |
| `accessScopeId`         | `scope-b`                                   | reject          | `sanitized schema error`                                  | `tests/acceptance/authorization.test.ts asserts scope override rejection`                             |
| `workspacePath`         | `/tmp/ap002-outside-workspace`              | reject          | `sanitized schema error`                                  | `tests/acceptance/authorization.test.ts asserts host path override rejection`                         |
| `runtimeBinary`         | `/tmp/ap002-runtime`                        | reject          | `sanitized schema error`                                  | `tests/acceptance/authorization.test.ts asserts binary override rejection`                            |
| `driverOptions`         | `{"unsafe":true}`                          | reject          | `sanitized schema error`                                  | `tests/acceptance/authorization.test.ts asserts Driver override rejection`                            |
| `policy`                | `{"allowAll":true}`                       | reject          | `sanitized schema error`                                  | `tests/acceptance/authorization.test.ts asserts policy override rejection`                            |
| `authorization.membership` | `revoked-after-submit`                   | reject          | `sanitized audit result`                                  | `tests/acceptance/authorization.test.ts asserts whole-request rejection on all six tools`             |
| `authorization.agentAllowlist` | `agent-revoked:list-surfaces`        | omit            | `authorized list and event results`                       | `tests/acceptance/authorization.test.ts asserts revoked Agent data is filtered from list agents tasks and events` |
| `authorization.agentAllowlist` | `agent-revoked:targeted-surfaces`    | reject          | `sanitized audit result`                                  | `tests/acceptance/authorization.test.ts asserts submit get and cancel return indistinguishable not_found` |
| `error.details`         | `ap002-scope-a-token`                       | omit            | `HTTP response; console; verification.md; ForgePilot log` | `tests/acceptance/authorization.test.ts asserts credential sentinel absent`                           |
| `evidence.label`        | `AP002-INSTRUCTION-SENTINEL`                | omit            | `console; verification.md; ForgePilot log`                | `tests/acceptance/authorization.test.ts asserts instruction sentinel absent`                          |

## Verification Notes

`make verify` 是唯一 canonical local gate；個別測試與 `pnpm run test:platform-neutral` 只提供診斷及 environment evidence。
本 Story 的 macOS PASS 不會改變已採用的「AP-001 AC-09 保持 blocked、延後 G0 acceptance」決策，也不會滿足 S1／G1、Stop Evidence、Linux deployment 或 release AC。
任何 fixture 若接觸 execution seam、啟動程序或呼叫 Claude SDK `query()`，AC-06 必須失敗，而非把該行為列為 skipped。
Linux platform-neutral run 在 target 可用時補做；target 缺席不把 macOS evidence 改列 Linux evidence。
