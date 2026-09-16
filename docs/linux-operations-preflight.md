# Linux operations preparation preflight

This administrator-only command checks a proposed S6 host layout without
starting AgentPort, opening SQLite, touching a credential, or changing durable
state. It is preparation under ForgePilot GATE-030, not an install/start drill
or dispatch-readiness result.

Build the exact candidate, then run the command as root on the designated Linux
host with an existing root-owned protected launcher configuration:

```sh
pnpm run build
node dist/src/operations/linux-preflight-main.js \
  /etc/agentport/launcher.json \
  agentport-daemon \
  /var/lib/agentport/store.db \
  /run/agentport/ingress
```

The four arguments are the protected launcher configuration path, proposed
non-root daemon account, SQLite path, and worker ingress directory. The launcher
configuration remains the source of truth for the root launcher socket group,
ledger, Runtime identity, Runtime home, Workspace root and worker profiles.
Use only administrator-controlled absolute paths. The example contains no
credential or real host identity.

The command prints one JSON result containing stable check codes and exits zero
only when its **preparation** checks pass. It never prints input paths, account
names, numeric identities, secret values, or exception details. The result
always has `"dispatchEligible": false`. `preparation_valid` means only that
the checked identities and paths are compatible with the proposed separation;
it does not mean AgentPort is installed, queryable or dispatch-ready.

The checks confirm that the daemon is non-root and distinct from Runtime, is a
member of the launcher socket group while Runtime is excluded, and that the
database path is outside Runtime home, Workspace, ledger and ingress. Existing
paths are compared after resolving their directory aliases, so a symlinked
Workspace root cannot hide database overlap. Existing
database, WAL, SHM and control-reserve files plus their parent must be writable
by the daemon and not readable or writable by Runtime. The root-owned ledger,
launcher socket parent and any existing launcher socket must not grant Runtime
control access. The ingress directory must be root-owned, Runtime-group
traversable, and not group writable. Alongside mode bits, the command runs
read-only access probes as Runtime to catch effective ACL grants; if those
probes cannot run, preflight fails closed. The existing launcher configuration
reader rejects unprotected or malformed files before these checks run.

Codes marked `not_assessed` cover executable validity, Caller group isolation,
worker credentials, schema/recovery state, trusted Stop Evidence, broker
provisioning and HTTPS proxy behavior. These require later service assembly,
designated-Linux drills and G5 entry evidence. An invalid result blocks use of
the proposed layout; correcting it must not involve granting Runtime access to
SQLite, the launcher socket, the ledger or credential locations.
