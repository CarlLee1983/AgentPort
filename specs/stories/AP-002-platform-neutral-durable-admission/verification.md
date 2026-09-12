# AP-002 local verification evidence

Observed on 2026-09-12 (Asia/Taipei) on macOS `26.5.1` (`25F80`), Darwin
`25.5.0 arm64`. The implementation is an uncommitted working-tree candidate
based on `055190e5b10ae2baad4c0ab43e2eb698e67dabe8`; Story authority forbids a
commit without new user authorization. Consequently this file records local
evidence only: no ForgePilot verification evidence can exist for this candidate
until it is committed and the worktree is clean.

The candidate source/diff digest, excluding this self-referential verification
file, is
`bdd161058f503542a9e4229fc7e17f7650611ab3647997d2a165f98df937e6d6`. It is calculated from the binary
worktree diff plus sorted hashes of untracked files, both excluding this file.
The changed/untracked path inventory was reviewed relative to the baseline
above for AC-06; it contains only bootstrap, core, MCP, storage, migration,
fixture/test, repository-gate, and documentation paths, with no execution
artifact category named by AC-06.

ForgePilot reports `WI-002` as `RUNNING`, not verified, and not reviewed, with
zero open Gates. `GATE-004` through `GATE-010` are resolved. The decisions used
by this candidate are: non-dispatch S2 may proceed on macOS; inactive membership
returns application `access_denied`; every authorization and binding change
wins before commit through a full Registry revision fence; AP-002 includes a
bounded sanitized product audit ring; accepted-Task control capacity uses
physical SQLite/WAL accounting plus same-filesystem reserved bytes; audit
overflow overwrites the oldest row, persists a gap counter, and does not block
reserved Task control.

| AC    | Status                         | Method                                                                                                | Actual observation and limit                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | local pass                     | `tests/acceptance/durable-admission.test.ts` with official MCP Client, loopback endpoint, real SQLite | Exactly six tools expose strict schemas and identical structured/JSON text results. Commit is immediately readable; queued and restart-paused Tasks cancel without an Execution.                                                                                                                                                                                                                                                                                    |
| AC-02 | local pass                     | acceptance transport-discard fixture plus `tests/integration/operation-receipts.test.ts`              | Concurrent same-fingerprint mutations have one effect; discarded and restart retries keep Task identity and return the current authorized snapshot; changed fingerprint, target, or operation type conflicts.                                                                                                                                                                                                                                                       |
| AC-03 | local pass                     | `tests/integration/storage-restart.test.ts` and cursor restart acceptance                             | Task, Context, BindingSnapshot, actor-attributed receipt, reservation, event, identity, order, and cursor survive reopen; queued becomes paused and no dispatch occurs.                                                                                                                                                                                                                                                                                             |
| AC-04 | local pass                     | authorization, product-audit, and Registry revision-fence acceptance/integration tests                | Missing/invalid bearer is 401; inactive membership gives six `access_denied` results; cross-scope and Agent revocation are indistinguishable `not_found`; replacement membership, Access Scope, allowlist, Workspace, runtime, version, and policy win before COMMIT. Audit persists only allowlisted protocol fields, client fingerprints, derived Principal, and stable outcomes.                                                                                 |
| AC-05 | local pass                     | `tests/integration/admission-failures.test.ts`, reserve tests, MCP policy/schema tests                | Commit failure rolls back both SQL and physical reserve; queue, receipt, byte, policy, and schema bounds fail explicitly without a partial or duplicate Task. Startup rejects inconsistent queued/paused event or byte ledgers rather than trusting cached capacity metadata.                                                                                                                                                                                       |
| AC-06 | local evidence                 | `tests/contracts/no-dispatch.test.ts` plus candidate diff inventory                                   | Reachability, schema, and process tripwire checks pass. Manual inventory relative to the baseline finds no dormant/flagged dispatcher, Runtime Driver, Supervisor Adapter, launcher, Execution, or Workspace-claim artifact; the test proves reachability, not provenance of every changed path.                                                                                                                                                                    |
| AC-07 | local evidence; review pending | transaction and Registry fence tests plus source-boundary review                                      | Service owns authorization/lifecycle intent, the MCP adapter owns protocol/error translation, and storage atomically persists transactions. Both pre-write and post-write/pre-COMMIT Registry checks are exercised, transparent retry is absent, and failed fence installation disables later mutations while preserving the prior readable snapshot. ADR-0003 and Story acceptance still require Human Review.                                                     |
| AC-08 | local pass                     | `tests/integration/storage-responsiveness.test.ts`                                                    | Main loop advances while the dedicated DB worker blocks or returns a bounded 1 MiB probe; timeout returns authorized stale data or explicit unavailable; stale cache is bounded. A 2,000-record audit burst keeps the newest payload, rejects 1,999 evictions, persists their gap, and does not prevent a 100 ms cancellation. Gap retries are idempotent after timeout/late commit; repeated failures terminate audit drain while cancellation and close complete. |
| AC-09 | local pass                     | `tests/integration/storage-reserve.test.ts` and failure injection                                     | Global/per-Workspace queue, receipt, and logical/physical byte exhaustion reject admission while accepted Task reads and cancellation remain available. Each accepted Task gets non-sparse, fsynced same-filesystem sidecar bytes; restart rebuilds cached capacity from the task ledger, reconciles the sidecar, consumes only its restart slice, and preserves the cancellation remainder.                                                                        |
| AC-10 | macOS local only               | `pnpm run test:platform-neutral` under the pinned toolchain                                           | Platform-neutral suite passes on this macOS host. No designated Linux target was available, and this is not Runtime, Stop Evidence, AP-001 AC-09, Linux G1, or production evidence.                                                                                                                                                                                                                                                                                 |
| AC-11 | local pass                     | direct and isolated-candidate exact-toolchain `make verify`                                           | A temporary Git index exports the full candidate into an empty directory with no `.git`, `node_modules`, or build output. Frozen install, repository/Story gates, format, lint, typecheck, build, AP-001 compatibility, and AP-002 tests pass; the existing deliberate wrong-Node evidence remains nonzero at the toolchain gate.                                                                                                                                   |

## Sanitized security observation

The authorization fixture exercises every input and expected projection in the
`acceptance.md` security matrix. Product audit records only allowlisted
method/tool names, normalized protocol revision, one-way SHA-256 client metadata
fingerprints, derived Principal ID, and stable result codes. The ring and its
overwrite count survive restart and shrink atomically when configured capacity
decreases; the ingress queue uses the same bound and persists coalesced drop
counts without retaining their payloads. Gap batches have persistent
idempotency keys, so timeout retries do not double-count. Raw client metadata, tool arguments,
bearer values, instructions,
host paths, cross-scope identities, and internal handler error text are absent
from persisted audit. Unexpected failures project and record only a fixed
`internal_error`, without message, cause, or stack.

## Isolated candidate method

The full uncommitted candidate is exported without mutating the repository
index: a temporary `GIT_INDEX_FILE` reads `HEAD`, stages the working tree with
`git add -A`, and uses `git checkout-index --all --prefix=<empty-export>/`.
Before verification, the export contains no `.git`, `node_modules`, or `dist`.
Only the repository-declared Node/pnpm toolchain is activated; no vendor
credential or private environment file is supplied.

## Command results

| Command                          | Result                                                             |
| -------------------------------- | ------------------------------------------------------------------ |
| `make verify`                    | pass — 18 files / 111 tests under Node `24.21.0` and pnpm `12.4.1` |
| `pnpm run test:mcp`              | pass — 4 files / 21 tests                                          |
| `pnpm run test:platform-neutral` | pass — 15 files / 105 tests                                        |

The candidate is not committed, so `forgepilot verify WI-002` was not run and
must not be inferred from these local results. `make verify` only prepares the
candidate for Human Review; it does not approve G2, complete `WI-002`, or make
AgentPort production-ready.
