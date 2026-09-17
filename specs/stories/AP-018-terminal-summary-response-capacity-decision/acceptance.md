# Acceptance Criteria

## Happy Path

* [ ] AC-01: the decision record is grounded in AP-017's current sanitized
      candidate evidence and names every compared serialization layer without
      copying raw summaries or treating a smaller inner layer as proof about an
      enclosing response.

## Business Rules

* [ ] AC-02: a human resolves the Work Item's ForgePilot Gate by selecting
      exactly one of the three declared contracts: capacity-safe cursor
      pagination at the uncompressed JSON-RPC body boundary, atomic
      `output_limit` at that boundary, or the existing structured payload as
      the 8 MiB authority with the enclosing body explicitly excluded.
* [ ] AC-03: accepted ADR-0005 and `docs/technical-design.md` state the exact
      authoritative layer, inclusive 8,388,608-byte limit, excluded transport
      layers, saturation behavior, complete Caller recovery, compatibility,
      privacy, rollback and follow-on implementation boundary selected by the
      resolved Gate.

## Failure Cases

* [ ] AC-04: the decision preserves authorization and cursor concealment,
      excludes private instruction and result content from Gate, ADR, audit,
      logs and sanitized evidence, and rejects truncation, omitted items,
      adapter-side post-cursor slicing or an ambiguous capacity verdict.

## Regression Requirements

* [ ] AC-05: this Work Item changes no product code, public tool/schema/code,
      page behavior, Task lifecycle, storage schema or Runtime behavior; the
      Story contract check and `make verify` pass on the same documentation
      candidate after the resolved decision is recorded.
* [ ] AC-06: Human Review checks the Gate resolution, ADR, technical-design
      diff, AP-017 evidence provenance, rollback consequences and remaining
      five-second Client outage, proxy/backpressure, Linux, G5, S6 and release
      gaps without approving a behavior change or capacity compliance claim.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | human | `AP-017 EV-074 and EV-075 plus node_modules/.cache/agentport-ap017/terminal-summary-capacity-*.json` | `current sanitized AP-017 record, Story and acceptance contract` | `all named layers and residual decisions are inspected; no raw private summary is copied or inferred away` |
| `AC-02` | human | `ForgePilot Gate resolution record for the AP-018 Work Item` | `three mutually exclusive options with compatibility, security, recovery and rollback impact` | `one human-selected contract is recorded and no agent self-resolves or cancels the Gate` |
| `AC-03` | human | `docs/adr/0005-terminal-summary-response-capacity.md and docs/technical-design.md` | `resolved Gate and AP-017 evidence` | `the documents agree on layer, inclusive limit, exclusions, saturation, recovery, compatibility, privacy, rollback and later behavior scope` |
| `AC-04` | human | `AP-018 final diff and ForgePilot Gate rationale` | `private AP-017 fixtures, authorized cursor semantics and all three considered options` | `no private content, concealment weakening, truncation, skipped cursor item or ambiguous verdict is introduced` |
| `AC-05` | command | `pnpm exec praxisbound story check --ready specs/stories/AP-018-terminal-summary-response-capacity-decision && make verify` | `same exact documentation candidate after Gate resolution; unchanged product sources` | `commands exit zero and product behavior remains unchanged` |
| `AC-06` | human | `ForgePilot Human Review record` | `current candidate, resolved Gate, accepted ADR, technical-design diff and explicit residual Issue 21 gaps` | `reviewer accepts or rejects the architecture evidence without inferring behavior implementation, G5, S6 or release readiness` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `limit` | `100` | preserve | `Gate option and capacity-contract documentation only` | `AC-02 and AC-03 human review` |
| `cursor` | `ap018-foreign-terminal-cursor` | reject | `no new product location; concealment requirement in ADR-0005` | `AC-04 final-diff review` |
| `task.result.summary` | `sanitized private-result sentinel identifier` | omit | `Gate rationale, ADR-0005, technical-design diff and verification output` | `AC-01 and AC-04 evidence review` |
| `result.structuredContent` | `sanitized byte count only` | preserve | `ADR-0005 decision rationale` | `AC-01 evidence review` |
| `result.content[0].text` | `sanitized byte count only` | preserve | `ADR-0005 decision rationale` | `AC-01 evidence review` |
| `jsonrpc.responseBody` | `sanitized byte count only` | preserve | `ADR-0005 decision rationale` | `AC-01 evidence review` |
| `error.code` | `output_limit` | reject | `product behavior in this architecture-only Work Item` | `AC-05 source and schema diff review` |
| `decision.evidence` | `raw terminal summary` | omit | `Gate, ADR, technical design, audit and logs` | `AC-04 final-diff review` |

## Verification Notes

This architecture Story authorizes decision recording, not implementation of an
option. While unresolved, its ForgePilot Gate blocks completion. After a human
resolution is recorded, capture it in ADR-0005 and the technical design, rerun
the declared commands, bind the exact snapshot through ForgePilot and request
Human Review. A separate execution Story is required for any product behavior
change.
