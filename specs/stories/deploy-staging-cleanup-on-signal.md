# Deploy staging cleanup on signal

## Goal

When `scripts/deploy-package.mjs` is interrupted with SIGINT, SIGTERM, or SIGHUP, it
removes the `agentport-stage-*` staging directory it created before the process
exits, just as it already does on success and on ordinary failure.

## Out of Scope

- SIGKILL, power loss, or any termination the process cannot observe.
- Removing or rolling back partial contents of the deploy target directory.
- Changing what the deployed package contains, including the byte layout of
  its `package.json`.
- Suppressing `pnpm pack` lifecycle scripts (`prepack`, `prepare`,
  `postpack`).
- Changing how the tarball is located inside the staging directory, or the
  error printed when none is found.
- Changing the script's arguments, its output on success, or its exit code on
  success or on non-signal failure.
- Adding, removing, or reordering steps in `pnpm check` or `make verify`.

## Acceptance Criteria

1. A test under `tests/cli/` runs `node scripts/deploy-package.mjs <target>`
   with `TMPDIR` set to an empty temporary directory, waits until an
   `agentport-stage-*` entry appears there, sends the process SIGTERM, and
   after the process exits asserts that the directory has no
   `agentport-stage-*` entry.
2. The same test, repeated with SIGINT, makes the same assertion.
3. The process exits with code 143 after SIGTERM, 130 after SIGINT, and 129
   after SIGHUP, and a SIGHUP test makes the same assertions as criterion 1.
4. In both tests, 15 seconds after the process exits the directory still has
   no `agentport-stage-*` entry, so no child process re-creates it.
5. Both existing tests in `tests/cli/package.test.ts` still run as part of
   `pnpm test` with their assertions unchanged.
6. `make verify` passes.
