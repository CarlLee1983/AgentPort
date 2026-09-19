# Acceptance Criteria

## Happy Path

- [ ] AC-01: an administrator can register two non-overlapping project Agents
      with stable IDs, bounded policies and protected Workspace bindings, and
      `agentport_list_agents` exposes only the Agents allowed to the current
      Principal.
- [ ] AC-02: an authorized downstream Caller can list Agents, submit a Task
      naming exactly one `agentId`, and observe the same Agent binding through
      the existing Task/query/event/control tools.

## Business Rules

- [ ] AC-03: `agentport caller add|list|revoke` generates a high-entropy token,
      displays the raw token only on add, stores only a versioned verifier
      hash, and maps the credential to an existing Principal and allowlist.
- [ ] AC-04: an atomic protected configuration replacement plus `SIGHUP`
      installs a new Registry revision; successful revocation rejects new
      Bearer requests, while invalid replacement preserves the previous
      revision and already committed Tasks remain bound to their original
      Agent.

## Failure Cases

- [ ] AC-05: missing/revoked credentials, cross-Principal Agent selection,
      unknown Agent IDs and caller-supplied paths/profiles/execution references
      produce sanitized failures with no Task, Workspace claim, Runtime start
      or launcher request.

## Regression Requirements

- [ ] AC-06: focused Registry/configuration/CLI/MCP and reload concurrency
      tests, `pnpm run test:platform-neutral`, and `make verify` pass on the
      same candidate; no raw token or protected project path appears in public
      output, audit, logs or test evidence.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test    | `tests/operations/managed-configuration.test.ts; tests/acceptance/production-daemon-mcp.test.ts`                         | `protected project fixture and provisioned Caller allowlist`            | `Agent listing is stable, scoped and path-free`                                                                |
| `AC-02` | test    | `tests/acceptance/production-daemon-mcp.test.ts; tests/acceptance/durable-admission.test.ts`                             | `authorized Caller, explicit agentId, and non-ready production fixture` | `selected agentId is authorized; non-ready admission has no side effect; ready composition schedules dispatch` |
| `AC-03` | test    | `tests/operations/managed-configuration.test.ts; tests/operations/management-cli.test.ts`                                | `administrator CLI fixture and token sentinel`                          | `raw token is one-shot; only bounded verifier material is persisted`                                           |
| `AC-04` | test    | `tests/unit/daemon-main.test.ts; tests/unit/daemon-lifecycle.test.ts; tests/integration/registry-revision-fence.test.ts` | `SIGHUP/replacement and concurrent mutation fixture`                    | `revision fence linearizes reload; invalid candidate leaves old revision active`                               |
| `AC-05` | test    | `tests/acceptance/production-daemon-mcp.test.ts; tests/acceptance/s5-mcp-authorization-matrix.test.ts`                   | `revoked/cross-scope/path-spoof/launcher-counter fixture`               | `stable denial with zero durable or runtime side effects`                                                      |
| `AC-06` | command | `pnpm run test:platform-neutral && make verify`                                                                          | `same repository candidate`                                             | `commands exit zero and secrecy checks remain green`                                                           |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `caller.bearerToken`     | `ap024-raw-token-sentinel` | reject          | `none`                                | `tests/operations/managed-configuration.test.ts; tests/operations/management-cli.test.ts` |
| `caller.tokenHash`       | `sha256-or-kdf-verifier`   | preserve        | `protected daemon configuration only` | `tests/operations/managed-configuration.test.ts`                                          |
| `agent.workspacePath`    | `/etc/agentport/../../etc` | reject          | `none`                                | `tests/operations/management-cli.test.ts`                                                 |
| `agent.launchProfileId`  | `caller-selected-profile`  | reject          | `none`                                | `tests/acceptance/production-daemon-mcp.test.ts`                                          |
| `caller.crossScopeAgent` | `project-not-in-allowlist` | reject          | `none`                                | `tests/acceptance/s5-mcp-authorization-matrix.test.ts`                                    |
| `registry.reloadError`   | `unsafe-invalid-candidate` | reject          | `previous revision`                   | `tests/unit/daemon-main.test.ts; tests/integration/registry-revision-fence.test.ts`       |

## Verification Notes

This Story enables the protected Agent/Caller admission seam but does not
publish an archive, installer, public HTTPS endpoint, OAuth discovery document
or GitHub release. Production Runtime readiness remains intentionally
unverified pending `GATE-058`; a submit in the current candidate is rejected
before Task creation. Those claims require a later Runtime/release/transport
Story and candidate-bound environment evidence.
