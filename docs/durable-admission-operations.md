# Durable admission operations and rollback

This note covers only the AP-002 platform-neutral, non-dispatch development
slice. It is not a production runbook and provides no Runtime execution, Stop
Evidence, Linux G1, AP-001 AC-09, deployment, or production-readiness claim.

## Operating boundary

- The HTTP fixture binds only to `127.0.0.1`. A future non-loopback endpoint
  requires an explicitly approved TLS, proxy-trust, origin, and credential
  design; forwarded identity headers are not trusted here.
- Registry configuration maps bearer credentials to Principals separately from
  current membership and Agent allowlists. Missing or invalid credentials fail
  at HTTP 401. A valid credential whose membership is inactive reaches the
  application boundary and returns `access_denied` for every tool.
- Every service operation reauthorizes against the current atomically installed
  Registry snapshot. A full Registry revision fence covers membership, Access
  Scope, Agent allowlist, Workspace identity, Runtime metadata, and policy.
  A replacement that wins before commit rejects the original in-flight call as
  retryable `storage_unavailable`; only an explicit retry with the same
  operation ID may run under the replacement configuration. A failed fence
  install keeps the prior readable snapshot and disables further mutations.
- Keep `cursorSecret` stable across daemon restart. Rotating it invalidates
  existing opaque cursors, which then fail with the same `not_found` projection
  used for unauthorized or unknown cursors.
- The SQLite path must be an absolute durable filesystem path and is
  canonicalized before opening; its parent directory is
  administrator-controlled. The worker enables WAL, foreign keys,
  `synchronous=FULL`, and bounded requests.
  It also holds an exclusive daemon lock from startup through close and rejects
  unknown or incomplete schema versions. Do not place the database or bearer
  configuration inside an Agent Workspace.
- Product audit records contain only allowlisted method/tool names, normalized
  protocol metadata, one-way SHA-256 client metadata fingerprints, derived
  Principal identity, and a stable outcome code. They never receive raw client
  metadata, tool arguments, bearer values, instructions, host paths, stack
  traces, causes, or error messages. The bounded audit ring deletes its oldest
  record on overflow and increments a persistent overwrite counter. Its
  main-thread queue is bounded by the same capacity; the oldest queued payload
  is rejected so the newest remains, and evictions are coalesced into that
  persistent gap count. Gap retries carry a persistent idempotency key, so a
  late commit cannot double-count. Repeated gap failures terminate audit drain
  explicitly without blocking a reserved Task cancellation or storage close.

## Recovery and retry

- A successful submit response is emitted only after Task, Context,
  BindingSnapshot, operation receipt, reservation, and accepted event commit in
  one transaction. Disconnecting the MCP request does not cancel that commit.
- For a timed-out submit or cancel, retry only with the same `operationId` and
  identical initial arguments. Mutation errors expose
  `safeRetry=same_operation_id` when that retry is safe. A new operation ID can
  duplicate intent; changed arguments with the same ID return
  `operation_conflict`.
- Opening the database as a new daemon pauses every previously queued Task,
  preserves identity/order/receipts/events, and never dispatches it. The service
  supplies that lifecycle transition intent; storage applies it atomically.
  Queued and restart-paused Tasks remain cancellable through their reserved
  control records. A startup failure closes the worker and releases its daemon
  lock.
- A timed-out get may return an authorized bounded in-memory snapshot marked
  `stale`. If no currently authorized snapshot is retained, the request returns
  `observation_unavailable`; it does not wait for or infer Runtime state.
- Logical queue, receipt, or admission-byte exhaustion rejects new submit
  operations before acceptance. The worker accounts for the main SQLite file
  and WAL and allocates each accepted Task's control bytes by non-sparse writes
  to `<database>.control-reserve` on the same filesystem, followed by `fsync`.
  Restart consumes only its reserved slice; cancellation consumes the
  remainder. Startup reconciles this sidecar from the durable per-Task ledger,
  rather than a cached capacity summary, and fails closed if the ledger is
  inconsistent or the allocation cannot be restored. This protects
  AgentPort-controlled capacity; it cannot prevent an unrelated host writer or
  administrator from deleting or exhausting the same filesystem.

## Resolved acceptance decisions

- `GATE-006` and `GATE-009`: every Registry authorization or binding change
  wins before a not-yet-committed mutation through the full revision fence.
- `GATE-007`: AP-002 includes bounded sanitized product audit records.
- `GATE-008`: AP-002 accounts for SQLite/WAL bytes and physically allocates the
  accepted-Task control reserve on the same filesystem.
- `GATE-010`: audit overflow uses ring overwrite with a persistent gap counter
  and never blocks reserved Task control operations.

These decisions are implemented in the current candidate, but only committed
ForgePilot evidence and Human Review can accept the Story result. This remains
a development operations note, not a production runbook.

## Backup and rollback

Before inspecting or copying an unpublished development database, stop the
loopback listener and close the composition. Close drains already queued worker
operations before closing SQLite; the store is still closed if listener close
fails. Preserve the database together with any `-wal`, `-shm`, and
`.control-reserve` companions when a forensic copy is required.

AP-002 introduces the initial schema and has no published product data
migration. With explicit authorization to discard development data, rollback is
to stop the listener, retain any required evidence copy, remove the unpublished
database and its WAL/SHM/control-reserve companions, then revert the AP-002 code
and repository gate entries as one coherent change. Do not point older code at
this database or silently replace the durable store with an in-memory
implementation.
