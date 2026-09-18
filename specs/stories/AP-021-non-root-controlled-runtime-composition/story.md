# Story: AP-021 — Non-root Controlled Runtime Composition

## Goal

Let the S3-B controlled Runtime composition run as a non-root control daemon,
with the privileged launcher as the only root process, so the process that
parses untrusted MCP input no longer holds root (ADR-0006).

## Context

AP-020 fixed the Linux deployment contract. At `13237ab`,
`createControlledRuntimeAdmission()` requires `process.getuid() === 0` and a
`root:runtimeGroup` ingress directory
(`src/bootstrap/create-controlled-runtime-admission.ts:65-93`). The daemon, not
the launcher, binds and listens on each per-execution ingress socket and then
`chown`s it to uid 0 (`src/runtime/worker/ingress.ts:87-116`); only that
`chown` and the explicit uid check need root. The launcher never touches the
ingress endpoint; it passes `{ingress, continuation, policy}` to the worker
through a root-only credential file and systemd `LoadCredential`.

A launcher-owned listening socket would require passing a file descriptor to an
unrelated process, which Node supports only over a parent-child IPC channel
(inferred, not measured). The planned contract therefore splits ownership: the
launcher creates and protects the ingress directory, and the daemon creates the
socket inside it. This amends the ingress row of the AP-020 identity table and
needs a Gate.

Runtime authorization is out of scope here: the grill that produced ADR-0007
missed GATE-020 and AP-007, which require subscription OAuth. ADR-0010
(accepted) keeps subscription OAuth for v1. GATE-053 permits only the
ADR-0010-scoped compatibility for official Claude status output that omits
`apiKeySource` in the clean G1 harness; it does not change the driver
authentication mechanism or permit an API-key path.

## Classification

- Security sensitive: yes
- Baseline conformance: yes
- Task mode: mixed

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
- Boundary: `Linux controlled Runtime composition`
- Contract: `daemon runs non-root and refuses uid 0; launcher creates root:agentport-ingress 0771 ingress directory; daemon-owned 0660 socket in the Runtime group; worker token authentication unchanged`
- Owner: `Linux controlled Runtime composition = Execution Supervisor Linux adapter`

## Risk

- Level: high
- Reason: `privilege-boundary`
- Reason: `runtime-isolation`
- Reason: `linux-evidence-required`

## Scope

### In Scope

- Launcher configuration fields for the ingress directory and ingress group,
  and launcher startup creation and verification of that directory.
- Replacing the daemon uid 0 requirement with a refusal to run as uid 0, and
  verifying the launcher-created ingress directory and its ancestors.
- Creating each ingress socket with mode 0660, owner the daemon uid and group
  the Runtime group.
- Updating the G1 harness, configuration and G4 composition test so the daemon
  runs as a non-root account on the designated Linux target.
- Aligning `src/operations/linux-preflight.ts` with the launcher-owned
  `root:ingressGroup` 0771 ingress contract (GATE-042).
- Running the G4 composition in a child process started as the non-root daemon
  account, with root-only fixture preparation in the test process and a
  GATE-054 dedicated root-owned traverse-only fixture root that leaves core
  data root-only.
- After the Gates resolve: ADR-0006 and the `docs/technical-design.md` identity
  table amended for ingress ownership; ADR-0007 marked superseded by ADR-0010
  in the authorization part, AP-020 R3 wording aligned.

### Out of Scope

- Production daemon entrypoint, `agentport.json` and credential loading, fixed
  port and signals (AP-022).
- Admin socket and Deployment Readiness (AP-023); Caller token hashing and
  `SIGHUP` reload (AP-024).
- Any change to Claude driver authentication or an API key path, except the
  GATE-053 status-schema compatibility recorded in ADR-0010.
- Installer, release packaging or account creation outside the test harness.

## Inputs

- ADR-0006, ADR-0010 (proposed), AP-020 R2 and R9, GATE-020.
- Existing launcher, ingress, composition and G1/G4 harness code and tests.

## Outputs

- Non-root S3-B composition with launcher-created ingress directory.
- Updated unit, contract and Linux G1/G4 tests with Linux evidence.
- Resolved Gates for the ingress ownership amendment and Runtime authorization.

## Rules

- R1: The controlled composition fails closed when `process.getuid() === 0`.
- R2: The launcher creates the ingress directory at startup, not a symlink,
  owner uid 0, group `ingressGroup`, mode exactly 0771, with every ancestor
  root-owned and not group- or other-writable, and refuses to start otherwise.
- R3: The daemon verifies the same properties before accepting dispatch and
  never creates, chmods or chowns the directory.
- R4: Each ingress socket is created with mode 0660, owner the daemon uid and
  group the Runtime group; the Runtime identity can connect but cannot list,
  remove or replace entries in the directory.
- R5: `ingressGroup` differs from `socketGroup` and `runtimeGroup`; the Runtime
  user is not a member of `ingressGroup` or `socketGroup`.
- R6: Worker authentication by ingress token, `LoadCredential` delivery,
  generation fencing and Stop Evidence semantics are unchanged. GATE-053
  permits the clean G1 harness to accept absent `apiKeySource` only with all
  ADR-0010 first-party subscription indicators; API-key and environment OAuth
  sources remain rejected.
- R7: GATE-054 keeps core data `root:root` 0700. G4 fixture ingress and SQLite
  data are placed beneath a separate `root:root` 0711 fixture root; the daemon
  can traverse it, while the Runtime cannot read or write either root.

## Expected Errors

- Daemon started as uid 0: startup fails with a stable non-root requirement
  error and no dispatch.
- Ingress directory missing, symlinked, wrong owner, group or mode: launcher
  refuses to start; daemon refuses dispatch.
- Socket group change fails because the daemon is not in the Runtime group:
  dispatch fails before launch and the claim follows existing failure handling.

## Dependencies

- AP-020 / WI-021 DONE.
- A designated Linux amd64 target for G1 evidence; the target identity is
  still to be named by a human (open question from the AP-021 grill).

## Constraints

- No native addon or new dependency.
- S3-A composition in `create-durable-admission.ts` stays free of Runtime
  imports and process control.
- macOS or synthetic tests do not substitute for Linux evidence.

## Guidance

Relevant:

- [Development workflow](../../../docs/development-workflow.md): runtime
  isolation and security policy changes require a ForgePilot Gate.
- [Domain model](../../../CONTEXT.md): Execution Supervisor owns stop proof;
  Workspace is not a Sandbox.
- [G1/G4 test harness](../../../docs/g1-test-harness.md): reproducible
  administrator setup for the separate GATE-054 fixture root and non-root
  acceptance children.

## Trust Boundary Fields

- `launcher.ingressDirectory` — root-owned launcher configuration.
- `launcher.ingressGroup` — root-owned launcher configuration.
- `ingress.token` — generated by the daemon and delivered to the worker through
  a launcher credential.
- `worker.authenticateMessage` — sent by the Runtime-identity worker to the
  ingress socket.

## Superseded Behavior

- `src/bootstrap/create-controlled-runtime-admission.ts` — `verifyIngressDirectory` requires uid 0 and a `root:runtimeGroup` directory; replaced by non-root refusal of uid 0 and a launcher-owned `root:ingressGroup` 0771 directory.
- `src/runtime/worker/ingress.ts` — `chown(endpoint, 0, groupId)`; replaced by daemon-uid ownership with the Runtime group.
- `src/operations/linux-preflight.ts` — validates the ingress directory as `root:runtimeGroup` checked against the daemon account; replaced by the launcher-owned `root:ingressGroup` 0771 contract (GATE-042).
