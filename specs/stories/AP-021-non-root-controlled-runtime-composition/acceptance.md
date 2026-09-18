# Acceptance Criteria

## Happy Path

- [ ] AC-01: on the designated Linux target, the S3-B composition runs as a
      non-root daemon account and the G4 MCP interaction completes a Task
      through launcher, non-root ingress and worker with Stop Evidence.

## Business Rules

- [ ] AC-02: launcher configuration accepts `ingressDirectory` and
      `ingressGroup`, rejects equal `ingressGroup`/`socketGroup`/`runtimeGroup`,
      and launcher startup creates or verifies the directory as root,
      `ingressGroup`, 0771 with protected ancestors.
- [ ] AC-03: each ingress socket is 0660, owned by the daemon uid and the
      Runtime group, and the Runtime identity cannot remove or replace it.

## Failure Cases

- [ ] AC-04: the composition refuses uid 0 and refuses dispatch when the
      ingress directory is missing, symlinked or has wrong owner, group or
      mode, without launching a worker.
- [ ] AC-05: a worker presenting a wrong ingress token is rejected and no
      Execution result is accepted.

## Regression Requirements

- [ ] AC-06: generation revoke, unit-empty Stop Evidence, queued restart pause
      and unknown-Execution quarantine still pass the existing Linux G1 suites
      with the non-root daemon.
- [ ] AC-07: Claude driver authentication remains subscription OAuth only;
      the clean harness rejects API-key and environment OAuth sources, and the
      ingress ownership, Runtime authorization and GATE-053 status-compatibility
      Gates are human-resolved before ADR, AP-020 or technical-design text
      changes.
- [ ] AC-08: `make verify` passes on the same candidate.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/claude/g4-mcp-interaction.test.ts` | `designated Linux target, non-root daemon, AGENTPORT_G1_LINUX=1, AGENTPORT_G1_CLAUDE=1 and root:root 0711 G4 fixture root` | `Task completes with Stop Evidence while the daemon uid is not 0` |
| `AC-02` | test | `tests/unit/launcher-configuration.test.ts` | `ingress group collision and valid configuration fixtures` | `collisions rejected and valid configuration parsed` |
| `AC-03` | test | `tests/linux/runtime-isolation.test.ts` | `designated Linux target, running launcher` | `socket mode 0660 daemon uid Runtime group; Runtime unlink and replace attempts fail` |
| `AC-04` | test | `tests/unit/controlled-runtime-admission.test.ts` | `uid 0 and invalid ingress directory metadata fixtures` | `composition rejects before any launch request` |
| `AC-05` | test | `tests/integration/s3-runtime-ingress.test.ts` | `wrong token worker fixture` | `authentication rejected and no result accepted` |
| `AC-06` | test | `tests/linux/execution-supervisor-stop.test.ts; tests/linux/execution-supervisor-reconcile.test.ts; tests/linux/non-root-composition-recovery.test.ts` | `designated Linux target; root parent performs restart fault injection; stop suite and composition recovery run as the non-root daemon account` | `generation revoke and unit-empty Stop Evidence pass; queued Tasks pause and an unknown Execution remains quarantined after restart` |
| `AC-07` | human | `ForgePilot Gate records and final diff` | `ingress ownership, Runtime authorization, GATE-053 and GATE-054 Gates` | `subscription OAuth only; clean harness rejects API-key and environment OAuth sources; core data remains root-only and G4 fixture root is traverse-only` |
| `AC-08` | command | `make verify` | `same candidate` | `exit 0` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `launcher.ingressDirectory` | `/run/agentport/ingress symlinked to /tmp` | reject | `no launcher listener` | `tests/unit/launcher-configuration.test.ts` |
| `launcher.ingressGroup` | `agentport-runtime` | reject | `no launcher listener` | `tests/unit/launcher-configuration.test.ts` |
| `ingress.token` | `ap021-ingress-token-sentinel` | omit | `logs, errors, audit and evidence` | `tests/integration/s3-runtime-ingress.test.ts` |
| `worker.authenticateMessage` | `wrong 43-character base64url token` | reject | `no Execution result` | `tests/integration/s3-runtime-ingress.test.ts` |

## Verification Notes

Linux evidence must come from the designated amd64 target named before review;
OrbStack runs may support iteration but are labelled as such. Tests whose
fixture names a Linux target are skipped on macOS and are not acceptance
evidence there.
