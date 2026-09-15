# Durable admission operations and rollback

This note covers durable admission, data-preserving recovery, and the S5
storage-incident behavior exercised by the development compositions. It is not
a production runbook or a deployment or production-readiness claim.

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
- S4 Claude `preserve` continuation requires `continuationEncryptionKey`: a
  base64url-encoded 256-bit key held outside SQLite. Configure the same key
  before accepting any execution that can report a resumable session token, and
  retain it across daemon restart. Without it, a candidate carrying such a
  token is quarantined and `preserve` continuation fails closed; the raw token
  is never exposed through caller-facing storage methods.
- Do not rotate `continuationEncryptionKey` in place. Current protected
  session records are AES-GCM ciphertext bound to their execution, Context,
  binding, Runtime, and Workspace fields, and their stored key ID must match
  the configured key before `preserve` can proceed. There is no key-ring or
  re-encryption path. Before replacing the key, operators must explicitly
  abandon every continuation that still needs the old key using the supported
  `fresh_session` path with its Caller-provided summary, or retain the old key;
  changing the key otherwise makes those preserved continuations unavailable.
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
  Restart consumes only its reserved slice; terminal cancellation of a Task
  without an Execution consumes the remainder. An Execution cancel intent
  retains the remaining terminal/recovery reserve until trusted stop evidence
  can support a future terminal commit. Startup reconciles this sidecar from the durable per-Task ledger,
  rather than a cached capacity summary, and fails closed if the ledger is
  inconsistent or the allocation cannot be restored. This protects
  AgentPort-controlled capacity; it cannot prevent an unrelated host writer or
  administrator from deleting or exhausting the same filesystem.

## Storage incident convergence

- Expected configured queue, receipt, database-plus-WAL, or per-Task reserve
  saturation rejects only the new load with its existing capacity code. It does
  not trip the composition incident latch or evict retained data.
- A physical SQLite full/I/O failure, control-reserve reconciliation failure,
  commit-ambiguous mutation timeout, or unexpected storage-worker loss latches
  the controlled composition closed. Later mutations and dispatch preparation
  return the existing sanitized unavailable projection; the same process never
  reopens the latch.
- The controlled composition keeps a bounded ephemeral set of exact active
  Execution References, limited by the configured active-execution capacity.
  On an incident it calls the independent Supervisor's existing
  `revokeAndStop` operation once per exact Reference. This safety set is not a
  lifecycle store: it cannot publish terminal state, release a Workspace claim,
  or authorize a replacement generation.
- A failed or timed-out mutation remains commit-ambiguous. Do not infer
  rejection or issue a different operation ID. Preserve the database, WAL,
  shared-memory, and control-reserve files; retain Supervisor evidence; then
  replace the controlled composition only after the filesystem and reserve are
  healthy.
- New-composition startup opens and validates SQLite, reconciles the physical
  reserve, pauses queued work, recovers exact References, and reconciles them
  with the Supervisor before exposing dispatch. It never automatically starts
  a Task or redelivers an accepted answer. A recovered claim remains
  quarantined until matching trusted Stop Evidence and the later durable
  recovery acknowledgement complete.
- During an incident, `get_task` may return only a previously committed,
  bounded snapshot that still belongs to the current Access Scope and Agent
  allowlist, marked `stale`. Without that evidence it returns
  `observation_unavailable`. SQLite paths, SQL/lock details, Supervisor data,
  exact References, and foreign-scope cached content are never projected.

Operational recovery is therefore replacement, not an in-process reset: stop
the listener, preserve evidence, repair or restore the same-filesystem durable
artifacts, and start a new compatible composition. If storage health or
Supervisor reconciliation is still uncertain, leave dispatch closed and the
claims quarantined.

## Terminal retention and expiry

- Terminal Task retention defaults to 30 days from the durable terminal commit.
  Administrators may set `terminalRetentionDays`; MCP Callers cannot provide a
  cleanup time or change the policy. The store runs an internal hourly sweep by
  default, using short transactions of at most 100 Tasks, and immediately drains
  another bounded batch while a backlog remains.
- Cleanup selects each eligible terminal Task independently. A queued, paused,
  awaiting-input, starting, running, stopping, recovering, stop-unknown, held, or
  quarantined Task is never selected. A caller-acknowledged `interrupted` Task is
  concluded and follows the terminal retention window. A Context and the minimum structural rows
  needed by an unexpired or nonterminal follow-up remain until its final Task
  expires.
- One SQLite transaction writes the authorized Task marker and tombstones every
  related operation receipt before removing events, questions, observations,
  instructions, answers, and result payload. A cleanup failure rolls the entire
  batch back. AgentPort does not delete a Runtime vendor transcript.
- Under the `GATE-027` contract, authorized `get_task`, task-scoped event lookup,
  and an identical expired operation retry return `result_expired`; list results
  omit expired Tasks. A signed list or event cursor returns `cursor_expired` only
  when history after its recorded position was removed. A fresh snapshot records
  the current retention sequence and remains usable.
- The general receipt/tombstone limit defaults to 100,000. Saturation rejects new
  `submit`, `edit`, and `resume_context` mutations. Existing `reply`, `cancel`,
  and `acknowledge_interruption` operations use the accepted Task's control
  capacity and remain available until physical storage/control reserve failure.
  A first reply consumes one bounded receipt and half of the Task's physical
  control tranche; its exact `operationId` retry is write-free, while a different
  operation cannot create another receipt for the accepted answer. The 2 GiB
  database-plus-WAL admission boundary retains in-period results and rejects new
  work rather than evicting them. After a successful WAL checkpoint, admission
  planning may reuse SQLite freelist pages released by expiry; the committed
  DB-plus-WAL and total physical-capacity checks remain authoritative.

## Acceptance contract decisions

- `GATE-006` and `GATE-009`: every Registry authorization or binding change
  wins before a not-yet-committed mutation through the full revision fence.
- `GATE-007`: AP-002 includes bounded sanitized product audit records.
- `GATE-008`: AP-002 accounts for SQLite/WAL bytes and physically allocates the
  accepted-Task control reserve on the same filesystem.
- `GATE-010`: audit overflow uses ring overwrite with a persistent gap counter
  and never blocks reserved Task control operations.
- `GATE-027`: expiry retains a minimal authorized marker, returns
  `result_expired` for direct result lookup and identical retry, omits the Task
  from lists, and retires the Context only after its final Task expires.

These are product-contract decisions recorded for operations. Their Work Item,
Gate, verification, and Human Review state is not projected here; query
ForgePilot. This remains a development operations note, not a production
runbook.

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

After any newer schema, including the v13 retention-marker schema, has been
applied, older code must not open the live database. Never delete a schema
marker to simulate compatibility. Stop the listener and preserve the database
together with WAL/SHM/control-reserve companions. A compatible store in
`recoveryOnly: true` keeps the established recovery restrictions: it moves
unconfirmed Executions to `recovering`, quarantines their Workspace claims,
permits authorized query and cancellation control, and rejects new admission,
preparation, worker observations, and retention cleanup.

An offline restore is valid only after dispatch is disabled and external
execution effects have been reconciled or left fail-closed. Restore a
SQLite-consistent pre-v3 backup to a separate validated path and retain the v3
database as immutable recovery evidence. Neither recovery path publishes a
candidate as a result, releases a Workspace claim, or authorizes Runtime
dispatch.
