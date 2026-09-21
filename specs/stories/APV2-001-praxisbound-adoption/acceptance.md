# Acceptance Criteria

## Happy Path

* [ ] AC-001: `make verify` delegates to the complete existing `pnpm check`
  gate and succeeds when that gate succeeds.
* [ ] AC-002: PraxisBound Doctor reports that the repository has the required
  agent guide, Story directory, and verification gate.

## Business Rules

* [ ] AC-003: `AGENTS.md` retains AgentPort v2's vocabulary, local-ticket
  resolution, canonical verification, real-CLI, and v1-reuse constraints while
  directing explicitly assigned Stories through PraxisBound's review flow.

## Failure Cases

* [ ] AC-004: A failure from `pnpm check` makes `make verify` return nonzero;
  the gate does not substitute a success result.

## Regression Requirements

* [ ] AC-005: The service-install package test still verifies argument
  forwarding to the packed CLI.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | command | `make verify` | `repository checkout with Node dependencies` | `complete pnpm check gate exits 0` |
| `AC-002` | command | `npx --yes @praxisbound/cli@0.2.0 doctor --json .` | `adopted repository root` | `JSON status is pass` |
| `AC-003` | human | `AGENTS.md review` | `original AgentPort v2 guide and installed PraxisBound guide` | `five project constraints remain explicit` |
| `AC-004` | human | `Makefile review` | `verify target` | `target invokes pnpm check directly with no success masking` |
| `AC-005` | test | `tests/cli/package.test.ts` | `Node dependencies installed` | `packed CLI argument test passes` |

## Verification Notes

This Story is the adoption proof, not a replacement for ticket 07. The macOS
lifecycle evidence is historical ticket evidence; any new product change needs
fresh verification under its own explicitly assigned Story.
