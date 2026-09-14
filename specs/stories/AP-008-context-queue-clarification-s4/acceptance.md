# Acceptance Criteria

## Happy Path

- [ ] AC-01: an authorized Caller can submit a follow-up into an existing Context; the durable Task has the
      same Context binding, an immutable predecessor edge and a later queue order, while a new submission
      creates a new Context.
- [ ] AC-02: scheduler selection chooses only eligible Context heads, preserves FIFO for each Workspace,
      allows independent Workspaces to dispatch concurrently, and never dispatches behind an unfinished or
      paused predecessor.
- [ ] AC-03: an authorized Caller can edit only a never-started queued or paused Task with its current
      expected revision; the committed instruction, revision and event form the sole projection.
- [ ] AC-04: a native Claude Question is durably recorded before `agentport_get_task` exposes it; an
      authorized same-scope Principal supplies the first valid answer, the worker acknowledges delivery,
      and the same Task returns from `awaiting_input` to `running` without releasing its Workspace claim.
- [ ] AC-05: `agentport_resume_context` resumes only the named removable predecessor blocker. `preserve`
      uses a valid Context Session reference; `fresh_session` uses an explicit Caller summary and retains
      Task identity/order while explicitly reporting that native continuity was abandoned.

## Failure Cases

- [ ] AC-06: cross-scope, inactive-membership or Caller/worker-controlled Context binding, predecessor,
      Question, answer schema, Session, execution, Workspace, Runtime-option or credential inputs are
      rejected without disclosure, queue mutation, worker delivery or Runtime side effect.
- [ ] AC-07: identical answer receipt replay is idempotent, a different answer conflicts, and invalid,
      expired, canceled, closed or delivery-unknown Questions never receive a second delivery or synthetic
      acknowledgement.
- [ ] AC-08: concurrent edit/dispatch/cancel/resume/reply operations linearize at their durable transaction;
      stale revisions and non-head actions fail with a stable projection, and restart preserves the committed
      winner without replaying a Runtime command or answer.

## Business Rules

- [ ] AC-09: all ten design tools use shared core types and one authorized bounded Task projection that
      includes Context/predecessor/blocker, Question status/delivery, continuation and liveness; MCP Adapter
      stores neither a second queue nor Question state.
- [ ] AC-10: a pending Question pauses the accumulated execution clock only after durable pure-wait evidence
      shows no parallel tool activity; first answer acceptance closes input expiry and resumes execution
      accounting, while a held Workspace claim remains until trusted terminalization.

## Regression Requirements

- [ ] AC-11: additive S4 migration preserves existing S3 Tasks, Contexts, Executions, claims, receipts,
      events and Session references; recovery never auto-resumes a Runtime callback or replays a committed
      answer after daemon/worker crash.
- [ ] AC-12: `make verify` passes in a fresh fixed-toolchain checkout; designated Linux Claude interaction
      evidence executes the MCP question/reply/continuation path and records its actual nonzero or success
      outcome separately from the local gate.

## Acceptance Evidence

<!-- prettier-ignore -->
| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/integration/s4-context-queue.test.ts` | `real SQLite with authorized new and existing Context submissions` | `follow-up retains binding and predecessor; new submission creates isolated Context` |
| `AC-02` | test | `tests/integration/s4-context-queue.test.ts` | `competing Context heads across same and distinct Workspaces` | `same Workspace FIFO; blocked followers excluded; distinct Workspaces may proceed` |
| `AC-03` | test | `tests/integration/s4-edit-transactions.test.ts` | `queued/paused Tasks and concurrent expected-revision operations` | `exactly one committed edit, revision/event update and stable loser projection` |
| `AC-04` | test | `tests/integration/s4-question-delivery.test.ts` | `real SQLite, Reference-bound native Question and controlled worker acknowledgement` | `Question precedes publication; valid first answer is acked and resumes same Task with claim held` |
| `AC-05` | test | `tests/integration/s4-context-resume.test.ts` | `paused predecessor chain, valid/invalid Session references and fresh summary` | `only named removable blocker clears; preserve/fresh semantics are explicit and durable` |
| `AC-06` | test | `tests/acceptance/s4-authorization.test.ts` | `official MCP Client, two Access Scopes and spoofed Caller/worker fields` | `indistinguishable rejection with no disclosure, persistence mutation, delivery or dispatch` |
| `AC-07` | test | `tests/integration/s4-question-delivery.test.ts` | `duplicate/conflicting answers, invalid schemas, expiry, cancel and delivery-unknown fixtures` | `one first answer at most; no automatic redelivery or synthetic acknowledgement` |
| `AC-08` | test | `tests/integration/s4-interaction-races.test.ts` | `real SQLite barriers for edit/dispatch/cancel/resume/reply plus restart` | `durable transaction winner survives restart; no Runtime or answer replay` |
| `AC-09` | test | `tests/acceptance/s4-mcp-interaction.test.ts` | `official MCP Client across every S4 tool and bounded projections` | `all tools delegate to shared core contract; no Adapter-owned queue/Question state` |
| `AC-10` | test | `tests/integration/s4-time-accounting.test.ts` | `controllable clock, pure-wait evidence and parallel-tool fixture` | `only pure waiting pauses execution budget; accepted answer resumes it and retains claim` |
| `AC-11` | test | `tests/integration/s4-migration-recovery.test.ts` | `pre-S4 S3 SQLite database and crash windows around answer commit/delivery/ack` | `additive preservation; restart does not resume callback or replay answer` |
| `AC-12` | command | `make verify && pnpm run test:claude` | `fresh local checkout plus designated Linux Claude credential environment` | `local gate passes; external harness records actual end-to-end question/reply/continuation result` |

## Security Fixture Matrix

<!-- prettier-ignore -->
| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `contextId` | `context-outside-access-scope` | reject | `sanitized application error` | `tests/acceptance/s4-authorization.test.ts` |
| `taskId` | `task-outside-access-scope` | reject | `sanitized application error` | `tests/acceptance/s4-authorization.test.ts` |
| `operationId` | `reused-with-different-input` | reject | `sanitized receipt conflict` | `tests/integration/s4-interaction-races.test.ts` |
| `expectedRevision` | `stale-or-racing-revision` | reject | `unchanged durable winner` | `tests/integration/s4-edit-transactions.test.ts` |
| `questionId` | `cross-task-or-cross-execution-question` | reject | `sanitized application error` | `tests/acceptance/s4-authorization.test.ts` |
| `answer` | `invalid-or-conflicting-answer` | reject | `bounded answer receipt/error` | `tests/integration/s4-question-delivery.test.ts` |
| `continuationMode` | `unknown-or-preserve-without-session` | reject | `sanitized continuation error` | `tests/integration/s4-context-resume.test.ts` |
| `contextSummary` | `oversized-or-untrusted-replay-content` | reject | `bounded validation error` | `tests/integration/s4-context-resume.test.ts` |
| `worker.question` | `unbound-or-oversized-native-question` | reject | `sanitized worker error without Question` | `tests/integration/s4-question-delivery.test.ts` |
| `worker.answerAck` | `cross-question-or-duplicate-ack` | reject | `unchanged accepted delivery state` | `tests/integration/s4-question-delivery.test.ts` |
| `sessionReference` | `caller-or-cross-context-session` | reject | `sanitized continuation error` | `tests/integration/s4-context-resume.test.ts` |
| `error.details` | `credential-path-prompt-or-cross-scope-identity` | redact | `bounded application error/event` | `tests/acceptance/s4-authorization.test.ts` |

## Verification Notes

S4 may claim G4 only when the designated Linux Claude harness demonstrates a real MCP native-question,
same-scope reply and same-Task continuation, including its actual target/candidate output. Local deterministic
tests prove storage, authorization, ordering, races and recovery; they do not replace Linux Stop Evidence or
real Runtime interaction. S5 reliability and S6 release claims remain out of scope.
