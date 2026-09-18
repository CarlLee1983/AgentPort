#!/bin/sh
set -eu

pnpm run build
node scripts/require-g1-linux.mjs
pnpm run build:fixtures

pnpm exec vitest run --no-file-parallelism \
  --exclude tests/linux/execution-supervisor-stop.test.ts \
  tests/linux \
  tests/contracts/linux-stop-evidence.test.ts \
  tests/contracts/runtime-worker-ipc.test.ts \
  tests/contracts/g1-no-production-dispatch.test.ts

exec /usr/sbin/runuser --user "${AGENTPORT_G1_DAEMON_USER}" -- \
  /usr/bin/env -i \
  HOME=/tmp \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  AGENTPORT_G1_LINUX="${AGENTPORT_G1_LINUX}" \
  AGENTPORT_G1_LAUNCHER_SOCKET="${AGENTPORT_G1_LAUNCHER_SOCKET}" \
  AGENTPORT_G1_LEDGER_DIRECTORY="${AGENTPORT_G1_LEDGER_DIRECTORY}" \
  AGENTPORT_G1_WORKSPACE_IDENTITY="${AGENTPORT_G1_WORKSPACE_IDENTITY}" \
  AGENTPORT_G1_RUNTIME_USER="${AGENTPORT_G1_RUNTIME_USER}" \
  AGENTPORT_G1_RUNTIME_UID="${AGENTPORT_G1_RUNTIME_UID}" \
  AGENTPORT_G1_RUNTIME_GID="${AGENTPORT_G1_RUNTIME_GID}" \
  AGENTPORT_G1_CORE_DATA_PATH="${AGENTPORT_G1_CORE_DATA_PATH}" \
  AGENTPORT_G1_LAUNCHER_SERVICE="${AGENTPORT_G1_LAUNCHER_SERVICE}" \
  AGENTPORT_G1_LAUNCHER_CONFIG="${AGENTPORT_G1_LAUNCHER_CONFIG}" \
  AGENTPORT_G1_RUNTIME_HOME="${AGENTPORT_G1_RUNTIME_HOME}" \
  AGENTPORT_G1_WORKSPACE_PATH="${AGENTPORT_G1_WORKSPACE_PATH}" \
  AGENTPORT_G1_DAEMON_USER="${AGENTPORT_G1_DAEMON_USER}" \
  AGENTPORT_G1_G4_FIXTURE_ROOT="${AGENTPORT_G1_G4_FIXTURE_ROOT}" \
  AGENTPORT_G1_INGRESS_DIRECTORY="${AGENTPORT_G1_INGRESS_DIRECTORY}" \
  AGENTPORT_G1_INGRESS_GID="${AGENTPORT_G1_INGRESS_GID}" \
  ./node_modules/.bin/vitest run --no-file-parallelism --no-cache \
  --fsModuleCachePath=/tmp/agentport-vitest-daemon-cache \
  tests/linux/execution-supervisor-stop.test.ts
