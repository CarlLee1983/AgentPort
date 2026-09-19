# Story: AP-024 — Managed Projects and Caller Admission

## Goal

Let a Hub Station administrator register multiple coding projects as explicit
Agent bindings, then let an authorized downstream MCP Caller select one Agent
per Task and drive development in that project's protected Workspace.

## Context

AP-022 and AP-023 provide the non-root production daemon and its bounded
Deployment Readiness observation, but the production composition currently has
no Caller credential verifier and therefore cannot accept a real downstream
Caller. The existing Registry already models an Agent as a stable identity
bound to a Workspace, Runtime driver/version, launch profile and policy. This
Story makes that model administrable and enables positive production admission
without allowing an MCP Caller to select host paths or Runtime controls.

The Hub Station is the host administrator surface. A downstream project is
represented by one Agent record; it is not a new Runtime identity or process.
The MCP Caller remains distinct from the Agent and must present a provisioned
Bearer credential for an authorized Principal.

## Classification

- Security sensitive: yes
- Baseline conformance: no
- Task mode: execution

## Authority

- plan: yes
- modify: yes
- add_dependency: no
- migration: no
- commit: yes
- push: no
- deploy: no

## Architecture

- Impact: high
- Boundary: `Hub Station Agent Registry and Caller admission`
- Contract: `MCP callers select only an administrator-defined Agent ID; paths, Runtime identity and launch policy remain protected configuration`
- Owner: `Hub Station Agent Registry and Caller admission = AgentPort host operations boundary`

## Risk

- Level: high
- Reason: `privilege-boundary`
- Reason: `secret-lifecycle`
- Reason: `public-api`
- Reason: `concurrency`

## Concurrency

- Contended resource: `protected Agent/Principal/Caller registry and daemon revision`
- Linearization point: `validated atomic configuration replacement followed by Registry.replace revision installation`
- Conflict outcome: `stale or invalid replacement is rejected and the previous revision remains active; uncommitted mutations observe the revision fence`
- Evidence AC: `AC-06`

## Scope

### In Scope

- Administrator CLI operations to add, list and remove configured projects
  (Agents), without accepting arbitrary Caller-supplied paths.
- Administrator CLI operations to add, list and revoke Caller credentials;
  generated bearer tokens are shown once and only a hash is persisted.
- Atomic protected configuration updates and daemon `SIGHUP` reload using the
  existing Registry revision fence.
- Positive production MCP authentication and explicit `agentId` selection for
  Task admission, observation, clarification and cancellation.
- Sanitized readiness projection for configured Caller and Agent capability.

### Out of Scope

- Public Internet exposure, native TLS termination, OAuth discovery,
  multi-tenant isolation or arbitrary MCP Client compatibility.
- Automatic Runtime credential setup, Claude subscription login or a new
  Runtime driver.
- GitHub release publication, binary packaging, attestation or clean-host
  installation; those require the follow-on release Story.
- Changing Task, Execution, Workspace-claim or SQLite lifecycle semantics.

## Inputs

- Accepted AP-020 rules R1–R13, especially R5 (Caller management), R6
  (versioned protected configuration), R7 (revision-fenced reload), R8
  (loopback MCP endpoint), R10–R12 (readiness and Agent binding).
- AP-022 production daemon composition and AP-023 administrator observation.
- `CONTEXT.md` definitions for Caller, Logical Agent, Runtime, Workspace and
  Deployment Readiness.

## Outputs

- A production-safe managed Agent/Caller configuration contract and CLI.
- A downstream MCP usage contract that always names the target `agentId`.
- Tests proving authorization, secrecy, reload/revocation and no caller path
  or Runtime override.

## Rules

- R1: Each configured project has a unique stable `agentId`, administrator-
  controlled `workspacePath`, `runtimeDriver`, `runtimeVersion`,
  `launchProfileId`, configuration revision and bounded execution policy.
- R2: `agentport agent add|list|remove` is an administrator-only operation;
  add validates or creates only an explicitly approved Workspace layout and
  never recursively changes ownership or modes of an existing path.
- R3: `agentport caller add|list|revoke` manages a Principal's Caller
  credentials. Add generates high-entropy material, prints the raw token once,
  and persists only a versioned hash; list never prints a token or hash and
  revoke makes new requests fail authentication after a successful reload.
- R4: Protected configuration replacement is atomic. Invalid metadata, unknown
  Agent/Principal references or stale revisions leave the active revision
  untouched. `SIGHUP` serializes replacements through the Registry fence.
- R5: A Caller may list only Agents allowed by its Principal and every Task
  mutation/query is authorized against the current Principal and Agent binding.
  A request must name `agentId`; the Caller cannot supply workspace paths,
  launch profiles, Runtime executables, credentials or execution references.
- R6: A valid `agentport_list_agents` → `agentport_submit_task` flow persists
  the selected Agent binding before dispatch. The same Agent selection remains
  visible through get/list/events/reply/resume/cancel operations.
- R7: Caller revocation affects new authentication immediately after the
  validated revision becomes active; already committed Tasks are not silently
  deleted or reassigned. A mutation that loses the Registry revision fence is
  rejected without a partial commit.
- R8: The production MCP endpoint remains loopback-only. Downstream access is
  documented as same-host or an administrator-controlled SSH tunnel until a
  separate public transport Story is approved.

## Expected Errors

- Missing, revoked or invalid Bearer credentials return HTTP 401 without
  revealing whether a Principal or Agent exists.
- An Agent outside the Principal's allowlist returns the existing sanitized
  access/not-found projection and creates no Task or launcher request.
- Missing or invalid `agentId`, arbitrary path/profile fields, malformed
  credentials or unsafe protected configuration return stable bounded errors.
- Reload failure preserves the prior active Registry and reports only a
  sanitized administrator error.

## Dependencies

- AP-022 / WI-023 and AP-023 / WI-024 are DONE and provide the daemon and
  administrator observation seams.
- AP-020 R5/R6/R7/R8/R10/R11/R12 remain the governing deployment contract.
- A later release Story must package this implementation before publication;
  this Story does not claim a downloadable release artifact.

## Constraints

- Do not add a live mutation method to the AP-023 read-only administrator
  socket; the privileged CLI and protected configuration remain the management
  seam.
- Do not store raw Caller tokens in configuration, SQLite, logs, audit records,
  argv, environment or Runtime IPC.
- Preserve the non-root daemon, root-only launcher, low-privilege Runtime and
  existing revision/Workspace fencing boundaries.
- Run focused tests, `make verify`, and current-candidate ForgePilot evidence
  before review; do not push or deploy.

## Guidance

Relevant:

- [Linux deployment contract](../../../docs/technical-design.md)
- [AP-020 Story](../AP-020-linux-deployment-contract/story.md)
- [AP-023 Story](../AP-023-deployment-readiness-admin-observation/story.md)
- [Development workflow](../../../docs/development-workflow.md)

## Trust Boundary Fields

- `caller.bearerToken` — raw credential presented at the MCP HTTP boundary;
  authentication input only, never persisted or projected.
- `caller.tokenHash` — administrator-generated verifier material persisted in
  protected configuration.
- `agent.agentId` — downstream-selected logical Agent identifier.
- `agent.workspacePath` — administrator-only protected project binding.
- `agent.launchProfileId` — administrator-only Runtime launch binding.
- `registry.revision` — daemon-owned authorization linearization marker.
- `reload.signal` — local administrator-triggered configuration replacement.
