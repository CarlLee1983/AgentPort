# Production daemon bootstrap (AP-022)

AP-022 supplies a production daemon entrypoint and the examples in
`config/systemd/agentport-daemon.service` and
`config/agentport.example.json`. They document the expected Ubuntu 24.04
amd64/systemd/cgroup-v2 deployment contract. This Story does **not** install
the unit, create accounts or groups, create paths, generate credentials,
reload systemd, enable a service, or start a service. Keep the warning in
`docs/deployment-guide.md` in force; it is not a deployment procedure.

The expected built command is:

```sh
node /opt/agentport/current/dist/src/daemon/main.js \
  --config /etc/agentport/agentport.json
```

The command requires the explicit, absolute configuration path. It refuses
root execution. It only binds `127.0.0.1`; the default port is 3333 and an
explicit configured port must be non-zero. A bind conflict is a startup
failure, not permission to choose another address or port.

## Administrator preflight

Before an administrator considers this example for a designated Linux target,
build the exact candidate and run the existing non-mutating preflight as root:

```sh
pnpm run build
node dist/src/operations/linux-preflight-main.js \
  /etc/agentport/launcher.json \
  agentport-daemon \
  /var/lib/agentport/daemon/agentport.sqlite
```

`preparation_valid` is preparation evidence only. It does not start AgentPort,
open SQLite, read credentials, report service readiness, or permit dispatch.
See [Linux operations preparation preflight](linux-operations-preflight.md)
for its exact checks and limitations.

The target contract requires the non-root `agentport-daemon` account and only
these supplementary groups:

| Group                                                       | Required purpose                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| launcher socket group (`agentport-launcher` in the example) | connect to the root-owned launcher socket                        |
| `agentport-ingress`                                         | traverse and validate the launcher-owned ingress directory       |
| Runtime group (`agentport-runtime` in the example)          | create ingress sockets owned by the daemon and usable by Runtime |

The launcher socket group must contain only the daemon service account. The
Runtime account must not join it or the ingress group. The daemon must not read
the root-only `launcher.json`, own or modify the ingress directory, or repair
ownership or modes. SQLite and its control reserve belong under the daemon-only
`/var/lib/agentport/daemon/` directory; Runtime must not read or write them.

## Protected configuration and credentials

Copy the shape in `config/agentport.example.json` to the protected path only
after the administrator has created the supported host layout. It is schema
version 1 and intentionally has no Caller bearer token, principal, anonymous
identity, or test switch. `agents: []` is valid: it starts only a zero-Agent
service skeleton.

The daemon validates the configuration before opening SQLite or composing the
service. Its strict top-level schema is `schemaVersion`, `mcp`, `storage`,
`launcher`, `agents`, and `principals`. `storage.databasePath`,
`launcher.socketPath`, and `launcher.workerIngressDirectory` are normalized
absolute paths. The launcher also declares numeric Runtime and ingress group
IDs; the numbers in the example are placeholders and must match the target's
`agentport-runtime` and `agentport-ingress` groups.
Existing numeric storage limits and `recoveryOnly` remain administrator
configuration options. Unknown fields, unsupported schema versions, unsafe
file metadata, or invalid values fail closed. The production registry fixes
credentials to an empty map and rejects `credentials`, tokens, and
`continuationEncryptionKey` in configuration. The protected configuration
contract is `root:agentport-daemon` mode `0640`; its ancestors must be
protected.

`LoadCredential` is the credential contract, not an environment-secret
contract. The unit names exactly these two systemd credentials:

| Credential ID               | Source file owned by root                              | Daemon use                                   |
| --------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| `cursorSecret`              | `/etc/agentport/credentials/cursorSecret`              | stable cursor signing material               |
| `continuationEncryptionKey` | `/etc/agentport/credentials/continuationEncryptionKey` | stable protected continuation encryption key |

systemd makes those files available beneath its per-service
`CREDENTIALS_DIRECTORY`. The daemon reads only those files from that directory;
they must be readable, non-empty, correctly encoded and the required length.
It never generates, rotates, copies, persists, logs, exposes, or passes them
to the Runtime. Do not put either value in `agentport.json`, argv, an
`Environment=` directive, a shell profile, a Workspace, or Runtime
environment. Keep each value stable across restarts: rotating either one can
invalidate already protected cursor or continuation data.

The included unit runs as `agentport-daemon`, uses restrictive `UMask=0077`,
orders itself after and requires `agentport-launcher.service`, and uses only
the three AP-021 supplementary groups. Its `TimeoutStopSec=30s` deliberately
leaves a five-second service-manager safety margin beyond the daemon's
25-second bounded shutdown deadline. SIGTERM and SIGINT
share one shutdown operation: it fences new admission and dispatch, preserves
committed facts, and only releases claims or publishes terminal state when the
existing Supervisor supplies trusted Stop Evidence. A timeout or indeterminate
stop remains recoverable/quarantined and exits with a sanitized failure; a
stopped listener or worker is not Stop Evidence.

The CLI writes one JSON object containing only a stable reason code to stderr
and exits non-zero on failure:

| Reason code                     | Meaning                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `daemon_arguments_invalid`      | argv is not exactly `--config <path>`                          |
| `daemon_root_forbidden`         | the daemon was invoked as uid 0                                |
| `daemon_configuration_invalid`  | configuration contents, owner, group, mode or path are invalid |
| `daemon_credentials_invalid`    | a required systemd credential is missing or invalid            |
| `loopback_listener_bind_failed` | the fixed loopback endpoint could not be bound                 |
| `daemon_startup_failed`         | another sanitized startup or reconciliation failure occurred   |
| `daemon_shutdown_failed`        | bounded shutdown could not confirm or finish every stop        |

Raw causes, protected paths, configuration payloads and secret values are not
included in this projection.

## What this service can and cannot claim

AP-022 implements a fixed-loopback daemon bootstrap, protected configuration
and systemd credential loading, startup reconciliation, and bounded shutdown.
Restart reconciliation pauses queued work, quarantines unknown Executions, and
does not replay Tasks, accepted answers, or Runtime commands automatically.

AP-023 is still required for the admin socket and full Deployment Readiness
observation. AP-024 is still required for Caller add/list/revoke, token
hashing, positive production Caller provisioning, and Registry hot reload.
Until those capabilities exist, this daemon must reject production submission:
it creates no Task or Workspace claim and sends no launcher request. Therefore
do not infer `execution-ready` from this unit being active, a loopback port
being open, an empty Agent listing, or a successful process start.

This document does not add a Runtime authorization route. Per ADR-0010,
Claude Runtime authorization remains the administrator's subscription OAuth in
the protected Runtime home; API-key and environment-injected OAuth paths are
not supported.

## Linux evidence commands

On the user-authorized designated Ubuntu 24.04 amd64 systemd/cgroup-v2 target,
run the evidence commands against the same candidate after the administrator
has independently installed the intended layout. These commands are evidence
collection, not an installation or enablement instruction:

```sh
pnpm run build
pnpm run test:platform-neutral
make verify
pnpm run test:linux
systemd-analyze verify config/systemd/agentport-daemon.service
```

The Linux/systemd credential, signal and Stop Evidence suites must execute
without skips on that target. A local macOS run, a skipped Linux test, or a
passing `systemd-analyze verify` is not AP-022 Linux acceptance evidence and
does not establish service or execution readiness.
