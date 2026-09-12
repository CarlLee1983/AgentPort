# AP-001 verification evidence

Observed on 2026-09-12 (Asia/Taipei). Execution host: macOS `26.5.1`
(`25F80`), Darwin `25.5.0 arm64`. Toolchain: Node `24.21.0`, pnpm
`12.4.1`. Immutable implementation revision:
`e1076f0ba4e7e3b2a345a9e23a3ed2e22447738b`, based on
`8a4dff88aeb7b19bdee179ca257af0dec1655399`. ForgePilot evidence `EV-001`
passed against that revision. No bearer value is recorded in this document.

| AC    | Status  | Command / fixture                                                                                                      | Expected                                                                                                                                                 | Actual observation and limit                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | pass    | Alternate-index candidate checkout without `node_modules` or `.env`; `pnpm install --frozen-lockfile`                  | Fresh deterministic install exits 0 with no lockfile change                                                                                              | Exact Node/pnpm installed 233 packages from `pnpm-lock.yaml`; the isolated candidate subsequently passed `make verify`.                                                                                                                                                                                                                                                                               |
| AC-02 | pass    | `scripts/verify-toolchain.sh`; manifest, CI and root-lockfile review                                                   | One exact pnpm version and one lockfile                                                                                                                  | `packageManager`, engine, CI and docs select `pnpm@12.4.1`; only `pnpm-lock.yaml` exists.                                                                                                                                                                                                                                                                                                             |
| AC-03 | pass    | `make verify`                                                                                                          | Repository, Story, toolchain, frozen install, format, lint, typecheck, build and test layers run; any failure propagates                                 | The exact-toolchain run exited 0. A deliberate Node `22.17.1` run exited 2 at the toolchain contract.                                                                                                                                                                                                                                                                                                 |
| AC-04 | pass    | `pnpm run test:mcp`; official Client `2.0.0`, loopback random port, request-per-instance server                        | Pinned `2026-07-28` requests preserve per-request version, client info and capabilities without session lifecycle                                        | Four MCP tests pass. The sanitized transcript records `tools/list` and `tools/call` with version `2026-07-28`, client `ap001-client@1.0.0`, capabilities `{}`, and derived principal labels; responses contain no `Mcp-Session-Id`.                                                                                                                                                                   |
| AC-05 | pass    | `pnpm run test:mcp`; `compatibility_identity`                                                                          | Advertised input/output schemas; structured and JSON text output agree; unknown/invalid calls fail                                                       | `tools/list` advertises a strict empty-object input and object output. A successful call returns structured `{"ok":true,"principal":"principal-a"}` and identical parsed text. Unknown tool rejects with `-32602`; unexpected and identity-override arguments return `isError: true` without execution.                                                                                               |
| AC-06 | pass    | `pnpm run test:mcp`; authentication, protocol and legacy negatives with stdout/stderr capture; `EV-001` log inspection | Missing/invalid bearer is 401 before other request validation; unsupported/incomplete/legacy requests fail; no failed call executes or emits token bytes | Missing bearer, invalid bearer, and a request missing both bearer and protocol metadata return 401. Unsupported `1900-01-01`, missing header/envelope, `initialize`, and `notifications/initialized` return explicit 400 errors. Captured responses, process output, sanitized transcript, verification document, and the 57-line ForgePilot log contain none of the three synthetic token sentinels. |
| AC-07 | pass    | `pnpm run typecheck`; `tests/claude-capabilities.test.ts`; fixed package declarations                                  | Required fixed-SDK capabilities are traceable while real runtime behavior stays unclaimed                                                                | At SDK `0.3.269`, compile assertions cover streaming prompt input, abort/controller methods, `canUseTool`, SDK `AskUserQuestionInput`, cwd/settings, resume and launcher seam. Package basis is Claude Code `2.1.269`; all platform runtime optional packages are absent. No query was launched; runtime behavior remains S1.                                                                         |
| AC-08 | pass    | `pnpm run test:sqlite`; Worker-owned temporary database                                                                | Binding loads under Node 24, runtime version and WAL state are observed, and control loop remains responsive                                             | `better-sqlite3@13.0.3` loaded in a Worker with SQLite `3.53.4`; journal mode was `wal`; the main event loop advanced before completion. SQLite `3.53.4` includes the WAL-reset fix introduced in `3.51.3`.                                                                                                                                                                                           |
| AC-09 | blocked | Linux prerequisite table in `docs/toolchain-compatibility.md`; ForgePilot `GATE-001`                                   | Designated target metadata covers OS, cgroup v2, service account, launcher, protected data path and credential source without secret values              | No designated Linux target, account, launcher, protected path or credential-source metadata was supplied. The current host is macOS. `GATE-001` preserves the target/path decision and blocks G0 acceptance.                                                                                                                                                                                          |
| AC-10 | pass    | This evidence table, compatibility document, implementation revision and ForgePilot `EV-001`                           | Every AC has allowed status, source revision, command/fixture, expected and actual result, date and limits; ForgePilot binds an immutable revision       | All ACs are mapped here. `EV-001` ran `make verify` in a detached worktree and passed at `e1076f0ba4e7e3b2a345a9e23a3ed2e22447738b`; AC-09 remains visibly blocked.                                                                                                                                                                                                                                   |
| AC-11 | pass    | Isolated candidate frozen install and `make verify`; deliberate wrong-Node run                                         | Clean valid setup is repeatable and exits 0; a failed check is nonzero; no vendor credential is needed                                                   | The isolated candidate passed frozen install and all checks. The exact-toolchain working tree also passed. Node `22.17.1` failed nonzero. No credential or private environment file was used.                                                                                                                                                                                                         |
| AC-12 | pass    | Final diff, process and dependency audit                                                                               | No real coding runtime/model invocation, product module, Task storage or dispatch                                                                        | The diff contains only toolchain configuration, compatibility fixtures/tests and evidence. Claude platform runtimes are excluded and no `query()` call, product `src` tree, Task schema or dispatcher exists.                                                                                                                                                                                         |

## Sanitized MCP observation

The fixture captured the following sanitized positive result and rejected
request correlation. Bearer headers are intentionally omitted:

```json
{
  "request": {
    "methods": ["tools/list", "tools/call"],
    "protocolVersion": "2026-07-28",
    "clientInfo": { "name": "ap001-client", "version": "1.0.0" },
    "clientCapabilities": {},
    "principal": "principal-a"
  },
  "response": {
    "structuredContent": { "ok": true, "principal": "principal-a" },
    "parsedTextContent": { "ok": true, "principal": "principal-a" }
  },
  "rejectedRequest": {
    "requestId": "ap001-request-1",
    "responseId": "ap001-request-1",
    "requestedProtocolVersion": "1900-01-01",
    "supportedProtocolVersions": ["2026-07-28"]
  }
}
```

## Command results

| Command                          | Environment                                       | Result                                                                                          |
| -------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Isolated candidate; Node `24.21.0`; pnpm `12.4.1` | pass — 233 packages installed; no pre-existing dependencies or private environment              |
| `pnpm run test:mcp`              | MCP packages `2.0.0`                              | pass — 4 tests                                                                                  |
| `pnpm run test:sqlite`           | binding `13.0.3`                                  | pass — 1 test; SQLite `3.53.4`                                                                  |
| `pnpm run typecheck`             | TypeScript `6.0.3`; `skipLibCheck: false`         | pass                                                                                            |
| `make verify`                    | Exact toolchain                                   | pass — repository, Story, toolchain, frozen install, format, lint, typecheck, build and 6 tests |
| `make verify`                    | Deliberate Node `22.17.1` mismatch                | fail as expected — exit 2, required Node `24.21.0`                                              |
| `forgepilot verify WI-001`       | Detached worktree at `e1076f0ba4e7`               | `EV-001 PASS`; 57-line log inspected with no token sentinel match                               |

## Limits and residual evidence

AC-09 remains blocked under `GATE-001`, so G0 cannot be accepted. Claude positive query,
AskUserQuestion interaction, cancellation/cleanup and Linux execution belong to
S1 and were not run. The MCP fixture proves the approved private bearer boundary;
it does not claim full OAuth conformance or expose AgentPort product tools. Human
Review remains required and this document does not mark the Work Item DONE.
