# AgentPort

## Development workflow

AgentPort uses PraxisBound 0.10.0 as its engineering protocol and ForgePilot
v0.2.1 as its mutable engineering control plane. Neither is an AgentPort runtime
dependency or product-domain authority.

The authority boundary is strict:

* story.md plus acceptance.md are the approved product intent and Acceptance
  Evidence authority.
* ForgePilot is the only authority for current Work Item, lifecycle, Gates,
  blockers, next action, verification-current, Human Review, and completion.
* task.md is optional working notes. verification.md or handoff material is
  optional immutable historical evidence. Neither can project current state.
* make verify is the canonical automated repository gate. ForgePilot records
  which candidate that command verified; it does not replace the command.

1. Read CONTEXT.md; while exploring, drafting a Story, or handling tickets,
   read the applicable domain docs and ADRs below.
2. Read the approved Story's story.md, every AC and Acceptance Evidence row in
   acceptance.md, then any optional task.md notes. Do not derive the active
   work from task notes, handoff, Story ordering, prior completed Stories, or
   Git history guesses. Use forgepilot status, forgepilot status --work
   <work-id> --summary, or forgepilot next.
3. Read guidance/ENTRY.md and load only relevant guidance. AgentPort domain
   docs and ADRs take precedence. If a Story conflicts with them, open a
   ForgePilot Gate; do not silently redesign the domain or Story.
4. Work only on an authorized ForgePilot Work Item. READY identifies a
   schedulable item; it is not by itself permission to start, modify, commit,
   push, deploy, resolve a Gate, or approve review.
5. Change behavior with appropriate tests. Do not manufacture tests for
   documentation-only or mechanical changes.
6. Run make verify. A pass answers only whether repository automation passes.
   It does not satisfy environment ACs, approve a Work Item, or complete review.
7. Record that result through ForgePilot using the candidate that was actually
   checked. A PASS records machine Evidence and leaves the Work Item RUNNING;
   it is not a request for Human Review. Continue implementation, focused
   checks, and re-verification without stopping after an intermediate PASS:

       # clean, committed implementation
       forgepilot verify <work-id>

       # intentional uncommitted working-tree implementation
       forgepilot verify <work-id> --snapshot

   Never attach dirty-tree results to an unchanged HEAD revision, and never
   force a commit merely to obtain verification. A behavior-changing change
   makes prior verification-current stale; rerun make verify and ForgePilot
   verification before Human Review. Only after the agent has checked every AC
   and Acceptance Evidence row, relevant environment evidence, final diff,
   documented decisions, residual risk, and a current candidate, submit the
   Work Item once:

       forgepilot review request <work-id>

   Do not change behavior after this request; re-verification returns the item
   to RUNNING and requires a new explicit request.
8. Only Human Review may approve or complete work. Coding agents must not
   self-approve, self-resolve, or self-cancel Gates to advance work.

For an undefined or changed domain boundary, security policy, workspace access,
runtime isolation, task lifecycle, protocol compatibility, scope expansion, or
public API semantic decision, stop affected work and open a ForgePilot Gate.
See docs/development-workflow.md for the exact lifecycle, candidate, risk
signal, and Gate rules.

When reporting, state changed files, behavior, make verify evidence,
ForgePilot candidate evidence, AC mapping, architecture impact, and unresolved
Gates or risks. Governance does not grant commit, push, publish, deploy, or
Human Review authority.

## Agent skills

### Issue tracker

建立、讀取或發布規格與票據時，使用本機 Markdown tracker；先讀
docs/agents/issue-tracker.md。

### Triage labels

分類票據或設定 triage 狀態時，依 docs/agents/triage-labels.md 的標籤映射。

### Domain docs

本專案採 single-context；探索程式或撰寫規格前，依
docs/agents/domain.md 讀取術語與相關決策。
