# Story: AP-023 — Deployment Readiness and Administrator Observation

## Goal

Give the host administrator a bounded, sanitized and authoritative way to
observe AgentPort Deployment Readiness, without confusing that operational
judgment with Task lifecycle or granting Callers or the Runtime control-plane
access.

## Context

AP-022 provides the accepted non-root production daemon skeleton, fixed
loopback MCP listener and lifecycle fence. It deliberately does not establish
Deployment Readiness or positive production admission. The accepted Linux
deployment contract reserves a daemon-owned, read-only administrator socket at
`/run/agentport/admin.sock`, defines the four Deployment Readiness levels, and
requires an offline `agentport doctor` check when the daemon is not running.

The socket request/response protocol, authorization mechanism beyond the
documented Unix ownership/mode, and the exact safe readiness observation
projection are not specified by the accepted contract. They must be decided by
a ForgePilot Gate before this Story changes a public administrator interface.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: no
* push: no
* deploy: no

## Risk

* Level: high
* Reason: `privilege-boundary`
* Reason: `public-admin-interface`
* Reason: `error-projection`

## Error Projection

* Source failure: `administrator socket ownership, authorization, malformed request, unavailable daemon, offline host check, Runtime capability observation, recovery state and stale observation`
* Public projection: `a stable, bounded administrator result or sanitized command failure; never a Task or MCP mutation result`
* Detail policy: `omit credential material, bearer values, protected paths, numeric identities, launcher references, Runtime environment values, database contents and raw error causes`
* Evidence AC: `AC-06`

## Scope

### In Scope

* A daemon-owned, local administrator-observation boundary at the accepted
  admin socket location, started and stopped with the AP-022 daemon lifecycle.
* A host-level Deployment Readiness evaluator and immutable sanitized snapshot
  that use the established `installed`, `service-ready`, `execution-ready` and
  `recovery-blocked` vocabulary, reason code and observation time.
* Read-only observation of the daemon lifecycle, Registry/Agent availability,
  protected launcher/Runtime prerequisites and recovery/storage/quarantine
  conditions needed to make the Deployment Readiness judgment.
* An offline `agentport doctor` command and an explicit `--live` path with the
  Gate-approved behavior, output bounds and no default paid Runtime call.
* Focused platform-neutral and designated Linux/systemd tests, systemd unit and
  operations documentation that preserve AP-022's service-ready skeleton and
  dispatch fence.

### Out of Scope

* AP-024 Caller add/list/revoke, bearer-token hashing, positive production
  Caller provisioning, Registry hot reload or any change that makes production
  submission succeed.
* TLS, remote administrator access, a network listener, deployment, account
  creation, service enablement, credential generation or rotation.
* Task/Execution lifecycle schema changes, Runtime commands, automatic Task
  replay, a scheduler, or treating liveness, an open MCP port or a successful
  admin query as trusted Stop Evidence.

## Inputs

* AP-020 Linux deployment contract and accepted ADR-0006, ADR-0010.
* AP-021 controlled non-root Runtime composition and AP-022 accepted production
  daemon lifecycle at candidate `6c869528d83c`.
* `CONTEXT.md` Deployment Readiness terminology and
  `docs/technical-design.md` Linux deployment/readiness contract.

## Outputs

* A documented, read-only administrator observation interface and sanitized
  Deployment Readiness snapshot after the Gate decision.
* Offline and explicitly live administrator diagnostics with focused tests.
* Candidate-bound Linux/systemd evidence that the Runtime lacks administrator
  socket access and no non-ready condition admits a production Task.

## Rules

* R1: Deployment Readiness remains a host-level operational judgment. It must
  not reuse, rename or alter `TaskSnapshot.readiness`, Task state, Execution
  state or trusted Stop Evidence semantics.
* R2: An unobserved or stale result is never `execution-ready`; recovery,
  quarantine, storage uncertainty, invalid protected topology or unavailable
  prerequisite must fail closed to a non-execution-ready result.
* R3: The administrator socket is read-only and local. It may not accept
  Caller-derived identity, Task input, Runtime instruction, filesystem path or
  control command, and Runtime access is denied by the accepted Unix boundary.
* R4: Zero configured Agents remains `service-ready` when the daemon is
  otherwise queryable; it is never `execution-ready` solely because the daemon
  or MCP listener is live.
* R5: Default doctor behavior makes no paid Runtime call and never reads,
  copies or emits Runtime credentials. Any live Runtime check is explicit and
  follows the Gate-approved bounded failure contract.
* R6: AP-023 must not open production admission before AP-024 provides Caller
  provisioning; every non-ready submission still creates no Task, Workspace
  claim, Execution generation or launcher request.

## Expected Errors

* A missing, unavailable, unauthorized or malformed administrator request is
  rejected with a stable bounded result and cannot change daemon, Registry,
  Task, Execution or storage state.
* Offline or live diagnostics with missing, stale, incompatible or uncertain
  prerequisites report a sanitized non-execution-ready result rather than
  guessing readiness.
* Socket setup, query, teardown and diagnostic failures expose no protected
  path, credential, bearer, Runtime environment, database or launcher detail.

## Dependencies

* AP-022 / WI-023 is DONE with current PASS evidence and Human Review at
  `6c869528d83c`.
* A ForgePilot Gate resolves the administrator protocol, authorization and
  projection contract before behavior-changing implementation begins.
* AP-024 remains a follow-on dependency for managed Callers and positive
  production submission.

## Constraints

* No new runtime dependency, database migration, external network listener,
  privileged daemon, credential route, commit, push, deploy or service
  installation.
* Preserve the accepted root launcher/non-root daemon/low-privilege Runtime
  topology and the AP-022 lifecycle/restart/recovery contracts.
* The canonical repository gate remains `make verify`; designated Linux/systemd
  evidence is separate and must use the same candidate.

## Guidance

Relevant:

* [Development workflow](../../../docs/development-workflow.md): Gate and
  candidate-evidence authority.
* [Linux deployment contract](../../../docs/technical-design.md): Deployment
  Readiness levels and accepted socket ownership boundary.
* [ADR-0006](../../../docs/adr/0006-non-root-daemon-launcher-privilege-boundary.md):
  launcher and Runtime isolation.

## Trust Boundary Fields

* `admin.socket.peer` — local process reaching the administrator Unix socket.
* `admin.request` — bytes supplied over the administrator socket.
* `doctor.arguments` — administrator-selected command mode and flags.
* `doctor.hostObservation` — local filesystem, account, service and Runtime
  prerequisite observations.
* `readiness.reason` — derived sanitized reason exposed to an administrator.
* `runtime.observation` — optional explicit live Runtime status with no
  credential value disclosure.

