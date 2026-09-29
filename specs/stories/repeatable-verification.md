# Repeatable verification

## Goal

The verification command (`make verify`, which runs `pnpm check`) can be run
again immediately after it finishes, in the same checkout, and pass without a
reinstall in between. Running it, or running `pnpm service:install`, leaves
this checkout's `node_modules` with its development dependencies intact.

## Out of Scope

- Changing what the production package contains: the `pnpm deploy` output
  still holds only built files and production dependencies.
- Changing the arguments or observable output of `pnpm service:install`
  beyond its effect on this checkout's `node_modules`.
- Adding, removing, or reordering steps in `pnpm check` or `make verify`.
- Changing `.github/workflows/verify.yml`.
- Other ways `node_modules` can drift (manual `pnpm install --prod`, lockfile
  changes, switching branches).
- Upgrading, downgrading, or replacing pnpm.

## Acceptance Criteria

1. Starting from `pnpm install --frozen-lockfile`, running `make verify`
   twice in a row with no command in between exits 0 both times, and
   `git status --short` after the second run shows nothing that was not there
   before the first.
2. After `make verify` exits, `pnpm exec prettier --version`,
   `pnpm exec eslint --version`, `pnpm exec tsc --version`, and
   `pnpm exec vitest --version` each exit 0.
3. Starting from `pnpm install --frozen-lockfile`, running
   `pnpm service:install -- --dry-run --config <path>` and then
   `pnpm run format:check` does not fail with `prettier: command not found`.
4. Both tests in `tests/cli/package.test.ts` still run as part of
   `pnpm test` (neither is removed, skipped, or moved out of `pnpm check`), and
   they still assert that `service:install` output contains the host
   platform's service marker, that the deployed package has no `src`
   directory, and that the deployed `dist/cli.js check-config` succeeds.
5. `make verify` passes.
