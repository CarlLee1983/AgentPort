# AP-003 platform-neutral preparation evidence

Observed on 2026-09-12 (Asia/Taipei) on the macOS development host. This is an
uncommitted working-tree candidate; the Story prohibits a commit without new
user authorization. This immutable evidence does not project mutable ForgePilot
lifecycle, Gate, verification, or Human Review state.

`GATE-012` selected the safe preparation scope. This candidate proves only
platform-neutral prepared/recovering/quarantine persistence, bounded read-only
MCP projection, and failure/no-dispatch contracts. Candidate outcome
persistence, terminal commit, claim release, verified Stop Evidence, Linux
cgroup containment, descendant cleanup, real Claude behavior, G1, G3, and
production readiness are explicitly outside this evidence and remain S3 work
after G1.

| AC    | Status                       | Method                                            | Observation and limit                                                                                                                                                                                  |
| ----- | ---------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-01 | local pass                   | lifecycle projection acceptance test              | Authorized MCP reads one bounded prepared/recovering snapshot. It exposes no generation, daemon epoch, launch profile, or Workspace identity; candidate outcome is always `null`.                      |
| AC-02 | local pass                   | real-SQLite lifecycle transaction test            | Concurrent claims yield exactly one Workspace claim. A cancel that loses to preparation receives `operation_conflict`; the claim remains held and no terminal transition or release occurs.            |
| AC-03 | local pass                   | reopen/recovery integration test                  | Restart changes incomplete execution to `recovering` and claim to `quarantined`; the test has no Runtime, Adapter, or replay path.                                                                     |
| AC-04 | local pass                   | supervisor failure integration and contract tests | Stale references, adapter failures, unknown reconciliation, scripted stopped payloads, and structurally forged evidence resolve to `indeterminate`; they do not release the prepared claim.            |
| AC-05 | local pass                   | lifecycle authorization acceptance test           | Strict MCP schema rejects caller-selected execution identity, generation, profile, Workspace identity, and Stop Evidence; cross-scope reads return `not_found`.                                        |
| AC-06 | local pass                   | execution-control no-dispatch contract            | Production bootstrap/MCP compositions cannot reach the Supervisor seam, Runtime, dispatcher, launcher, Claude SDK, or process creation. The only claim-preparation calls are test-fixture composition. |
| AC-07 | local pass                   | Supervisor contract test                          | The three-method model is idempotent for same Reference, closes a revoked generation, and treats every fixture stop payload as pending/indeterminate rather than Stop Evidence.                        |
| AC-08 | requires Human Review        | final architecture review                         | AgentExecutionService owns authorization and lifecycle projection; MCP translates protocol and storage performs atomic persistence.                                                                    |
| AC-09 | not fixed-toolchain evidence | `make verify`                                     | The full platform-neutral suite passes, but canonical `make verify` stops at the toolchain gate because this host exposes Node `22.17.1`, not required `24.21.0`.                                      |
| AC-10 | local evidence               | this document and GATE-012 decision               | All Linux/runtime limits are explicit; nothing here is represented as G1, G3, or production evidence.                                                                                                  |

## Command results

| Command                                                                                                             | Environment                   | Result                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `/bin/sh scripts/forgeflow/story-check --ready specs/stories/AP-003-platform-neutral-execution-control-preparation` | current worktree              | pass                                                                                             |
| `pnpm run test:platform-neutral`                                                                                    | Node `22.17.1`, pnpm `12.4.1` | pass — 22 files / 120 tests; this is not fixed-toolchain AC-09 evidence                          |
| `make verify`                                                                                                       | Node `22.17.1`, pnpm `12.4.1` | fail as required — exact Node `24.21.0` toolchain gate rejects the host before repository checks |

No runtime query, subprocess, container, cgroup, process group, Supervisor
Adapter, Linux target, vendor credential, or deployment was used.
