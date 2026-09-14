# AgentPort development workflow

ForgeFlowV2 is the engineering protocol; ForgePilot is the engineering control
plane; AgentPort is the product. ForgeFlowV2 and ForgePilot do not enter the
AgentPort runtime dependency graph and do not redefine the product domain.

    Human requirement
        ↓
    ForgeFlow Story
        ↓
    ForgePilot Work Item
        ↓
    authorized implementation
        ↓
    make verify
        ↓
    ForgePilot candidate evidence
        ↓
    Human Review

Product vocabulary and boundaries remain in CONTEXT.md, technical design, and
ADRs. An approved Story supplies product intent; a Work Item controls the
current execution of that intent.

## Authority and repository contract

ForgeFlowV2 0.9.0 holds Story intent, Acceptance Criteria, architecture and
risk contracts, verification semantics, Story readiness, and historical
evidence. ForgePilot v0.2.1 is the sole mutable authority for Work Item,
lifecycle, Gate, blocker, next action, verification-current, Human Review, and
completion. AgentPort holds implementation, tests, and make verify.

The only ForgeFlow repository entrypoints required for conformance are:

* AGENTS.md
* Makefile, exposing make verify
* specs/stories/

guidance/, Story task and verification files, handoff material, skills, and CI
are optional capabilities. Bootstrap layout is an installer concern, not a
repository conformance rule. AgentPort deliberately retains its repository-owned
AGENTS.md, CONTEXT.md, Makefile, guidance, documentation, ADRs, and scripts.

This adoption uses ForgeFlowV2 0.9.0 at clean source commit
2e012222b6bb24eca1059285b91ffcfc074a3440. The repository-owned Story checker,
LICENSE, and templates were reconciled from that source after an official
bootstrap --upgrade --dry-run review. The marker in specs/.forgeflow-adoption
records that source revision only; it is not verification evidence.

The repository-owned checker is a static read-only check called by make verify.
It checks structural readiness, not human authorization, product behavior, or
Work Item state. Do not install a second ForgeFlow lifecycle projection or make
the optional upstream skills a repository requirement.

## Story creation, readiness, and Work Items

story.md plus acceptance.md are requirement authority. Before creating or
executing a Work Item, confirm that each AC maps to exactly one Acceptance
Evidence row with method, fixture or precondition, and observable outcome.
task.md may contain plan or notes only; it does not create a current Story,
claim, status, done marker, blocker, or review decision.

Use ForgePilot for all current-state questions:

    forgepilot status
    forgepilot status --work <work-id> --summary
    forgepilot next

Never derive current execution from a Story directory's order, task.md,
verification.md, handoff.md, a prior Story, or Git history. A newly created
uncommitted Story may be added as a Work Item, but that does not make ordinary
committed verification valid. Initialize or upgrade local ForgePilot state only
through the target CLI:

    forgepilot init
    forgepilot migrate
    forgepilot goal create --id <goal-id> --title <title>
    forgepilot work add --goal <goal-id> --story specs/stories/<story>

Use the actual returned Work ID. Adding a Work Item makes it READY when
dependencies permit; only explicit execution authority permits forgepilot start.
ForgePilot local state, logs, candidate refs, and worktrees live under ignored
.forgepilot/. Do not hand-edit state files or commit them.

## Repository gate and candidate verification

make verify is the one canonical automated repository gate. It answers:

    Does the repository's automated verification pass?

ForgePilot records the candidate identity, Work Item association, command result,
log, currentness, and review eligibility. It answers:

    Which Work Item and exact commit or snapshot owns this result,
    and is that result current?

Run make verify before recording a verification, then use the matching
ForgePilot path:

    # committed implementation and clean worktree
    forgepilot verify <work-id>

    # intentionally uncommitted implementation or newly created Story
    forgepilot verify <work-id> --snapshot

A ForgePilot PASS is machine Evidence, not a Human Review request. Keep the
Work Item RUNNING while implementing, checking individual ACs, and re-running
verification; do not pause merely because an intermediate candidate passes.
After the final AC and Acceptance Evidence audit, environment evidence, final
diff, decisions, and residual-risk review are complete, submit the current
candidate once:

    forgepilot review request <work-id>

Commit mode verifies a clean committed HEAD in a detached worktree. Snapshot
mode captures staged, unstaged, tracked deletions, and non-ignored untracked
content into an immutable local Candidate. Its evidence records snapshot
identity, base revision, and ForgePilot-generated digest; it is not evidence for
the unchanged HEAD. Neither path authorizes a commit, and snapshot mode avoids a
spurious WIP commit.

Any behavior-changing candidate modification makes prior verification-current
stale: commit evidence is compared with HEAD and snapshot evidence with the
current Candidate digest. Rerun make verify and the appropriate ForgePilot
verification before another review request. Do not manually attach a dirty-tree
command result to a prior revision or copy a local PASS into ForgePilot state.

Human Review evaluates AC evidence, environment evidence, diff, decisions,
residual risk, and current ForgePilot evidence. A make verify PASS or
ForgePilot verification PASS only makes the candidate eligible for review; it
does not approve, complete, or release work. ForgePilot records decision-maker
identity as self-asserted metadata, so agents must not self-approve review.

## Gates

For an undefined or changed domain boundary, security policy, workspace access,
runtime isolation, task lifecycle, protocol compatibility, scope expansion, or
public API semantic change, stop the affected work and open a Gate:

    forgepilot gate open --work <work-id> \
      --question <question> --option <option-a> --option <option-b> \
      --reason <impact>

An open Gate blocks the Work Item. Do not resolve or cancel it merely to
proceed; a human decision must be recorded through the corresponding ForgePilot
command. A Story's text is not silently rewritten to evade the decision.

## Risk-driven readiness

ForgeFlowV2 risk signals are opt-in. Declare a Signal under the Story Risk
section only when the risk is in scope. Each declared signal requires exactly
one matching section and one Evidence AC. That AC must be an existing checkbox
AC and must map to the ordinary Acceptance Evidence table; there is no second
evidence system.

| Signal | Required section | Required declarations |
| --- | --- | --- |
| error-projection | Error Projection | Source failure; Public projection; Detail policy; Evidence AC |
| concurrency | Concurrency | Contended resource; Linearization point; Conflict outcome; Evidence AC |
| bounded-capacity | Capacity | Bounded resource; Limit; Saturation behavior; Failure projection; Evidence AC |
| retention-overflow | Retention and Overflow | Retained resource; Retention bound; Overflow policy; Recovery / observability; Evidence AC |

For example, a Story that needs concurrency declares Signal: concurrency and a
Concurrency section whose Evidence AC names an AC already present in the
Acceptance Evidence table. Do not add signal sections or evidence rows unless
the signal is explicitly declared.

## Historical evidence and migration material

verification.md and any retained ForgeFlow handoff are immutable historical
evidence, not mutable control state. They may record Story, recorded_at,
repository, candidate revision or snapshot identity, verification command, and
observed result. New evidence must not declare current, next, status, Gate, review, or
completion. Query ForgePilot instead.

Existing versioned evidence is preserved verbatim. Any legacy lifecycle wording
inside it is a dated observation of the original record, never a current-state
projection; do not retroactively edit the record to reconcile it. Record later
context through ForgePilot or a separately dated evidence record.

.scratch/ and the local Markdown tracker retain research, triage, and migration
history. Their Status, claimed, resolved, checkbox, and dependency notation are
not Work Item lifecycle signals and must never be synchronized with ForgePilot.
Planning documents describe dependencies and intended acceptance only; current
progress is not duplicated there.

## Representative control-plane validation

The migration is validated in an isolated repository with ForgePilot v0.2.1:

1. A committed candidate runs make verify, then forgepilot verify <work-id>,
   producing revision-bound PASS evidence and REVIEW eligibility.
2. A dirty candidate runs make verify, then forgepilot verify <work-id>
   --snapshot, producing SNAPSHOT evidence rather than evidence for HEAD.
3. A subsequent candidate modification makes the recorded verification stale;
   make verify and ForgePilot verification must run again.
4. An open ForgePilot Gate blocks the affected Work Item; Story text remains
   unchanged until a human records a decision.

The tests are governance validation, not AgentPort product behavior. Fresh
checkout verification still uses repository-declared dependencies only and
never depends on .forgepilot, local caches, credentials, or private files.
