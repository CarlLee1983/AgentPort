# AP-004 G1-L Linux execution-control evidence

Observed on 2026-09-13 (Asia/Taipei) on the designated `agentport-g1` OrbStack
Linux target and the macOS development host. The implementation candidate was
the uncommitted working-tree image deployed immutably as `wi005-15`; the local
and target source hash manifests matched before execution. This document was
added after the target run and changes no runtime source, configuration, test,
or environment. ForgePilot remains the only authority for current lifecycle,
Gate, verification, and Human Review state.

GATE-021 split the earlier composite G1 into AP-004 G1-L and the future AP-007
G1-C. This evidence proves only Linux containment, generation fencing, Stop
Evidence, isolated worker IPC, and no-production-dispatch. Real Claude login,
SDK execution, AskUserQuestion, cancellation, and Session capability were not
run and are not represented as PASS. They remain AP-007 G1-C work; S3-B must
not treat this evidence as G1-C or proceed without accepted G1-C evidence.

## Candidate and environment

| Field                  | Observed value                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Target candidate       | `/opt/agentport-g1/candidates/wi005-15`; current symlink resolved to this immutable directory                       |
| Target OS              | Ubuntu 24.04.5 LTS, `aarch64`                                                                                       |
| Kernel                 | `Linux 7.0.5-orbstack-00330-ge3df4e19b0a0-dirty`                                                                    |
| Control group          | `cgroup2fs`; `/sys/fs/cgroup/cgroup.controllers` present                                                            |
| Toolchain              | Node `24.21.0`; pnpm `12.4.1`                                                                                       |
| Runtime account        | `agentport-runtime`, uid `997`, gid `989`, shell `/usr/sbin/nologin`                                                |
| Runtime home           | `/var/lib/agentport-runtime`, mode `0700`, owned by the Runtime account                                             |
| Workspace              | `/srv/agentport/workspaces/g1`, mode `0700`, owned by the Runtime account                                           |
| Core data              | `/var/lib/agentport-g1/core/core.db`, mode `0600`, root-owned                                                       |
| Supervisor ledger      | `/var/lib/agentport-g1/ledger`, mode `0700`, root-owned                                                             |
| Launcher configuration | `/etc/agentport-g1/launcher.json`, mode `0600`, root-owned                                                          |
| Launcher boundary      | `agentport-g1-launcher.service`; socket `/run/agentport-g1/launcher.sock`, mode `0660`, `root:agentport-supervisor` |
| Rollback               | `wi005-14` remains intact; rollback is an atomic current-symlink switch plus launcher restart                       |

No credential value, environment dump, private prompt, or raw host error is
recorded here.

## Acceptance mapping

| AC    | Status                   | Observation and limit                                                                                                                                                                               |
| ----- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | target pass              | Concurrent same-Reference starts returned one identical opaque Execution Unit; the worker ran as uid/gid `997:989` with cgroup memory `536870912` and pids `64` limits.                             |
| AC-02 | contract pass            | Reference-bound IPC accepted only continuous bounded observations; wrong, cross-execution, skipped/replayed ordinal, oversized, and unbound candidate fixtures rejected.                            |
| AC-03 | target pass              | Cancel-before-start, delayed release, idle, blocked, child, and detached-descendant paths sealed the generation before returning evidence; late starts remained pending and units were empty first. |
| AC-04 | target pass              | Restart, old epoch, ledger-only, unit-only, mismatched Reference, and unknown/timeout fixtures did not replay Runtime; unavailable unit-empty proof withheld Stop Evidence.                         |
| AC-05 | contract pass            | Invalid worker frames and raw host-error causes projected only bounded sanitized failures.                                                                                                          |
| AC-06 | target pass              | The worker had only the fixed minimal environment and assigned Workspace; core DB, ledger, launcher socket/config, protected host paths, and privilege boundaries rejected access.                  |
| AC-07 | target and contract pass | Only sealed generation plus cgroup-unit-empty evidence authenticated stop; PID, scripted, process-group, signal, and cooperative-worker counterexamples did not.                                    |
| AC-08 | contract pass            | Production and MCP compositions triggered neither process creation nor Claude dispatch; no public dispatch/result/claim-release path was added.                                                     |
| AC-09 | local and target pass    | Fixed-toolchain `make verify` and designated-target `test:linux` both exited zero; the external preflight printed `G1_LINUX_PREFLIGHT_OK` and all nine files executed.                              |
| AC-10 | requires Human Review    | Target, paths, privilege boundary, ordering, Stop Evidence, rollback, and G1-C exclusion are recorded. This document does not approve review or unblock S3-B.                                       |

## Command evidence

| Command                | Environment                                                                                                    | Result                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `make verify`          | macOS development host; Node `24.21.0`, pnpm `12.4.1`; post-GATE-021 source before this evidence-only document | pass — 40 test files passed, 6 skipped; 202 tests passed, 30 skipped        |
| `make verify`          | `agentport-g1`, candidate `wi005-15`; Node `24.21.0`, pnpm `12.4.1`                                            | pass — 40 test files passed, 6 skipped; 206 tests passed, 26 skipped        |
| `pnpm run test:linux`  | `agentport-g1`, candidate `wi005-15`; explicit protected G1 metadata under a clean environment                 | pass — `G1_LINUX_PREFLIGHT_OK`; 9 files and 52 tests passed, zero skipped   |
| `pnpm run test:claude` | AP-004 G1-L                                                                                                    | not run and not required after GATE-021; explicitly deferred to AP-007 G1-C |

The target launcher was active and its socket present after the candidate switch.
The Linux suite took 38.24 seconds; its reconcile group executed nine tests,
start one test, stop five tests, isolation five tests, and the remaining
launcher／IPC／Stop Evidence／no-dispatch contracts completed within the same
52-test run.

## Architecture and residual limits

The architecture impact remains limited to the test-only Linux Supervisor
Adapter, protected launcher, generation ledger, isolated worker, and bounded
IPC. Production bootstrap and MCP mutation compositions cannot reach these
paths. G1-L does not prove a Claude account, SDK protocol, native question,
answer continuation, SDK cancellation, Session reference, production
dispatcher, terminal result, Workspace claim release, deployment, or
production readiness. AP-007 G1-C and AP-005 S3-B retain those separate
responsibilities.

Independent standards review and Sol/high specification/security review found
no remaining actionable findings for the implemented G1-L boundary. Human
Review must still assess this evidence and the GATE-021 scope split.
