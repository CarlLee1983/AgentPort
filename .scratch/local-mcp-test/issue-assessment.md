# Local MCP issue assessment

Scope: captured state in `.scratch/local-mcp-test/state`, the current
specification, scheduler/Git-summary implementation, and unit/MCP tests.  This
assessment intentionally omits prompt contents and any credential material.

## 1. Claude `permission_denied` followed by `completed`

**Reproduction / evidence.** Task `01M33B3NYKJ2MTHKWV8NCJ8YVA` is
`completed`, has one `hints.permission_denied` entry for `Write`, and its final
text says the requested write was not performed.  Its raw Claude result has
`subtype: "success"`, `terminal_reason: "completed"`, and one
`permission_denials[]` item.  The recorded fixture and
`tests/driver/claude/driver.test.ts` also deliberately exercise a denial
followed by a `completed` DriverEvent.

**Contract alignment.** Aligned.  The spec defines `permission_denied` as a
non-terminal Claude event and moves `running` to `completed` on the Driver's
`completed` event (spec §§115, 132, 141).  `src/driver/claude/events.ts`
maps `result.permission_denials[]` first, then maps a successful result to
`completed`; `src/scheduler.ts` accumulates the hint without changing the
terminal state.  `completed` therefore means that the runtime turn finished,
not that every requested side effect occurred.

**Disposition: document limitation; do not file a runtime defect.** The
observable state can be surprising to a caller that treats `completed` as
semantic success, but it is the present specified behavior.  The small
documentation/API-contract clarification should say that callers must inspect
non-authoritative `hints.permission_denied` when side-effect completion
matters.  No implementation fix is indicated.  Regression seam already exists:
the Claude permission-denied fixture plus the driver test, and
`tests/mcp/submit-task.test.ts` for persisted hints.

## 2. `diff_stat` includes pre-existing workspace untracked files

**Reproduction / evidence.** The first Claude task's `diff_stat` lists the
workspace `README.md` even though the task reports no write; the Codex task's
`diff_stat` lists `.gitignore`, `.ignore`, `README.md`, and the requested
result file.  The captured workspaces are subdirectories of this repository,
not independent Git roots.  `git -C workspace/codex status --short` resolves
to the repository root and reports the workspace/test tree as untracked.

**Contract alignment.** The implementation does exactly what the detailed
algorithm currently says: `src/git/summary.ts` captures only `HEAD`, then
appends every final `git status --porcelain --untracked-files=all -- .` path.
There is no baseline status snapshot, so it cannot distinguish a pre-existing
untracked path from a path created during the turn.  This is consistent with
the literal end-of-turn status procedure in spec §147, but conflicts with the
ordinary reading of a *turn* diff and makes a no-op task fail the test intent
expressed by `tests/mcp/git-summary.test.ts` (empty `diff_stat` when the driver
makes no changes).  Existing tests begin clean and therefore do not cover this
case.

**Disposition: file now.** This is a product-reporting defect at the Git
summary boundary, independent of either CLI.  Minimal fix: at `captureHead`
time also capture the workspace-scoped porcelain status; on completion append
only untracked paths absent from that baseline (and retain the existing
HEAD-based tracked diff).  Define the desired handling of pre-existing tracked
worktree edits separately, since the current HEAD comparison reports those as
well.  Regression seam: add a Git-summary unit test and an MCP integration
test that create an untracked file before submit, have the driver add a
different untracked file, and assert only the latter is appended.

## 3. Codex workspace contains `.gitignore` and `.ignore`, but JSONL names only the result file

**Reproduction / evidence.** After task `01M33B76HF16NBEJQC09NH4ZW1`, the
Codex workspace contains `.gitignore`, `.ignore`, `README.md`, and
`docs/codex-mcp-result.txt`.  Its raw Codex JSONL has exactly one `file_change`
item, for `docs/codex-mcp-result.txt`, followed by `turn.completed`.  The
workspace ignore files have the same generation-oriented content as the
repository-level ignore changes, but the repository-level files predate this
task (their modification time is the preceding day).  The capture has no
before/after filesystem manifest or process audit to identify their writer.

**Contract alignment.** Aligned with the raw-log contract: spec §119 says the
stored JSONL is unmodified CLI output, not AgentPort's inferred file inventory.
The Codex parser is not required to synthesize missing `file_change` entries.

**Disposition: insufficient attribution; do not file against Codex or
AgentPort yet.** The evidence establishes a filesystem/JSONL mismatch, not
that Codex created those files or that AgentPort dropped events.  Minimal
follow-up experiment: use a fresh standalone Git root with a recorded
pre-turn recursive manifest, run one Codex turn with external writers paused,
then compare the manifest to raw JSONL.  If reproducible, file it as a Codex
observability limitation; a product fix would be a separately opted-in
filesystem audit, not alteration of the canonical raw JSONL.  A regression
test belongs at an integration harness seam with a controlled fake Codex
stream and filesystem observer, not in the current parser fixture tests.

## Recommendations

1. File the Git-summary baseline issue, with the two pre-existing/new
   untracked-file regression cases.
2. Clarify public documentation that a Claude denial hint can coexist with a
   completed runtime turn; callers requiring a write must evaluate the hint and
   resulting workspace state.
3. Do not attribute the Codex ignore files or open a Codex defect from this
   capture alone; repeat under a clean, independently observed workspace.
