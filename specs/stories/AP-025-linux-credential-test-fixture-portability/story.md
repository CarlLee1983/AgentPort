# Story: AP-025 — Linux Credential Test Fixture Portability

## Goal

Keep the daemon credential security contract covered by a deterministic unit
test on both macOS development hosts and non-root Linux CI runners.

## Context

The credential unit test creates its expected-valid fixture beneath
`os.tmpdir()`. On Linux that is normally `/tmp`, whose root-owned `01777` mode
is intentionally rejected by the production ancestor validator. The same test
passes on macOS because its temporary directory is a protected per-user tree.

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
- push: yes
- deploy: no

## Architecture

- Impact: low
- Boundary: `systemd daemon credential loading`
- Contract: `credential directories and files retain the existing fail-closed ownership, mode, and ancestor validation`
- Owner: `systemd daemon credential loading = AgentPort production daemon boundary`

## Risk

- Level: medium
- Reason: `privilege-boundary`

## Scope

### In Scope

- Move the expected-valid credential fixture beneath a protected writable
  ancestor that satisfies the production contract on non-root Linux.
- Preserve file-mode rejection and add explicit writable-ancestor rejection
  without repairing fixture metadata.

### Out of Scope

- Changing production credential validation or supported deployment paths.
- Changing daemon configuration validation or unrelated temporary fixtures.
- Deployment or GitHub workflow changes.

## Inputs

- The AP-022 systemd credential-loading contract and Linux CI failure on PR #4.
- The existing `readSystemdDaemonCredentials` implementation and unit test.

## Outputs

- A platform-portable credential unit fixture with explicit unsafe-ancestor
  regression coverage.

## Rules

- R1: The production credential reader remains unchanged and fail-closed.
- R2: Tests must exercise real filesystem ownership and modes without mocks or
  permission repair.
- R3: Temporary paths are removed after every test outcome.

## Expected Errors

- A group- or other-writable credential ancestor returns only
  `daemon_credentials_invalid` and its mode remains unchanged.

## Dependencies

- AP-022 / WI-023 is DONE and owns the production credential-loading contract.

## Constraints

- Do not relax ancestor, ownership, symlink, file-mode, or size validation.
- Preserve the unrelated untracked `.scratch/codex-runtime-driver/` directory.

## Trust Boundary Fields

- `credentialsDirectory` — systemd-derived absolute path consumed at daemon startup.
