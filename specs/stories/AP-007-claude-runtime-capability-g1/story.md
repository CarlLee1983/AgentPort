# Story: AP-007 — Prove Claude Runtime Capability After G1-L

## Goal

在已完成且經 Human Review 接受的 AP-004 G1-L Linux execution-control
boundary 內，以受控、不可由 production composition 到達的 harness，證明真 Claude
subscription Runtime 能產生 structured result、完成原生 AskUserQuestion 回答後續行、
在 active 與 pure-waiting 狀態可靠取消，並維持安全的 credential 與 Session reference
邊界。

## Context

GATE-021 已將 real Claude subscription authentication 與 Runtime capability 從 AP-004
移出：AP-004／WI-005 只證明 Linux containment、Stop Evidence、IPC 與
no-production-dispatch。GATE-020 已選擇專用 `agentport-runtime` 帳號的 Claude
subscription OAuth；credential 僅保存在 mode `0700` runtime home，僅供本 Story harness
使用，且不得出現在 repository、IPC、log 或 evidence。

本 Story 是 G1-L 之後的獨立 Runtime capability evidence，不是 S3-B production
integration。AP-005／S3-B 必須同時等待本 Story Work Item DONE 且經 Human Review 接受，
才可依賴其 Claude capability evidence。

## Classification

- Security sensitive: yes
- Baseline conformance: no
- Task mode: mixed

## Authority

以下權限只在 AP-004 G1-L 已 DONE 且經 Human Review、指定 Linux target 的本 Story
ForgePilot Gate 已由 Human resolve、Work Item 為 READY，並有明確 Start 交辦後生效。

- plan: yes
- modify: yes
- add_dependency: no
- migration: no
- commit: no
- push: no
- deploy: no

## Architecture

- Impact: high
- Boundary: `Claude Runtime capability harness`
- Contract: `Only a bounded, Reference-bound Driver projection may expose Claude result, native-question, cancellation, or Session capability evidence`
- Owner: `Claude Runtime capability harness = AgentPort maintainers`

## Risk

- Level: high
- Reason: `vendor credential and subscription authentication isolation`
- Reason: `native interactive callback and cancellation semantics`

## Scope

### In Scope

- 在 AP-004 已驗證的 designated Linux target、cgroup v2 Execution Unit、專用低權限
  `agentport-runtime` account、protected launcher／worker IPC boundary 內，實作及驗證
  `src/runtime/claude/` 最小 Driver。
- 依 GATE-020 使用該帳號 mode `0700` runtime home 內的 Claude subscription OAuth，
  驗證 credential isolation、最小 worker exposure、redaction 與可重現但非秘密的環境 metadata。
- 固定 Claude Agent SDK／Claude binary 的真 `test:claude` capability suite：
  non-interactive structured result、native AskUserQuestion、valid answer、同一 execution
  continuation、active cancellation、pure-waiting cancellation，以及安全有界 Session reference。
- AskUserQuestion 與一般 permission request 分流；Question／answer／continuation 必須綁定
  native tool-use identity、完整 Execution Reference 與 bounded schema／payload。
- Reference-bound、ordinal-bound worker observations 和 bounded sanitized Driver result／error
  projection；測試 credential、prompt、host path 與 cross-execution Session leakage 不可見。
- `test:claude`、deterministic contract fixtures 及 candidate-bound evidence；所有 harness、Driver
  與 worker 仍不可由 production bootstrap 或 MCP mutation path 到達。

### Out of Scope

- AP-004 的 Linux containment、generation fencing、cgroup descendant cleanup、Stop Evidence、
  launcher privilege 或 IPC 基礎契約重新實作或放寬。
- production MCP dispatcher、production bootstrap composition、公開 Runtime dispatch、terminal
  result／event、Workspace claim release、部署或 production readiness 宣告。
- S3-B transaction／recovery integration、S4 public Clarification Reply／Follow-up Task／queue／
  edit／resume，或以本 Story建立公開互動 API。
- Anthropic Console/API credential、共用 credential、worker-selected credential source，或將
  subscription OAuth 轉交 Caller、Workspace、repository、IPC、log、evidence 或 error output。

## Inputs

- AP-004 G1-L Work Item DONE 且 Human Review 接受的 Linux Supervisor／launcher／isolated-worker
  boundary與 Stop Evidence；此 Story 不以 mock、macOS 或 Docker Desktop 替代。
- GATE-020 resolved credential policy：專用 `agentport-runtime` account 的 subscription OAuth，
  僅在 mode `0700` runtime home 使用。
- [ADR-0001](../../../docs/adr/0001-external-observation-and-control.md) 的 external control／
  isolated worker boundary。
- [ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md) 的 unknown 不自動重跑語意。
- [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md) 的 Linux-only Runtime
  execution 與 reliable Stop Evidence boundary。
- [Technical Design](../../../docs/technical-design.md) 的 Claude Driver、native question、
  Session、cancellation、credential 與 IPC contracts。

## Outputs

- `src/runtime/claude/` 的最小 Claude Agent SDK Driver，及其僅由 controlled capability harness
  組裝的 adapter seam。
- 真 `test:claude` capability suite，包含 structured result、native question/answer/continuation、
  active／pure-waiting cancellation、Session reference、credential isolation 和 redaction evidence。
- candidate-bound、sanitized G1 Claude capability evidence，明確記錄 target、runtime account、
  fixed SDK／binary、commands、event ordering、cancellation observation 與限制。

## Rules

- R1: 此 Story 只可在 AP-004 G1-L accepted boundary 內執行；Driver 不可替代、偽造、弱化或
  重新解釋 Linux Stop Evidence，所有 production reachability 維持零。
- R2: OAuth credential 只能由 mode `0700` `agentport-runtime` runtime home 解析並供指定 worker
  使用；worker、Caller、Workspace 與 Driver input 不得選擇、回傳、持久化或投影 credential。
- R3: 真 Claude result 只是 bounded Driver candidate observation；SDK resolve、EOF、exit code 或
  Session reference 均不代表 production terminal result、Task completion 或 claim release。
- R4: 只有原生 `AskUserQuestion` tool-use callback 可建立 question observation；一般 permission
  request 依固定 policy 分流，assistant text 問號、任意 tool name 或 Caller answer 不可偽裝問題。
- R5: answer 必須綁定同一 executionReference、native tool-use/question identity 與 schema；回答
  後必須由同一受控 execution native callback 續行，不能用新 Session、重播 command 或 synthetic
  continuation 替代。
- R6: 宣告 pure waiting 前必須證明沒有平行 tool activity；active 與 pure-waiting cancellation
  都必須經 AP-004 Supervisor revoke-and-stop，SDK abort／cancel acknowledgement 不等於 Stop Evidence。
- R7: Session reference 只可由 Driver 外部衍生，必須 bounded、sanitized、execution-bound 且不含
  credential、prompt、host path 或 raw SDK state；不得當作 Task／Context identity 或跨 execution resume token。
- R8: missing login、wrong subscription account、SDK／binary protocol mismatch、native question／
  cancellation capability unavailable，皆使 `test:claude` nonzero；不得以 skip、mock 或 synthetic
  result 通過。

## Expected Errors

- missing／expired／wrong-account OAuth、mode／ownership 不符或 credential source 不可讀時，拒絕
  啟動 capability harness，輸出 bounded sanitized unavailable／authentication failure，且不洩漏 secret。
- stale／cross-execution Reference、question／tool-use identity mismatch、invalid answer schema、
  duplicate／skipped ordinal、oversized observation 或 Session reference 時拒絕，不續行 Runtime。
- AskUserQuestion 與一般 permission request 無法可靠分流、平行 tool activity 未靜止、或 callback
  無法在同一 execution 繼續時，回 capability failure，不宣稱 pure waiting 或 continuation。
- active／waiting cancel timeout、worker／SDK 不回覆或 AP-004 stop status unknown 時，保留
  indeterminate／unavailable；不得發出 stopped、completed、canceled 或 production terminal result。
- credential-shaped value、raw SDK error、prompt、host path 或 cross-scope identity 進入 IPC、log、
  evidence、Session reference 或 error projection 時，redaction test 必須失敗。

## Dependencies

- AP-001 的固定 Node／pnpm／Claude Agent SDK compatibility baseline。
- AP-004 G1-L Work Item 必須 DONE 且 Human Review 接受；AP-004 Linux evidence 是本 Story的
  execution-control prerequisite，不含 Claude subscription capability claim。
- GATE-020 的 resolved subscription OAuth credential policy；target 必須具專用
  `agentport-runtime` account、mode `0700` runtime home 及有效 login。
- AP-005／S3-B Work Item 必須在 ForgePilot 以 dependency 或 blocking Gate 等候本 Story；
  S3-B 只有在 AP-007 DONE 且 Human-reviewed 後才可接入 Claude production dispatch。
- Human 必須指定並核准 target／subscription account 的 non-secret identity、SDK／binary versions
  與 harness launch profile；未定義或不相容時開 ForgePilot Gate。

## Constraints

- 本 Story 不新增 production import／composition route、hidden feature flag、public tool、deployment、
  schema migration 或 lifecycle authority；在 G1-C acceptance 前，`src/runtime/claude/` 僅由
  test／controlled harness composition 可達。AP-005 之後只有在 G1-L 與 G1-C 都經 Human Review
  接受時，才可將 accepted Driver 接入 production composition。
- 不以 credential absence 或 external-suite skip 當 PASS；`make verify` 仍無 credential，真能力只由
  designated Linux target 的 `test:claude` 證明。
- 不將 raw OAuth、subscription session、cookie、env dump、prompt、answer、host path 或 raw SDK
  error 寫入 repository、ForgePilot evidence、test output、IPC、log 或 durable storage。
- Runtime worker 不取得 AgentPort DB、Supervisor ledger、launcher privilege 或其他 execution
  credential；同帳號不承諾 Workspace 間檔案隔離，也不將 prompt policy 說成 OS isolation。
- 若 credential storage／injection、native callback semantics、Session bounds、cancel behavior 或
  production-boundary contract 與既有設計衝突，停止 affected work 並開 ForgePilot Gate。

## Guidance

- [Engineering entry](../../../guidance/ENTRY.md)：最小內聚切片、明確依賴與行為導向測試。
- [Development workflow](../../../docs/development-workflow.md)：environment evidence、candidate、Gate 與 Human Review。
- [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)：Linux-only Runtime execution 與 Stop Evidence。

## Trust Boundary Fields

- `executionReference` — AP-004 trusted boundary persisted identity；Driver／worker／Caller 不得選擇或改寫。
- `worker.observation` — worker IPC 的 Reference-bound ordinal、result、question、answer-ack 和 cancel payload。
- `nativeToolUseId` — Claude SDK 外部衍生 AskUserQuestion identity；只可與 current execution question 配對。
- `questionPayload` — native bounded question schema／content；不得由 arbitrary assistant text 或 Caller 偽造。
- `answerPayload` — 依 native question schema 驗證的 bounded response；只交給 current waiting callback。
- `toolActivity` — Driver 外部觀察的 bounded parallel activity state；未知時不可宣告 pure waiting。
- `vendorCredential` — mode `0700` runtime home 的 subscription OAuth；只可注入指定 worker，不得回傳或持久化。
- `sessionReference` — Claude SDK 外部衍生 bounded reference；不得含 credential 或成為跨 execution identity。
- `error.details` — SDK／authentication／IPC／cancel failure 的 sanitized bounded projection。
- `evidence.label` — target／account role／version／fixture metadata；不得含 OAuth、prompt、host secret 或完整 path。
