# Project Contract names Warrant

## Goal

The Project Contract section of `AGENTS.md` names the protocol this
repository actually follows and defers Story approval to the `## Warrant`
section, so the two sections no longer disagree about when a Story is
approved. Today the local-ticket bullet says "A PraxisBound Story supplies
approved product intent only when the human explicitly assigns one", which
contradicts the Warrant rule that a Story a human committed to the default
branch is also approved; and the verification bullet says `make verify`
delegates to `pnpm check` "so PraxisBound has one repository gate".

## Out of Scope

- Editing the `## Warrant` section, or any other Project Contract bullet.
- Changing which source selects work for an existing local ticket, which of
  Story and ticket controls acceptance, what happens on conflict, which
  command is canonical, or the rule against adding checks.
- Editing any file other than `AGENTS.md`. Historical mentions of PraxisBound
  in `specs/agentport-v2.md`, `.scratch/`, and the legacy
  `specs/stories/APV2-001-praxisbound-adoption/` directory stay as they are.
- Changing what `make verify` or `pnpm check` run.

## Acceptance Criteria

1. `grep -n PraxisBound AGENTS.md` prints nothing and exits 1.
2. In the local-ticket bullet, the sentence beginning "A PraxisBound Story"
   and ending "from a Story or handoff." is replaced by exactly:
   "A Warrant Story supplies approved product intent once it is approved under
   the Warrant section below, and only for the Story the human chose; it does
   not replace the local-ticket workflow or infer mutable status from a Story
   or handoff." (line wrapping may differ).
3. In the verification bullet, "so PraxisBound has one repository gate" is
   replaced by exactly "so Warrant has one declared verification command"
   (line wrapping may differ).
4. `git diff --stat origin/main` lists only `AGENTS.md`, and every changed line
   in `git diff origin/main -- AGENTS.md` lies within the two bullets above.
5. `make verify` passes.
