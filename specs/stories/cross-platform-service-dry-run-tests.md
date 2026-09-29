# Cross-platform service dry-run tests

## Goal

The tests that run the real CLI's `service install --dry-run` pass on both
platforms AgentPort supports as a service host: macOS (launchd) and Linux
(systemd user unit). On each platform they still prove that the built CLI
routes `service install --dry-run` to the service module and prints that
platform's service definition, so `make verify` passes on GitHub Actions
`ubuntu-latest` with Node 24 as well as on a macOS checkout.

## Out of Scope

- Changing what `agentport service install --dry-run` prints on either
  platform, or any other behavior under `src/`.
- Tests that inject `platform` through `ServiceDependencies`
  (`tests/service/install.test.ts`); they already cover both platforms
  independently of the host.
- The host-guarded `plutil -lint` check in `tests/service/install.test.ts`.
- Unsupported platforms (Windows and others).
- Adding a macOS job or a platform matrix to `.github/workflows/verify.yml`,
  or adding steps to `pnpm check` or `make verify`.

## Acceptance Criteria

1. On macOS, the test in `tests/cli/service.test.ts` that runs
   `dist/cli.js service install --dry-run` asserts stdout contains
   `com.agentport.serve` and `<plist`.
2. On Linux, the same test asserts stdout contains
   `Description=AgentPort MCP service` and
   `systemctl --user daemon-reload && systemctl --user enable --now agentport`.
3. On each platform, that test asserts stdout does not contain the other
   platform's marker: on macOS no `[Unit]`, on Linux no `<plist`.
4. The first test in `tests/cli/package.test.ts` (`pnpm service:install --
   --dry-run`) makes the same per-platform assertions as criteria 1–3.
5. Neither test is skipped, made conditional on the host platform
   (`it.skipIf`, `it.runIf`, early `return`), removed, or moved out of
   `pnpm test`.
6. `make verify` passes on macOS in this checkout.
7. `make verify` passes on Linux with Node 24, observed as the `Verify`
   workflow on GitHub Actions for this branch.
