# Acceptance Criteria

## Happy Path

* [ ] AC-01: a submit committed before response loss returns its original Task
      on identical retry after restart; a pre-commit crash leaves no Task,
      receipt, claim or Runtime start.
* [ ] AC-02: claim-before-launch, launch-before-ack and daemon/worker loss retain
      the exact claim and Reference until reconciliation; recovery and a second
      crash never create a new generation or replay the instruction.
* [ ] AC-03: revoke-before-start, delayed launcher I/O and Supervisor restart
      seal the old generation and prove its exact Execution Unit empty before
      accepting Stop Evidence or releasing the Workspace.
* [ ] AC-04: answer commit, callback delivery and ack crash boundaries retain
      one first answer. While its original callback remains alive, the durable
      execution-time limit remains enforced; after daemon or worker restart,
      missing ack becomes delivery unknown, execution accounting is stopped,
      and the answer is never sent to a new callback or replayed. Original
      Question expiry does not close an accepted answer. The live deadline
      observation requires a controlled production worker-entrypoint harness;
      a platform-neutral ingress fixture cannot establish it.

## Business Rules

* [ ] AC-05: a complete candidate plus exact Stop Evidence terminalizes only
      through a durable transaction; cleanup or commit crash preserves unknown
      outcome and claim until recovery proves the result and stop ordering.
      Unknown outcome is not terminal-retention expired, and interruption
      acknowledgement can close it only after trusted stop.

## Failure Cases

* [ ] AC-06: repeated recovery crash, absent candidate ordinal, unavailable
      storage or stop uncertainty leave recoverable/unknown or quarantined state;
      authorized query reports only bounded, sanitized status and no false
      Task success or cross-scope detail. Explicit Context resume cannot remove
      unrelated authorization, binding, claim or stop-unknown blockers.

## Regression Requirements

* [ ] AC-07: every matrix row records candidate, fixture, persistent Task,
      Execution, Question, receipt and claim state, actual Runtime start count
      and trusted Stop Evidence where applicable. Applicable boundaries include
      daemon, worker and Supervisor restarts plus a second recovery-time crash;
      rows record source/version/time, command, expected and actual result, and
      result location. The matrix is registered in `test:faults`; `make verify`,
      fault and Linux suites pass for that same candidate without required skips.
* [ ] AC-08: Human Review checks the complete matrix, any regression fixes,
      Linux evidence and residual risk; this crash slice alone does not claim
      S5/G5 or S6 completion.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/integration/g5-crash-window-matrix.test.ts` | `real SQLite admission commit/response barriers and identical retry` | `one original receipt after commit and no Task or Runtime side effect before commit` |
| `AC-02` | test | `tests/integration/g5-crash-window-matrix.test.ts` | `claim/launch/ack barriers, worker loss and repeated daemon restart` | `exact claim and Reference survive without a second generation or instruction replay` |
| `AC-03` | test | `tests/linux/g5-crash-window-matrix.test.ts; tests/linux/execution-supervisor-stop.test.ts; tests/linux/execution-supervisor-reconcile.test.ts` | `designated cgroup-v2 target with delayed start/revoke, nonempty exact unit and repeated launcher/Supervisor restart` | `old generation stays fenced and sealed generation plus empty exact unit precede Stop Evidence and claim release` |
| `AC-04` | test | `tests/integration/g5-crash-window-matrix.test.ts; tests/linux/g5-worker-deadline.test.ts` | `committed native Question answer with its original live callback, callback/ack loss, original expiry and restart; protected worker credential with a controllable Claude driver for deadline evidence` | `integration fixture proves first-answer durability, expiry closure and restart delivery-unknown/stopped accounting with no redelivery or replay; the still-missing worker-entrypoint fixture must prove its active deadline aborts after the same live callback resumes` |
| `AC-05` | test | `tests/integration/g5-crash-window-matrix.test.ts` | `candidate, Stop Evidence, cleanup, terminal-commit and retention barriers` | `terminal result commits once or remains unknown with held claim; TTL and acknowledgement cannot erase unproven stop` |
| `AC-06` | test | `tests/acceptance/g5-crash-window-projection.test.ts` | `repeat-crash, ordinal-gap, stop-unknown, blocked Context resume and two-scope MCP fixtures` | `authorized projection is bounded; resume retains unrelated blockers and no false success or foreign detail appears` |
| `AC-07` | command | `make verify && pnpm run test:faults && pnpm run test:linux` | `same exact candidate, test:faults-registered matrix, designated Linux target and provenance records for applicable repeated restarts` | `required suites run and exit zero with expected/actual durable state, start count and Stop Evidence recorded` |
| `AC-08` | human | `ForgePilot Human Review record` | `current candidate, complete matrix, Linux logs and final diff` | `crash evidence and risks are assessed without a G5 or S6 completion claim` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `operationId` | `same-key-conflicting-input` | reject | `sanitized operation receipt or conflict` | `tests/integration/g5-crash-window-matrix.test.ts` |
| `taskId` | `foreign-scope-task-id` | reject | `bounded public error` | `tests/acceptance/g5-crash-window-projection.test.ts` |
| `execution.reference` | `stale-generation-or-daemon-epoch` | reject | `durable quarantine and sanitized fault row` | `tests/linux/g5-crash-window-matrix.test.ts` |
| `question.answer` | `synthetic-private-first-answer` | omit | `protected durable Question record only` | `tests/integration/g5-crash-window-matrix.test.ts` |
| `worker.observation` | `ordinal-gap-or-untrusted-terminal` | reject | `bounded recovery diagnostic` | `tests/integration/g5-crash-window-matrix.test.ts` |
| `error.details` | `sqlite-path-supervisor-reference-and-worker-stderr` | redact | `public projection and sanitized evidence log` | `tests/acceptance/g5-crash-window-projection.test.ts` |

## Verification Notes

The G5 fixtures named above are required work, not historical passes. Matrix
evidence must distinguish scripted contract observations from trusted Linux
Stop Evidence and retain the first failed as well as later passing runs.

The current platform-neutral test harness cannot start `runtime/worker/entrypoint`
with its required `/run/credentials` protected credential or replace its Claude
SDK driver. Therefore it cannot claim that the entrypoint's `ActiveExecutionDeadline`
aborts after a live callback resumes. That evidence remains missing until a
controlled production worker-entrypoint harness is available.
