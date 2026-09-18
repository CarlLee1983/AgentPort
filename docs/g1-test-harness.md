# Designated Linux G1/G4 test harness

This is an operator-controlled acceptance fixture, not a production installer.
It contains no Runtime credential. The designated Ubuntu 24.04/amd64 target
uses `config/g1/launcher.orbstack.json` and the accounts/groups named there.

Before running `pnpm run test:linux` or `pnpm run test:claude`, an administrator
creates the AP-021 fixture root independently of core data:

```sh
sudo install -d -o root -g root -m 0711 /var/lib/agentport/g4-fixtures
sudo test "$(stat -c '%U:%G:%a' /var/lib/agentport/g4-fixtures)" = root:root:711
```

The test environment sets these non-secret AP-021 values in addition to the
existing G1 variables checked by `scripts/require-g1-linux.mjs` and
`scripts/require-g1-claude.mjs`:

```sh
export AGENTPORT_G1_G4_FIXTURE_ROOT=/var/lib/agentport/g4-fixtures
export AGENTPORT_G1_INGRESS_DIRECTORY=/run/agentport-g1-ingress
export AGENTPORT_G1_INGRESS_GID="$(getent group agentport-ingress | cut -d: -f3)"
```

The root test parent may create and remove per-run fixture directories and
inject systemd/ledger failures. Supervisor protocol calls and controlled
composition recovery are executed through `runuser` as
`AGENTPORT_G1_DAEMON_USER`; the fixtures assert that resulting uid is nonzero.
The Runtime identity receives neither directory read/write access nor any
credential through this setup.

`test:claude` additionally requires the protected Runtime home and the
administrator's existing subscription OAuth login described by ADR-0010. Do
not place or print that credential in this environment, repository, or test
evidence.
