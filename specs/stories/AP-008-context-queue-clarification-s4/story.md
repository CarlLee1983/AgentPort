# Story: AP-008 — Deliver S4 Context Queue, Clarification, and Continuation

## Goal

將既有受控 S3 execution 擴充為可持久的 Context 佇列與原生澄清往返：Caller 能在同一 Context
追加、修改、回答與明確續接工作；每個 Workspace 維持 eligible FIFO，同時不影響其他 Workspace
的可派送工作，且所有 Task、Question、answer delivery 與 continuation 狀態跨 daemon restart 可查。

## Context

本 Story 對應 [Implementation Plan S4／G4](../../../docs/implementation-plan.md)。WI-006 已完成
S3-B 的受控非互動 dispatch、停止、terminal commit 與基本 recovery；S4 在此基礎上公開完整的
Context interaction，不重建 Task 或 Execution lifecycle。

原生 Claude AskUserQuestion 只經受控 worker ingress 轉成 durable Question。MCP Adapter 不保存
Question、queue 或 Session 狀態；`AgentExecutionService` 是唯一對 Caller 與 dispatcher 提供
Context／Task lifecycle 語意的 module，其持久化實作以短 SQLite transaction 隱藏 CAS、FIFO、
receipt、answer delivery 與 recovery 細節。

## Classification

- Security sensitive: yes
- Baseline conformance: no
- Task mode: execution

## Authority

- plan: yes
- modify: yes
- add_dependency: no
- migration: yes
- commit: no
- push: no
- deploy: no

## Architecture

- Impact: high
- Boundary: `Context queue, durable Question/answer delivery, continuation and public MCP interaction`
- Contract: `AgentExecutionService owns Context, Task, Question and continuation transitions; storage atomically persists them, while MCP, dispatcher and worker only translate at their seams`
- Owner: `Context queue, durable Question/answer delivery, continuation and public MCP interaction = AgentPort maintainers`

## Risk

- Level: high
- Reason: `public mutation contract, cross-principal authorization and durable answer delivery`
- Reason: `Workspace FIFO contention, restart recovery and native Runtime continuation`

## Scope

### In Scope

- Context predecessor and blocker persistence; follow-up Task admission into an existing authorized Context;
  Context-head eligible FIFO per Workspace, global capacity, and concurrent dispatch only across distinct
  unclaimed Workspaces.
- `agentport_edit_task`, `agentport_reply`, `agentport_resume_context`, and
  `agentport_acknowledge_interruption`, plus S4 inputs/projections for Context, predecessor, blocker,
  Question, delivery, continuation and bounded liveness information.
- Atomic expected-revision CAS for editable queued/paused Tasks and resumption; canceled, failed,
  interrupted, and recovery-unknown predecessors pause their dependent Tasks until an eligible explicit
  resume action.
- Durable native Question persistence before publication; answer-schema validation; same-answer receipt
  replay; conflicting second answer rejection; delivery pending/ack/unknown persistence; expiry and
  cancel races.
- Pure-waiting execution-time accounting: a pending Question stops the execution clock only after no
  parallel tool activity is active; answer acceptance resumes it and closes input expiry. The defaults are
  24 hours input wait and 60 minutes accumulated execution time, bounded by the administrator policy.
- `preserve` continuation only with a valid current Context Session reference, and explicit
  `fresh_session` continuation only with Caller-provided summary (including an explicitly empty summary);
  neither mode silently replays prior Runtime commands or changes the Context binding.
- Additive SQLite schema migration, restart/recovery behavior, MCP contract, integration tests and a
  designated Linux/Claude end-to-end interaction harness for G4 evidence.

### Out of Scope

- S5 exhaustive crash matrix, capacity-retention proof, performance targets, repeated-crash testing, or
  any new reliability mechanism deferred to S5.
- S6 packaging, deployment, non-loopback production exposure, release certification, or production-ready
  declaration.
- New Runtime brands, native macOS Runtime execution, a remote scheduler/broker, automatic summaries,
  automatic session resume, or a Caller-selected Workspace, Runtime, Driver, execution reference,
  credential, or launch profile.

## Inputs

- WI-006 S3-B controlled dispatch, trusted Stop Evidence, durable terminal commit, Context Session
  reference and recovery contracts.
- [Implementation Plan S4／G4](../../../docs/implementation-plan.md) and
  [Technical Design sections 3–7](../../../docs/technical-design.md).
- [ADR-0001](../../../docs/adr/0001-external-observation-and-control.md),
  [ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md),
  [ADR-0003](../../../docs/adr/0003-local-transactional-task-store.md), and
  [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md).

## Outputs

- One core-owned Context queue and Question/continuation interface with atomic SQLite implementation.
- S4 MCP schemas, protocol registrations and authorized bounded projections for all ten design tools.
- Additive migration, focused storage/core/MCP/worker tests, and a real Linux Claude interaction harness.
- Explicit G4 verification evidence that distinguishes local deterministic coverage from credentialed
  Linux Runtime evidence.

## Rules

- R1: `AgentExecutionService` is the sole lifecycle owner. The Adapter, dispatcher, worker and
  Supervisor must not maintain a second Task, Context, Question, queue or terminal-state truth.
- R2: A follow-up Task retains its Context Agent, Access Scope and binding; it receives a predecessor
  edge to the prior accepted Context Task. Only an eligible Context head may enter dispatch selection.
- R3: Per Workspace, dispatch selects the lowest queue order among eligible Context heads. Paused Contexts
  do not block unrelated Contexts; a held or quarantined Workspace claim prevents any new dispatch there.
- R4: Edit and resume use expected revision CAS. A race with dispatch, cancel, terminalization, binding
  change or another mutation has one durable winner and leaves a stable authorized projection.
- R5: A native Question is persisted before it is visible. Exactly one schema-valid first answer may be
  accepted; identical receipt replay is idempotent, a distinct answer conflicts, and no answer is
  redelivered automatically after delivery becomes unknown.
- R6: Answer acceptance and worker acknowledgement are distinct. `awaiting_input` remains until delivery
  acknowledgement; restart or worker loss during delivery preserves the answer and converges to recovery
  or safe stop, never a synthetic continuation.
- R7: `preserve` requires a current safe Session reference. `fresh_session` requires an explicit summary
  and records that native continuity was abandoned. Neither changes Task IDs, order, authorization,
  Workspace claim discipline or Runtime command history.
- R8: Every read and mutation rechecks current Principal membership and Agent authorization. Caller or
  worker supplied Context binding, predecessor, Question identity, answer schema, Session reference,
  execution reference, Workspace identity, Runtime options or credential is rejected.

## Expected Errors

- Cross-scope Context/Task/Question reads and mutations are indistinguishable authorized `not_found` or
  `access_denied` projections with no disclosure or worker delivery.
- Stale revisions, non-head resume, concurrent edit/dispatch/cancel, queue saturation, conflicting answer,
  invalid answer schema, expired/closed Question and unavailable continuation return stable application
  errors without changing the durable winner.
- Missing pure-wait evidence, worker delivery timeout, callback loss, Session mismatch, restart evidence
  unknown, or failed stop leaves Question/Task/claim safely awaiting, recovering, stopping or quarantined;
  it does not synthesize success, acknowledgement or a new execution.
- Binding/membership revocation before commit wins; after an already-persisted execution it follows the
  existing trusted stop/recovery contract and never applies a new binding to it.

## Dependencies

- WI-006 is DONE and Human Review approved; this Work Item depends on its S3-B lifecycle, dispatch and
  Session-reference contract.
- The designated Linux environment must supply the G4 real-Claude interaction harness before Human Review.
  Local tests alone may not claim G4 or production readiness.

## Constraints

- Migration is additive and preserves Task, Context, Execution, claim, event, receipt and S3 evidence.
- `make verify` remains the canonical local automated gate. `pnpm run test:linux` and the credentialed
  interaction harness are separate environment evidence and must report their actual result.
- No commit, push, deploy, Human Review, Gate resolution or publication is authorized by this Story.
- Runtime worker remains unable to read the AgentPort database, Supervisor ledger or launcher privilege;
  credentials, raw prompts/answers, raw host paths and raw SDK errors do not enter durable records,
  events, receipts, logs or public projections.
- A changed public lifecycle, authorization, Session, queue or Runtime capability semantic requires a
  ForgePilot Gate before affected implementation continues.

## Guidance

- [Engineering entry](../../../guidance/ENTRY.md): preserve one source of truth and test behavior at the
  narrowest useful seam.
- [Development workflow](../../../docs/development-workflow.md): use candidate-bound verification,
  environment evidence and Gates for changed contracts.
- [ADR-0001](../../../docs/adr/0001-external-observation-and-control.md): external query/cancel/reply
  remain independent from the Runtime work input queue.

## Trust Boundary Fields

- `contextId` — Caller-selected logical Context identity; authorized only within the current Access Scope
  and never permitted to alter its fixed binding.
- `taskId` — Caller-selected Task identity; authorized only within the current Access Scope.
- `operationId` — Caller idempotency identity, scoped to operation type and immutable input fingerprint.
- `expectedRevision` — Caller concurrency precondition for edit, resume and interruption acknowledgement.
- `questionId` — worker-created, current-execution-bound Question identity; Caller may reference but cannot
  create or rebind it.
- `answer` — Caller input validated against the persisted bounded Question schema before first-answer commit.
- `continuationMode` — Caller selects only `preserve` or `fresh_session`; it cannot select a Runtime Session.
- `contextSummary` — bounded Caller-provided fresh-session input; never generated from, or used to replay,
  prior Runtime commands.
- `worker.question` — external native Question observation bound to the current Execution Reference.
- `worker.answerAck` — external delivery acknowledgement bound to the accepted Question and execution.
- `sessionReference` — Runtime-derived opaque reference, stored only after trusted core validation.
- `error.details` — internal storage, Runtime or authorization failure detail that is redacted into a bounded
  public projection.
