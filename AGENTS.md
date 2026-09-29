# AgentPort — Repository Agent Guide

## Project Contract

* Vocabulary: `CONTEXT.md`. Product specification: `specs/agentport-v2.md`.
* Decision maps and build tickets are local Markdown. Their fields and
  operations are defined in `docs/agents/issue-tracker.md`. `/implement NN`
  means `.scratch/service-install/issues/NN-*.md`; all tickets in
  `.scratch/agentport-v2-build/` are complete.
* For an existing local ticket, that ticket remains the source for its work
  selection and local lifecycle. A PraxisBound Story supplies approved product
  intent only when the human explicitly assigns one; it does not replace the
  local-ticket workflow or infer mutable status from a Story or handoff.
  When both are cited, the Story controls product intent and acceptance; the
  ticket is implementation context and lifecycle only. A conflict stops for
  Human Review rather than merging requirements or inferring approval.
* The canonical verification command is `pnpm check`. `make verify` delegates
  to it so PraxisBound has one repository gate; do not add checks to either
  command without an approved requirement.
* Real CLI tests require local authenticated `claude` and `codex` CLIs.
* v1 code lives in `../AgentPort`; only the Driver JSONL parsing and
  `loopback-server` may be moved here.

## Warrant

This repository follows Warrant. Work is bounded by human-approved intent and
proven by this repository's own verification.

**Verification command:** `make verify`

1. **Intent is approved by a human.** Work starts from a Story at
   `specs/stories/<slug>.md` with Goal, Out of Scope, and Acceptance Criteria.
   A Story is approved only when a human has committed it to the default
   branch, or has explicitly assigned it in the current session. When it is
   not committed and the human only asks you to implement it, ask once whether
   they approve it as written; only a yes counts. A Story you
   drafted or committed yourself is not approved: stop and wait. Approval is
   not a work queue; the human chooses which Story to do.
2. **Completion is proven by evidence.** Run the verification command above and
   repair failures until it passes; if the repair lies outside the Story, stop
   and report it. Map every acceptance criterion to a reproducible observation:
   the command you ran and its output, or the `file:line` you inspected. If no
   verification command is declared, report that and stop; do not choose
   checks yourself.
3. **The standard is not yours to change.** Do not change requirements, weaken
   or reinterpret acceptance criteria, delete or skip failing tests, edit the
   Story to fit the work, or widen scope. When work outside the Story is
   needed, stop and report it.

Finish with a completion report of three sections: (1) each acceptance
criterion → command run → observed result; (2) skipped or blocked checks;
(3) residual risks. If the verification command did not pass, or any criterion
lacks a passing observation, the report says **partial**, never done.

Directories under `specs/stories/` are legacy records, not pending work.
