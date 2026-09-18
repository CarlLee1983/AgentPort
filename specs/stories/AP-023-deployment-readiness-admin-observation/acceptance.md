# Acceptance Criteria

## Happy Path

* [ ] AC-01: after the Gate-approved protocol is implemented, the non-root
      production daemon owns the documented local administrator socket for its
      lifetime and an authorized administrator obtains a versioned, bounded,
      read-only Deployment Readiness snapshot without opening another network
      listener or mutating durable state.
* [ ] AC-02: the snapshot distinguishes `installed`, `service-ready`,
      `execution-ready` and `recovery-blocked`, includes a sanitized reason and
      observation time, and keeps zero configured Agents service-ready rather
      than inferring execution readiness.
* [ ] AC-03: `agentport doctor` performs the documented offline checks without
      starting the daemon, opening SQLite, calling a Runtime or reading Runtime
      credentials; an explicitly requested `--live` check follows the
      Gate-approved bounded observation contract.

## Business Rules

* [ ] AC-04: stale, missing or uncertain observation; recovery/quarantine;
      storage incident; protected-topology drift; missing Agent; or unverified
      Runtime prerequisite is never projected as `execution-ready`, and does
      not enable a production submission, Task, Workspace claim, Execution
      generation or launcher request.
* [ ] AC-05: the local administrator boundary is read-only: an authorized
      query cannot alter daemon lifecycle, Registry, Task, Execution, storage,
      dispatch, configuration or credential state.

## Failure Cases

* [ ] AC-06: a Runtime process, a non-administrator local process, malformed
      or oversized request, unavailable daemon, unsafe socket metadata or
      failing diagnostic receives only the Gate-approved stable sanitized
      rejection/result; no bearer, credential, protected path, numeric identity,
      launcher reference, Runtime environment, database content or raw cause
      appears in output, audit, logs or durable storage.

## Regression Requirements

* [ ] AC-07: focused readiness/admin/doctor tests, `pnpm run
      test:platform-neutral` and `make verify` pass; the same candidate passes
      the designated Linux/systemd socket-permission and Runtime-denial suite
      without skips.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/integration/production-daemon-admin.test.ts` | `non-root daemon, protected admin socket fixture and Gate-approved administrator client` | `one daemon-owned local read-only snapshot with no network listener or durable mutation` |
| `AC-02` | test | `tests/unit/deployment-readiness.test.ts` | `installed, zero-Agent, complete-prerequisite, recovery and stale observation fixtures` | `four host-level levels, reason and observed-at fields remain distinct from Task readiness` |
| `AC-03` | test | `tests/operations/doctor.test.ts` | `offline protected-layout fixture plus explicit live-observation seam` | `offline checks avoid daemon/SQLite/Runtime access and live behavior is explicit and bounded` |
| `AC-04` | test | `tests/unit/deployment-readiness.test.ts; tests/acceptance/production-daemon-mcp.test.ts` | `uncertain prerequisite and rejected production-submission fixtures` | `no uncertain state is execution-ready and no blocked submission has a durable or launcher side effect` |
| `AC-05` | test | `tests/integration/production-daemon-admin.test.ts` | `authorized repeated read-only queries with mutation counters` | `querying preserves all daemon and product state` |
| `AC-06` | test | `tests/contracts/deployment-readiness-admin-boundary.test.ts; tests/operations/doctor.test.ts` | `Runtime/non-admin clients, malformed/oversized bytes, unsafe socket metadata and secret sentinels` | `stable sanitized denial or failure with no prohibited disclosure or state change` |
| `AC-07` | command | `pnpm run test:platform-neutral && make verify && pnpm run test:linux` | `same candidate and designated Ubuntu 24.04 amd64 systemd/cgroup-v2 target` | `repository gate passes and Linux socket isolation suite runs without skips` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `admin.socket.peer` | `agentport-runtime-or-unprivileged-uid` | reject | `none` | `tests/contracts/deployment-readiness-admin-boundary.test.ts` |
| `admin.request` | `oversized-or-malformed-readiness-query` | reject | `none` | `tests/contracts/deployment-readiness-admin-boundary.test.ts` |
| `doctor.arguments` | `unexpected-live-or-path-argument` | reject | `sanitized-command-result` | `tests/operations/doctor.test.ts` |
| `doctor.hostObservation` | `unsafe-socket-or-topology-metadata` | reject | `sanitized-readiness-result` | `tests/operations/doctor.test.ts` |
| `readiness.reason` | `protected-path-and-launcher-reference-sentinel` | omit | `admin-result-and-diagnostic-output` | `tests/contracts/deployment-readiness-admin-boundary.test.ts` |
| `runtime.observation` | `runtime-credential-sentinel` | omit | `admin-result-and-diagnostic-output` | `tests/operations/doctor.test.ts` |

## Verification Notes

The Gate decision is a prerequisite for the protocol, authorization and
projection acceptance paths. Linux evidence must use the exact candidate that
passed the repository gate; a local macOS run or a skipped Linux test does not
establish administrator-boundary or Deployment Readiness evidence.
