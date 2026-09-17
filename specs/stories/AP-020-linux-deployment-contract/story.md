# Story: AP-020 — Linux Deployment Contract

## Goal

Fix the deployment contract that the one-command Linux installer, the
production daemon entrypoint and the `agentport` CLI will share, so later
execution Stories implement one agreed identity, secret, configuration and
readiness model instead of relaxing security to make installation succeed.

## Context

The planning draft `ALL_ISSUES.md` (DEPLOY-01 … DEPLOY-08, not GitHub issues)
proposes a prebuilt Linux release, a rerunnable installer and a unified CLI.
A grill session on 2026-09-17 resolved the boundary decisions for DEPLOY-01
and the DEPLOY-03 trust chain; they are recorded as proposed ADR-0006 to
ADR-0009, and ADR-0003 was accepted because installation ships its storage
design to user hosts.

Facts established against the code at `13237ab`:

* `createControlledRuntimeAdmission()` requires uid 0 and a
  `root:runtimeGroup` ingress directory; `docs/deployment-guide.md` claims a
  non-root daemon and is now marked unusable.
* No production daemon entrypoint exists; `loopback-server.ts` always binds
  `listen(0, "127.0.0.1")`, and Registry has no file loader.
* Daemon-to-launcher authentication is socket group permission only.
* Nothing generates or stores `cursorSecret` or `continuationEncryptionKey`.
* Claude Runtime Session resume depends on Claude session files under the
  single launcher-configured runtime home.
* `Registry.replace()` already supports revision-fenced hot replacement.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: architecture

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
* Boundary: `AgentPort Linux deployment`
* Contract: `non-root daemon with the privileged launcher as the only root boundary, API-key-only Runtime authorization, digest-pinned bootstrap and four-level Deployment Readiness gate every later deployment Story`
* Owner: `AgentPort Linux deployment = host operations boundary`

## Risk

* Level: high
* Reason: `privilege-boundary`
* Reason: `secret-lifecycle`
* Reason: `supply-chain-trust`
* Reason: `third-party-license-terms`

## Scope

### In Scope

* Human Gate resolution of ADR-0006 to ADR-0009 and consistent wording in
  `docs/technical-design.md`.
* The contract rules R1–R13 below, written so DEPLOY-02 to DEPLOY-08 Stories
  can cite them.

### Out of Scope

* Product code, installer, release workflow, CLI or daemon entrypoint.
* Per-Agent Runtime identity, shared-host support, other distributions, arm64,
  Bedrock/Vertex, remote access, Docker or maintenance/drain semantics.
* Upgrade, backup and restore procedures beyond naming what must be preserved.

## Inputs

* `ALL_ISSUES.md` DEPLOY-01 and DEPLOY-03 drafts.
* ADR-0002, ADR-0003, ADR-0004, `docs/durable-admission-operations.md` and
  `docs/linux-operations-preflight.md`.
* Anthropic Claude Code setup, authentication and legal-and-compliance pages
  checked 2026-09-17.

## Outputs

* Human-resolved ForgePilot Gate for the four proposed ADRs.
* Updated `docs/technical-design.md` deployment section matching R1–R12.
* Follow-on Story boundaries for DEPLOY-02 to DEPLOY-08.

## Rules

* R1: Supported platform is Ubuntu 24.04 LTS / amd64 / systemd / cgroup v2 on
  a dedicated single-operator host; everything else is refused (ADR-0009).
* R2: The daemon runs as non-root `agentport-daemon`; the launcher is the only
  root process and creates ingress directories; the launcher socket group
  contains only the daemon account (ADR-0006).
* R3: Claude Runtime authorization is `ANTHROPIC_API_KEY` only, delivered via
  `LoadCredential`; Claude Code is installed from the official apt repository
  at a pinned, held version recorded in the release manifest (ADR-0007).
* R4: The installer generates `cursorSecret` and `continuationEncryptionKey`
  exactly once under `/etc/agentport/credentials/` (0700 root) and never
  rotates them in place; secrets never appear in argv, environment files,
  SQLite or console output.
* R5: Callers are managed with `agentport caller add|list|revoke`; the host
  stores only token hashes and shows a token once at creation.
* R6: Configuration is two versioned files: root-owned
  `/etc/agentport/launcher.json` and daemon-readable
  `/etc/agentport/agentport.json`, each with `schemaVersion`.
* R7: Registry-class changes apply by validated candidate plus `SIGHUP` and
  `Registry.replace()`; launcher-class changes require no active Execution.
* R8: The MCP endpoint listens on loopback port 3333 by default, configurable;
  a bound port fails startup with a reason code and never falls back.
* R9: Host layout: `/opt/agentport/releases/<version>` with `current` symlink,
  `/etc/agentport`, `/var/lib/agentport/{daemon,launcher,runtime-home}`,
  `/run/agentport`, `/var/agentport/workspaces`. runtime-home is preserved
  data required for Runtime Session resume, included in backup and kept by
  uninstall.
* R10: Deployment Readiness levels are installed, service-ready,
  execution-ready and recovery-blocked, each with reason code and observation
  time; unobserved or stale means not ready. The daemon reports it on a
  read-only admin Unix socket; `doctor` performs offline checks when the
  daemon is down. Default checks make no paid Runtime call and report the API
  key as configured-unverified; `doctor --live` is an explicit paid check.
* R11: Task submission when not execution-ready is rejected with a stable
  code and creates no Task; with zero Agents the daemon is service-ready and
  lists an empty Agent set.
* R12: `agent add` either creates a Runtime-owned Workspace under
  `/var/agentport/workspaces` or validates an existing path and prints a
  suggested fix; it never performs recursive ownership or mode changes.
* R13: The release publishes a per-version `install.sh` embedding the archive
  SHA-256 and a GitHub artifact attestation; documentation states the digest
  proves content consistency, not origin (ADR-0008).

## Expected Errors

* Unresolved Gate blocks every DEPLOY-02 to DEPLOY-08 Story that depends on
  R1–R13.
* If implementation shows the launcher cannot create ingress for a non-root
  daemon without weakening the Execution Supervisor boundary, stop and open a
  new Gate rather than restore a root daemon silently.

## Dependencies

* ADR-0003 accepted; ADR-0004 accepted.
* Anthropic terms as checked on 2026-09-17; a change in terms reopens ADR-0007.

## Constraints

* Do not mark ADR-0006 to ADR-0009 accepted without human Gate resolution.
* No product behavior, public tool, schema, Task lifecycle or storage change.
* Run the Story contract check and `make verify` on the documentation
  candidate.

## Guidance

Relevant:

* [Development workflow](../../../docs/development-workflow.md): security,
  permission and platform contract changes require a ForgePilot Gate.
* [Domain model](../../../CONTEXT.md): Deployment Readiness is an operational
  judgment, not Task lifecycle; Workspace is not a Sandbox.

## Trust Boundary Fields

* `caller.bearerToken` — presented by a Caller at the MCP HTTP boundary.
* `runtime.anthropicApiKey` — entered by the host operator through `agentport setup`.
* `agent.workspacePath` — entered by the host operator through `agent add`.
* `release.archive` — downloaded by the bootstrap script from GitHub Releases.
* `readiness.reason` — derived diagnostic exposed on the admin socket and CLI.
