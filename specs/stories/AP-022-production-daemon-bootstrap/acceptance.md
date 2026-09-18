# Acceptance Criteria

## Happy Path

- [ ] AC-01: the compiled production entrypoint starts as a non-root process
      from an explicit protected configuration path, binds the default or
      configured fixed loopback port without a test runner, and importing its
      modules does not start a listener or composition.
- [ ] AC-03: two daemon starts using the same valid systemd credential files
      reuse the identical `cursorSecret` and `continuationEncryptionKey`, keep
      existing cursor/continuation decoding valid and never generate or persist
      replacement secrets.
- [ ] AC-05: a valid zero-Agent configuration starts the service skeleton; an
      injected test Principal lists an empty Agent set, while the production
      CLI has no built-in Principal or test token and rejects unauthorized MCP.

## Business Rules

- [ ] AC-06: while production Caller verification or execution admission is not
      ready, submitting work returns a stable rejection, creates no Task or
      claim and sends no launcher request; no argv, environment or fixture flag
      can enable production dispatch.
- [ ] AC-08: submit/dispatch racing with shutdown preserves a submit commit that
      already won its durable boundary, but after the lifecycle fence closes no
      new Workspace claim, Execution generation or launcher start is produced.
- [ ] AC-10: restart uses the same database and existing reconciliation to pause
      queued Tasks, quarantine unknown Executions, preserve accepted-answer
      delivery state and avoid Task, answer or Runtime-command replay.

## Failure Cases

- [ ] AC-02: root execution, invalid/unknown/ill-typed configuration, unsafe
      configuration owner or mode, and missing/unreadable/empty/malformed/wrong-
      length credentials fail before dispatch without repairing permissions or
      creating service resources.
- [ ] AC-04: an occupied configured port or duplicate daemon fails with a stable
      reason, never changes port, releases only its own resources and does not
      run restart reconciliation that rewrites the active daemon's state.
- [ ] AC-07: SIGTERM, SIGINT and repeated signals share exactly one bounded
      shutdown; a signal received during starting prevents later awaited startup
      work from reopening admission, dispatch or the listener.
- [ ] AC-09: normal active-Execution stop, stop timeout and indeterminate
      Supervisor evidence are covered; only trusted Stop Evidence permits a
      terminal projection and claim release, while unknown stop stays
      recoverable/quarantined.
- [ ] AC-11: configuration, credential, bind and shutdown failures expose only
      stable documented reason codes; secret sentinels are absent from stdout,
      stderr, logs, audit, MCP errors, SQLite and Runtime environment.

## Regression Requirements

- [ ] AC-12: the same candidate passes focused daemon tests,
      `pnpm run test:platform-neutral`, `make verify`, and the required
      non-skipped Linux/systemd credential, signal and Stop Evidence suites on
      the designated authorized target.

## Acceptance Evidence

<!-- prettier-ignore -->
| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test | `tests/integration/production-daemon-process.test.ts; tests/unit/daemon-main.test.ts` | `built dist entrypoint, protected temporary configuration, non-root child and fixed free loopback port` | `child reaches running, binds only the configured port and module import has no service side effect` |
| `AC-02` | test | `tests/unit/daemon-configuration.test.ts; tests/unit/daemon-credentials.test.ts; tests/integration/production-daemon-process.test.ts` | `uid-0 seam, unknown schema/field/type, unsafe metadata and invalid credential matrix` | `stable startup rejection before store, listener, dispatch or permission mutation` |
| `AC-03` | test | `tests/integration/production-daemon-restart.test.ts` | `two sequential starts using one credential directory plus sealed cursor and protected continuation fixtures` | `both restarts use the same keys and existing protected data remains decodable without secret writes` |
| `AC-04` | test | `tests/integration/production-daemon-process.test.ts; tests/integration/production-daemon-restart.test.ts` | `occupied configured port and two daemons targeting the same database/port with a reconciliation sentinel` | `second start fails at the configured endpoint without fallback, leaks or mutation of the first daemon state` |
| `AC-05` | test | `tests/acceptance/production-daemon-mcp.test.ts` | `zero-Agent production configuration, test-only injected Principal and a separate production CLI child` | `injected Principal lists an empty set while the CLI rejects missing/arbitrary bearer credentials` |
| `AC-06` | test | `tests/acceptance/production-daemon-mcp.test.ts; tests/contracts/production-daemon-boundary.test.ts` | `AP-023/AP-024 unavailable, launcher start counter and attempted fixture argv/environment switches` | `submit creates no durable Task/claim/start and production surface has no fixture escape hatch` |
| `AC-07` | test | `tests/integration/production-daemon-process.test.ts; tests/unit/daemon-lifecycle.test.ts` | `real child signals plus controlled startup barriers and duplicate stop calls` | `one cleanup runs within deadline and startup cannot reopen after the stop fence` |
| `AC-08` | test | `tests/integration/production-daemon-shutdown-races.test.ts` | `submit commit barriers, dispatch preparation barriers and launcher counters` | `durable winner is preserved while no claim, generation or launch begins after shutdown linearization` |
| `AC-09` | test | `tests/integration/production-daemon-shutdown-races.test.ts; tests/linux/execution-supervisor-stop.test.ts; tests/linux/g5-crash-window-matrix.test.ts` | `active Execution with stopped, pending and indeterminate Supervisor outcomes on designated cgroup-v2 target` | `trusted stop is recorded for later acknowledgement; timeout/unknown preserves claim and recoverable state with bounded service failure` |
| `AC-10` | test | `tests/integration/production-daemon-restart.test.ts; tests/integration/execution-lifecycle-recovery.test.ts; tests/integration/g5-crash-window-matrix.test.ts; tests/linux/non-root-composition-recovery.test.ts` | `queued, accepted-answer-pending and unknown-Execution durable fixtures plus replay counters` | `restart pauses/quarantines, preserves accepted delivery state and performs no Task, answer or Runtime-command replay` |
| `AC-11` | test | `tests/acceptance/production-daemon-secrecy.test.ts; tests/integration/production-daemon-process.test.ts; tests/linux/production-daemon-systemd.test.ts; tests/linux/runtime-isolation.test.ts` | `unique secrets and raw diagnostic sentinels across startup, MCP, shutdown, daemon environment and exact Runtime environment` | `only documented stable reason codes appear and no sentinel reaches an unauthorized sink` |
| `AC-12` | command | `pnpm run test:platform-neutral && make verify && pnpm run test:linux` | `one ForgePilot candidate plus authorized Ubuntu 24.04 amd64 systemd/cgroup-v2 target with LoadCredential` | `focused and full local gates pass and every required Linux test executes without skip on the same candidate` |

## Security Fixture Matrix

<!-- prettier-ignore -->
| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `cli.configurationPath` | `relative/or/missing/agentport.json` | reject | `stable stderr reason only` | `tests/unit/daemon-main.test.ts` |
| `configuration.json` | `schemaVersion 999 with unknown bearerTokens field` | reject | `no SQLite or listener` | `tests/unit/daemon-configuration.test.ts` |
| `configuration.fileMetadata` | `group-writable config or symlinked protected ancestor` | reject | `no permission repair or service resource` | `tests/unit/daemon-configuration.test.ts` |
| `configuration.mcp.port` | `0 or occupied fixed port` | reject | `no fallback listener` | `tests/integration/production-daemon-process.test.ts` |
| `credential.cursorSecret` | `ap022-cursor-secret-sentinel-invalid` | redact | `systemd credential fixture only` | `tests/acceptance/production-daemon-secrecy.test.ts` |
| `credential.continuationEncryptionKey` | `ap022-continuation-secret-sentinel-invalid` | redact | `systemd credential fixture only` | `tests/acceptance/production-daemon-secrecy.test.ts` |
| `CREDENTIALS_DIRECTORY` | `/tmp/ap022-credential-path-sentinel` | redact | `process-local path metadata only` | `tests/acceptance/production-daemon-secrecy.test.ts` |
| `listener.error` | `EADDRINUSE with protected endpoint details` | redact | `stable loopback_listener_bind_failed reason` | `tests/integration/production-daemon-process.test.ts` |
| `shutdown.error` | `Supervisor raw reference and timeout cause sentinel` | redact | `stable daemon_shutdown_failed reason and durable recovery state` | `tests/acceptance/production-daemon-secrecy.test.ts` |
| `Runtime environment` | `cursor and continuation sentinel search` | omit | `no worker credential or environment field` | `tests/linux/production-daemon-systemd.test.ts` |

## Verification Notes

Focused daemon tests run before `pnpm run test:platform-neutral` and
`make verify`. Linux acceptance requires the exact ForgePilot candidate tested
on the user-authorized designated Ubuntu 24.04 amd64 systemd/cgroup-v2 target;
macOS results, platform-neutral substitutes and skipped Linux tests are not
evidence. `test:claude` runs only if a real Runtime call is necessary and
separately authorized. Missing target access remains explicit missing evidence
and blocks Human Review rather than being recorded as PASS.
