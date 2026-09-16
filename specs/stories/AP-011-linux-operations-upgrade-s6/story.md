# Story: AP-011 — Linux Operations, Upgrade and Rollback in S6

## Goal

Give a Linux host administrator a reproducible way to install, diagnose, stop,
upgrade, back up and recover AgentPort without losing accepted work, reopening
uncertain execution, or claiming dispatch readiness before recovery is proven.

## Context

This is the first S6 delivery slice from [Implementation Plan S6](../../../docs/implementation-plan.md)
and [historical issue 22](../../../.scratch/agentport-v0-1/issues/22-linux-operations-upgrade.md).
AP-005 supplies controlled Linux composition; AP-009 and AP-010 supply retention,
physical capacity and storage-incident convergence. None of those Stories
establishes the complete S5/G5 crash, authorization and load exit evidence.
The final real Caller run and release acceptance remain separate S6 slices.

[ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md) prohibits
automatic replay of uncertain work. [ADR-0003](../../../docs/adr/0003-local-transactional-task-store.md)
keeps SQLite as the single durable source. [ADR-0004](../../../docs/adr/0004-linux-execution-macos-development.md)
limits native Runtime execution and deployment to Linux.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: mixed

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: no
* push: no
* deploy: no

## Architecture

* Impact: high
* Boundary: `Linux daemon, root launcher, Runtime identity and protected ingress`
* Contract: `Operator startup and shutdown preserve the existing authorization, generation fencing, Stop Evidence and durable recovery contracts`
* Owner: `Linux daemon, root launcher, Runtime identity and protected ingress = AgentPort Linux operations composition`
* Boundary: `Approved HTTPS ingress and MCP listener`
* Contract: `External transport never supplies Principal identity or bypasses bearer, Host, Origin and bounded-request checks`
* Owner: `Approved HTTPS ingress and MCP listener = AgentPort protocol adapter operations`

## Risk

* Level: high
* Reason: `runtime-isolation`
* Reason: `persistent-data`
* Reason: `network-authentication`

## Scope

### In Scope

* Linux-only protected configuration, service assembly and operator procedures for
  the daemon, launcher, Runtime account, MCP listener and Gate-approved HTTPS ingress.
* Administrator diagnostics that distinguish query availability, dispatch
  eligibility, recovery or stop uncertainty, configuration and schema failure.
* Orderly shutdown that closes new admission and dispatch, preserves queued and
  active Task state, requests trusted stop and closes the listener and store only
  after reconciliation or explicit unknown state is recorded.
* Offline upgrade, SQLite/WAL-consistent backup, schema incompatibility refusal,
  restore and rollback drills on a designated Linux test target.
* Sanitized, reproducible installation and operations documentation with fixed
  executable and account prerequisites, credential rotation and known limits.

### Out of Scope

* Real AI Caller full-flow validation and final release package/G6 declaration.
* Publishing, production deployment, Git push, actual PR creation or vendor login.
* New MCP tools, changes to Task/Context semantics, native macOS execution,
  remote privilege escalation, an arbitrary file endpoint or multi-tenant hosting.
* Treating AP-010 approval alone as S5/G5 completion.

## Inputs

* The approved AgentPort requirements, Implementation Plan S6 and historical
  issue 22; AP-005, AP-009 and AP-010 current ForgePilot Work Item evidence.
* Administrator-controlled Linux configuration, executable, account and
  credential locations; no Caller may set host paths or Runtime policy.
* A designated Linux cgroup-v2 test target supporting protected systemd
  credentials and the exact implementation candidate.

## Outputs

* Reproducible Linux operations configuration, diagnostics and runbook.
* Candidate-bound startup, shutdown, migration, backup, restore and rollback
  evidence with sanitized command logs and actual durable/recovery observations.
* Explicit residual risks and Gate decisions for privilege and network trust.

## Rules

* R1: S6 operational acceptance depends on complete, current S5/G5 crash,
  authorization and load evidence. Preparatory work must never project G5 or G6
  PASS from completed AP-009/AP-010 Work Items.
* R2: Daemon, launcher, Runtime and storage use the Gate-approved privilege
  topology, with Runtime excluded from control, ledger, database and credential
  authority. Any changed topology or protected-ingress policy needs a ForgePilot
  Gate before implementation; test harness service files are not a production grant.
* R3: External MCP traffic enters only through the Gate-approved HTTPS
  boundary. Network-derived headers cannot become Principal identity, and
  bearer, Host, Origin, request-size and audit contracts remain enforced.
* R4: Queryable recovery is distinct from dispatch eligibility. Uncertain Stop
  Evidence, held claims, storage incident, invalid configuration or schema
  mismatch cannot be reported as dispatch ready.
* R5: An upgrade stops new work, reconciles active Executions, makes a
  SQLite/WAL-consistent backup before the new binary opens the database and
  refuses unsupported schema without replacing the original data.
* R6: Restore of an older backup enters paused/recovery state; missing newer
  external side-effect records are stated explicitly and no Task, answer or
  Runtime Session is replayed automatically. Older binaries must not open a
  newer schema.
* R7: Examples and logs contain only synthetic or sanitized values. Raw bearer,
  vendor credential, private prompt, answer, Runtime stderr and host paths are
  never placed in versioned examples or acceptance evidence.

## Expected Errors

* Invalid protected configuration, account, launcher or credential placement
  prevents dispatch and gives an administrator a sanitized diagnostic.
* Unsupported schema prevents opening a dispatch-capable composition while
  preserving original database, WAL and control evidence.
* Storage or Stop Evidence uncertainty retains existing claims and exposes
  queryable recovery or an explicit unavailable state, never false readiness.

## Dependencies

* Complete S5/G5 exit evidence is required before this Story can claim its S6
  operational acceptance. AP-010 explicitly excluded the G5 matrix and load
  target; ForgePilot must record any approved sequencing exception.
* Existing AP-005 Linux composition and AP-009/AP-010 durable, retention and
  storage safety contracts remain unchanged.

## Constraints

* Run drills only on a designated test target; no actual production deployment,
  vendor login, commit, push or release is authorized by this Story.
* Preserve database, WAL, control reserve, Supervisor ledger and credential
  isolation through backup, restore and rollback. No in-place downgrade or
  empty-database replacement is permitted.
* `make verify` is the canonical repository gate; Linux operational and
  environment Evidence must be bound to the same candidate separately.

## Guidance

Relevant:

* [Engineering entry](../../../guidance/ENTRY.md): keep one source of truth and
  test each operational behavior at the lowest useful boundary.
* [Development workflow](../../../docs/development-workflow.md): open Gates for
  undefined security, deployment and public API decisions.

## Trust Boundary Fields

* `administrator.configuration` — operator-supplied executable, Workspace,
  account, protected ingress, database, launcher and Runtime policy paths.
* `network.headers` — network-derived Host, Origin and forwarding metadata at
  the approved HTTPS ingress boundary.
* `bearer` — preconfigured Caller credential presented through the MCP listener.
* `runtime.credential` — protected vendor authentication material made available
  only to the designated Runtime worker.
* `backup.path` — operator-chosen offline backup or restore destination.
* `diagnostic.detail` — derived configuration, schema, storage and Supervisor
  health text exposed only to administrators or sanitized Evidence.
