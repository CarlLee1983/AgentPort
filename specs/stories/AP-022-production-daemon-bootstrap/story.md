# Story: AP-022 — Production Daemon Bootstrap and Controlled Service Lifecycle

## Goal

Provide a production Node entrypoint that boots the existing non-root controlled
Runtime composition from protected, versioned configuration and systemd
credentials, serves MCP on a fixed loopback port, and shuts the service down
through one bounded, idempotent lifecycle without weakening recovery or Stop
Evidence semantics.

## Context

AP-020 fixed the Linux deployment contract and AP-021 supplied the non-root
controlled Runtime composition. The repository still has no production daemon
entrypoint: tests compose the service directly, and the reusable loopback server
binds an ephemeral port. AP-022 connects those existing boundaries without
claiming that AP-023 Deployment Readiness or AP-024 Caller management is
complete.

ForgePilot records AP-021 as WI-022 DONE with PASS snapshot candidate
`604f24bc6aab`, Human Review approved and no open Gate. ADR-0010 supersedes the
authorization portion of ADR-0007: production Claude authorization remains
subscription OAuth in the protected Runtime home; this Story adds no API-key or
environment-token path.

## Classification

- Security sensitive: yes
- Baseline conformance: yes
- Task mode: execution

## Authority

- plan: yes
- modify: yes
- add_dependency: no
- migration: no
- commit: no
- push: no
- deploy: no

## Architecture

- Impact: high
- Boundary: `production daemon bootstrap and controlled service lifecycle`
- Contract: `a non-root daemon validates protected configuration and systemd credentials before composition startup, holds one fixed loopback listener, fences admission and dispatch during startup and shutdown, and preserves existing Supervisor Stop Evidence and restart-reconciliation semantics`
- Owner: `production daemon bootstrap and controlled service lifecycle = AgentPort Linux control daemon`

## Risk

- Level: high
- Reason: `privilege-boundary`
- Reason: `secret-lifecycle`
- Reason: `concurrency`
- Reason: `error-projection`
- Reason: `linux-evidence-required`

## Concurrency

- Contended resource: `daemon lifecycle, SQLite exclusive lock, loopback listener, admission and dispatch authority, active Execution References, shutdown signal and Supervisor stop convergence`
- Linearization point: `the lifecycle fence closes before a startup abort or shutdown can admit, claim or launch work; repeated stop requests share the first shutdown promise`
- Conflict outcome: `an in-flight accepted commit keeps its durable meaning, while work crossing the closed fence creates no new claim or launch; unknown stop retains recovery state and claim`
- Evidence AC: `AC-08`

## Error Projection

- Source failure: `configuration or credential validation, root execution, database lock, loopback bind, startup reconciliation, signal-driven shutdown, Supervisor pending or indeterminate stop and shutdown deadline expiry`
- Public projection: `stable daemon reason code on sanitized stderr and non-zero exit, or existing authorized MCP error without a Task record when dispatch eligibility is unavailable`
- Detail policy: `omit secrets, raw causes, protected paths, configuration payloads, bearer values, Execution References, Supervisor internals and Runtime environment values`
- Evidence AC: `AC-11`

## Scope

### In Scope

- A production daemon CLI entrypoint plus separate configuration/credential,
  composition and lifecycle modules that compile to directly executable Node
  JavaScript and do not start on import.
- Strict `agentport.json` schema version 1 for the MCP port, SQLite/storage
  options, launcher/ingress connection and Agent/Principal mapping needed by
  this Story, with protected-file and absolute-path validation.
- `cursorSecret` and `continuationEncryptionKey` loading from
  `CREDENTIALS_DIRECTORY`, reusing existing codec/storage constraints.
- A configurable fixed `127.0.0.1` MCP listener, default port 3333, that
  retains the existing Bearer, Host, Origin, protocol, body-limit and sanitized
  audit behavior and refuses port 0.
- Explicit starting, running, stopping and stopped service lifecycle with
  bounded, idempotent SIGTERM/SIGINT shutdown and startup-failure cleanup.
- Reuse of `AgentExecutionService`, SQLite Store,
  `ControlledRuntimeDispatcher`, `LinuxExecutionSupervisor`, Registry revision
  fencing, restart reconciliation and the SQLite exclusive daemon lock.
- Production systemd unit example and operator documentation matching the
  implemented command, credentials, permissions, shutdown deadline and known
  AP-023/AP-024 dependencies.
- Deterministic platform-neutral tests, real child-process/signal tests and
  designated Linux/systemd evidence for the same candidate.

### Out of Scope

- Installer, account creation, apt changes, secret generation or rotation,
  release packaging, service installation/enabling, remote deployment or TLS.
- AP-023 admin socket and full Deployment Readiness observation.
- AP-024 caller add/list/revoke, token hashing, production positive Caller
  provisioning or SIGHUP Registry hot reload.
- API-key or environment-injected OAuth authorization, moving subscription
  credentials, a new Task lifecycle, a new scheduler or automatic full-database
  queue polling.
- Treating service liveness, a closed socket, worker exit or test dependency
  injection as execution-ready or trusted Stop Evidence.

## Inputs

- AP-020 rules R1–R13 and accepted ADR-0006, ADR-0010.
- AP-021 / WI-022 accepted non-root composition, ingress ownership and Linux
  evidence.
- Existing loopback MCP server, Registry, `AgentExecutionService`, SQLite
  durable store, dispatcher, launcher client and Linux Supervisor.
- `docs/technical-design.md`, `docs/durable-admission-operations.md` and
  `docs/linux-operations-preflight.md`.

## Outputs

- Compiled production daemon entrypoint and protected configuration/credential
  loaders.
- Controlled daemon lifecycle and fixed loopback listener using one shared
  composition.
- Focused unit/integration/process tests and Linux/systemd evidence hooks.
- Versioned `agentport.json` example, systemd service example and production
  bootstrap operations note that preserves the existing deployment-guide
  warning.

## Rules

- R1: The daemon refuses uid 0 and never creates accounts, fixes ownership or
  mode, reads root-only `launcher.json`, or changes the AP-021 ingress directory.
- R2: The CLI requires an explicit absolute `agentport.json` path. Schema
  version, keys, value types, absolute storage/launcher/ingress paths, file
  owner and mode are validated before composition initialization; unknown or
  unsafe input fails closed without logging payloads or raw causes.
- R3: Production configuration never serializes raw Caller bearer tokens.
  Until AP-024 provides a verifier, the production CLI installs no test token
  or anonymous Principal; tests may inject an isolated verifier only through a
  non-CLI dependency seam.
- R4: `cursorSecret` and `continuationEncryptionKey` are read only from files
  beneath the systemd-provided `CREDENTIALS_DIRECTORY`, reject missing,
  unreadable, empty, malformed or wrong-length values, and are never generated,
  rotated, copied to Runtime, persisted or emitted.
- R5: MCP listens only on `127.0.0.1`, defaults to port 3333, accepts an
  explicitly configured non-zero port, and never falls back to another address
  or port after `EADDRINUSE`.
- R6: Configuration, credential and protected-path validation finish before
  opening SQLite. The exclusive durable-store lock is acquired before restart
  reconciliation, and the listener is bound before reconciliation may mutate
  durable startup state, so a second daemon that cannot own the endpoint cannot
  rewrite the first daemon's active state.
- R7: Startup reconciliation completes before dispatch can open. A stop request
  during starting permanently closes the lifecycle fence so later awaits cannot
  reopen admission, dispatch or the listener.
- R8: SIGTERM and SIGINT share one idempotent shutdown promise. Shutdown closes
  new admission, dispatch preparation, claim and launch before draining
  in-flight request commits and converging active Executions through the
  existing service/Supervisor contracts.
- R9: Graceful shutdown preserves accepted receipts and committed Task facts,
  pauses queued work under existing semantics, and publishes no terminal state
  or claim release without trusted Stop Evidence. Pending or indeterminate stop
  remains recoverable/unknown.
- R10: Shutdown has a configured, documented upper bound aligned with
  `TimeoutStopSec`; after the application deadline it reports a sanitized
  failure and leaves durable recovery evidence rather than claiming a safe stop.
- R11: Listener, audit drain and storage close only after the required stop and
  persistence phase. Every partial-start failure cleans this process's listener,
  worker, timer and storage resources without an unhandled rejection.
- R12: Restart reuses the existing `initializeAfterRestart` contract: queued
  work stays paused, unknown Executions stay quarantined, and no Task, accepted
  answer or Runtime command is replayed automatically.
- R13: Zero Agents is a valid service skeleton. Without AP-023/AP-024 readiness
  and Caller provisioning, production submission stays closed, creates no Task
  and never invokes the launcher; test-only positive authorization cannot be
  enabled through argv or environment.
- R14: The systemd example runs as `agentport-daemon`, declares only the
  launcher, ingress and Runtime supplementary groups required by AP-021, uses
  `LoadCredential`, restrictive `UMask`, correct launcher ordering and a bounded
  `TimeoutStopSec`, but is not installed or enabled by this Story.

## Expected Errors

- Invalid CLI arguments, root execution, unsafe configuration metadata,
  unsupported schema or invalid credential exit non-zero with one stable,
  sanitized reason code and no composition resources left open.
- SQLite lock or port ownership conflict rejects the second daemon without
  changing port, mutating the active daemon's restart state or leaking raw
  storage/listener details.
- Shutdown timeout or indeterminate Supervisor result exits non-zero after
  bounded cleanup and preserves unknown recovery state and Workspace claim.
- Missing AP-023/AP-024 execution-readiness inputs reject submission without a
  Task record, Workspace claim or launcher request.

## Dependencies

- AP-020 / WI-021 DONE.
- AP-021 / WI-022 DONE with candidate `604f24bc6aab`, current Human Review and
  no open Gate.
- AP-023 and AP-024 remain follow-up dependencies for production execution-ready
  admission and managed Caller credentials, not prerequisites for the
  service-ready skeleton in this Story.
- A user-authorized designated Ubuntu 24.04 amd64 systemd/cgroup-v2 target is
  required for Linux acceptance evidence; lack of that evidence blocks review,
  not local implementation.

## Constraints

- No new runtime dependency, schema migration, API-key path, public non-loopback
  listener or second lifecycle/store/scheduler.
- Do not depend on PraxisBound, ForgePilot, Vitest, dist fixtures or test scripts
  at deployed runtime.
- Do not commit, push, merge, release, deploy, install services, create system
  accounts or generate production credentials.
- Keep `docs/deployment-guide.md` and its generated HTML warning until their
  separately authorized replacement Story is completed.

## Guidance

Relevant:

- [Development workflow](../../../docs/development-workflow.md): current Work
  Item, candidate evidence, Gate and Human Review authority.
- [Domain model](../../../CONTEXT.md): service lifecycle is not Task lifecycle;
  Supervisor owns Stop Evidence.
- [Durable admission operations](../../../docs/durable-admission-operations.md):
  stable secrets, exclusive SQLite lock, startup reconciliation and data-preserving
  shutdown/recovery.
- [Engineering principles](../../../guidance/PRINCIPLES.md): small coherent
  change, explicit dependencies and behavior-oriented tests.

## Trust Boundary Fields

- `cli.configurationPath` — administrator-provided daemon argument.
- `configuration.fileMetadata` — filesystem owner, mode, type and protected
  ancestor metadata.
- `configuration.json` — administrator-authored versioned daemon configuration.
- `configuration.mcp.port` — administrator-selected loopback TCP port.
- `configuration.storage` — administrator-selected durable SQLite and capacity
  options.
- `configuration.launcher` — administrator-selected launcher socket and ingress
  binding.
- `configuration.agents` — administrator-selected Agent, Workspace, Runtime and
  policy mappings.
- `CREDENTIALS_DIRECTORY` — systemd-provided non-secret credential directory
  path.
- `credential.cursorSecret` — protected stable cursor signing material.
- `credential.continuationEncryptionKey` — protected stable continuation key.
- `signal` — SIGTERM or SIGINT delivered by the service manager/operator.
- `listener.error` — operating-system bind/listen failure details.
- `shutdown.error` — internal stop, drain, persistence or deadline failure.
- `error.reason` — stable sanitized CLI reason written to stderr.

## Superseded Behavior

- `src/mcp/loopback-server.ts` — production bootstrap no longer relies on the
  test-oriented unconditional ephemeral port, while test callers may continue
  requesting dynamic ports explicitly.
- `tests/fixtures/g4-daemon-child.ts` — a test fixture is no longer the only
  executable composition path; the production CLI cannot enable fixture auth or
  dispatch switches.
- `src/supervisor/linux/launcher-main.ts` signal pattern — the daemon uses
  bounded idempotent cleanup and does not call `process.exit(0)` immediately on
  receipt of a signal.
