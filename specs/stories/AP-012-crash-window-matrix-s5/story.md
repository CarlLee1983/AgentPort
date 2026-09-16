# Story: AP-012 — Complete the S5 Crash-Window Matrix for S6 Entry

## Goal

Give authorized Callers a traceable answer after daemon, worker or Supervisor
failure at every accepted-work boundary, without replaying a Task or answer,
inventing a terminal result, or releasing an occupied Workspace early.

## Context

This is the [Implementation Plan S5/G5](../../../docs/implementation-plan.md)
crash-matrix prerequisite to S6, based on [historical issue 19](../../../.scratch/agentport-v0-1/issues/19-crash-window-matrix.md).
AP-008 supplies durable Question, Context and continuation contracts; AP-010
adds physical storage-incident convergence but explicitly excludes the complete
G5 crash-window matrix. Existing tests prove individual restart and fault paths;
this Story collects missing boundaries into candidate-bound evidence and fixes
only demonstrated violations at the owning seam.

[ADR-0001](../../../docs/adr/0001-external-observation-and-control.md)
keeps query and cancel independent of Runtime input. [ADR-0002](../../../docs/adr/0002-task-records-survive-restart.md)
forbids automatic replay when execution outcome is uncertain.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: mixed

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: no
* push: no
* deploy: no

## Architecture

* Impact: high
* Boundary: `AgentExecutionService and DurableAdmissionStore crash recovery`
* Contract: `Durable receipts, Questions, claims, observations and Stop Evidence decide recovery; a restart never manufactures a new generation or replays Runtime input`
* Owner: `AgentExecutionService and DurableAdmissionStore crash recovery = AgentPort core persistence`

## Risk

* Level: high
* Reason: `persistent-data`
* Reason: `concurrent-recovery`
* Reason: `runtime-stop`

## Scope

### In Scope

* Candidate-bound fault matrix across admission commit/response, claim/launch,
  generation revoke/late start, answer commit/delivery/ack, and candidate
  outcome/cleanup/terminal commit, including a second failure during recovery.
* Focused durable-store, core, Runtime ingress and Linux Supervisor fixtures
  that record persistent state, start counts, held claims and Stop Evidence.
* Fixes at an existing owning boundary when a stable regression fixture proves
  a violation of the approved Task, Question or Execution contract.

### Out of Scope

* Issue 20's complete authorization/policy adversarial matrix, issue 21's
  load/latency measurements, S5/G5 completion, S6 deployment or release.
* A new public lifecycle result, auto-replay policy, Runtime fallback, invented
  Stop Evidence or broad state-machine redesign.

## Inputs

* AP-008, AP-010 and prior S3 restart contracts, with their current ForgePilot
  evidence and exact implementation candidate.
* Synthetic fault barriers, trusted test clock and designated Linux cgroup-v2
  Stop Evidence target; no real credential or private prompt enters fixtures.

## Outputs

* Reproducible crash matrix with expected/actual Task, Execution, Question,
  receipt, claim and start-count observations for each boundary.
* Focused regression tests and any bounded fixes required by failing evidence.
* Sanitized command logs and limitations for later G5/S6 acceptance.

## Rules

* R1: A commit-before-response retry retrieves only the durable original
  receipt; a pre-commit failure never starts an Execution.
* R2: Claim or launcher uncertainty holds the Workspace until exact Reference
  reconciliation; recovery cannot infer no start from an absent acknowledgement.
* R3: Generation revocation wins over a delayed start, including after
  Supervisor restart; a temporarily empty cgroup is not Stop Evidence unless
  the generation is sealed and the exact unit is proven empty.
* R4: A committed first Question answer survives worker/daemon loss but is not
  delivered twice. Callback or ack loss projects delivery unknown and does not
  reopen the native waiting point.
* R5: Candidate outcome is untrusted until exact Stop Evidence and a durable
  terminal transaction agree. An absent or rolled-back terminal commit holds
  claim and reports unknown instead of inventing success.
* R6: Restart and repeated crash reconcile prior exact References before new
  dispatch; no automatic Task, answer or Runtime Session replay occurs.
* R7: Evidence contains bounded synthetic identifiers and sanitized diagnostic
  codes, not raw credential, private instruction, answer, worker stderr or host
  path. A changed public or runtime-isolation semantic requires a ForgePilot Gate.

## Expected Errors

* A missing durable receipt, unconfirmed stop, invalid candidate ordinal or
  unavailable storage leaves an explicit pending/recovering/quarantined or
  unavailable state rather than a false terminal result.
* A repeated or conflicting operation reports its existing stable conflict or
  replay result without starting another Runtime generation.

## Dependencies

* AP-008 Context/Question/continuation and AP-010 storage-incident contracts
  must remain available. Their Work Items are DONE in ForgePilot but do not
  themselves prove this complete G5 crash matrix.
* This Story supplies only the crash-matrix prerequisite; G5 additionally needs
  issue 20 authorization and issue 21 load/latency acceptance before S6 exits.

## Constraints

* Use real SQLite transactions and the designated Linux target for any claim of
  trusted Stop Evidence; a scripted Supervisor is only a contract fixture.
* `make verify`, `pnpm run test:faults` and `pnpm run test:linux` are required
  automated evidence on the same candidate, with Linux skips treated as missing
  environmental evidence rather than a pass.
* No commit, push, production deployment, vendor login, Gate resolution or
  Human Review approval is authorized by this Story.

## Guidance

Relevant:

* [Engineering entry](../../../guidance/ENTRY.md): test behavior at the owning
  seam and preserve one durable source of truth.
* [Development workflow](../../../docs/development-workflow.md): verify the
  actual candidate and open a Gate for semantic decisions.

## Trust Boundary Fields

* `operationId` — Caller-controlled idempotency key in admission, reply,
  cancellation and interruption acknowledgement.
* `taskId` — Caller-supplied logical Task identifier looked up under current
  Access Scope before any receipt or recovery projection.
* `execution.reference` — Runtime/launcher-derived generation, daemon epoch,
  launch profile and Workspace identity used only for exact reconciliation.
* `question.answer` — private Caller answer durably committed once and not
  included in fault logs or replayed after callback loss.
* `worker.observation` — untrusted bounded candidate, progress or session data
  that cannot establish a terminal outcome or Stop Evidence alone.
* `error.details` — derived SQLite, Supervisor, IPC or runtime diagnostic
  material that must be sanitized before public projection or evidence export.
