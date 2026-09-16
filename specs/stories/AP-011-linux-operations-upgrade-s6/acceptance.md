# Acceptance Criteria

## Happy Path

* [ ] AC-01: on a designated Linux cgroup-v2 test target, a fixed candidate
      installs and starts from administrator-controlled configuration with
      the Gate-approved daemon/launcher/Runtime topology; protected data,
      ledger and credential paths are not writable by the low-privilege Runtime
      or Caller; an external HTTPS MCP Client reaches the approved ingress with
      its own bearer. Install/start acceptance requires a Gate decision that
      permits an installable composition.
* [ ] AC-02: administrator diagnostics distinguish queryable, dispatch-ready,
      recovery-only and unavailable states, identify failed prerequisites without
      private detail, and never report dispatch-ready while Stop Evidence,
      storage, schema or Registry reconciliation is uncertain.
* [ ] AC-03: orderly shutdown stops new admission and dispatch, preserves queued
      Tasks, reconciles every active exact Execution Reference, and closes the
      listener/storage without releasing a claim or publishing terminal success
      before trusted Stop Evidence and durable commit.
* [ ] AC-04: an offline upgrade takes a SQLite/WAL-consistent backup before a new
      binary opens the database; compatible migration preserves Task, receipt,
      Question, Context, claim, event and reserve records across restart without
      automatically rerunning work or redelivering an accepted answer.

## Business Rules

* [ ] AC-05: an older incompatible binary or unsupported newer schema refuses
      dispatch and preserves the original database/WAL/ledger; offline restore or
      rollback uses a compatible recovery reader, pauses the queue and states
      that side effects newer than the backup may lack records.

## Failure Cases

* [ ] AC-06: invalid account, executable, protected path, HTTPS ingress or credential
      configuration fails closed; network-derived forwarding metadata cannot
      override bearer Principal, Host/Origin checks or request bounds, and
      synthetic secrets do not appear in public responses, audit or logs;
      designated-Linux external HTTPS negative calls verify those rejections.

## Regression Requirements

* [ ] AC-07: `make verify`, MCP, fault and designated Linux suites pass for the
      same candidate; existing authorization, generation fencing, Stop Evidence,
      physical reserve and recovery contracts remain compatible.
* [ ] AC-08: a reviewer checks the candidate-bound operations drills, G5 entry
      evidence, privilege/network Gate decisions, final diff, recovery limits and
      runbook before any S6 operations acceptance; no G6, publication or
      production-deployment claim follows from this slice.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | command | `Linux install/start and HTTPS MCP drill log` | `designated cgroup-v2 target, fixed candidate, Gate-approved topology, synthetic configuration and external MCP Client` | `services start under approved privileges, Runtime cannot write control paths and authenticated HTTPS call succeeds` |
| `AC-02` | test | `tests/operations/readiness.test.ts` | `queryable ready, recovering, storage incident, stop-unknown and schema mismatch fixtures` | `diagnostics separate query availability from dispatch eligibility without private detail` |
| `AC-03` | test | `tests/operations/shutdown.test.ts` | `queued Task and multiple exact active Execution References on designated Linux target` | `new work closes, active units stop or remain explicitly unknown, and claims release only after evidence` |
| `AC-04` | command | `Linux upgrade/backup drill log` | `live SQLite WAL, protected reserve and prior compatible schema on fixed candidate` | `consistent backup and migration preserve records while restart performs no replay` |
| `AC-05` | command | `Linux restore/rollback drill log` | `newer schema, older compatible backup and retained Supervisor ledger` | `incompatible binary refuses dispatch and compatible recovery pauses work without deleting evidence` |
| `AC-06` | command | `Linux HTTPS security drill and tests/operations/configuration-security.test.ts` | `designated target plus synthetic wrong identities, paths, network headers, credentials and external MCP calls` | `startup and network rejections stay bounded and sanitized with no identity override` |
| `AC-07` | command | `make verify && pnpm run test:mcp && pnpm run test:faults && pnpm run test:linux` | `same fixed repository and designated Linux candidate` | `all mandatory suites run without skips and exit zero` |
| `AC-08` | human | `ForgePilot Human Review record` | `current candidate, G5 exit records, Gate decisions, drill logs and final diff` | `operations limits and residual risks are accepted without a release or deployment claim` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `administrator.configuration` | `../outside-or-writable-runtime-path` | reject | `sanitized administrator diagnostic` | `tests/operations/configuration-security.test.ts` |
| `network.headers` | `forwarded-principal-and-untrusted-origin` | reject | `bounded protocol audit result` | `tests/operations/configuration-security.test.ts` |
| `bearer` | `synthetic-wrong-bearer` | reject | `fingerprinted audit metadata only` | `tests/operations/configuration-security.test.ts` |
| `runtime.credential` | `synthetic-vendor-secret` | omit | `protected worker credential only` | `tests/operations/configuration-security.test.ts` |
| `backup.path` | `unprotected-or-runtime-writable-target` | reject | `sanitized administrator diagnostic` | `tests/operations/configuration-security.test.ts` |
| `diagnostic.detail` | `sqlite-path-and-supervisor-reference` | redact | `administrator diagnostic and sanitized drill log` | `tests/operations/readiness.test.ts` |

## Verification Notes

The named operations fixtures and Linux drill logs are required implementation
Evidence, not existing passes. `AC-07` must run on the exact candidate used for
the operational drills; `make verify` alone does not satisfy Linux Evidence.
