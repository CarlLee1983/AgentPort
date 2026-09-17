# Acceptance Criteria

## Happy Path

* [ ] AC-01: ADR-0006 to ADR-0009 each state the decision, rejected
      alternatives and a `Falsified if` condition naming the files it depends
      on, and `docs/technical-design.md` agrees with Story rules R1–R13.

## Business Rules

* [ ] AC-02: a human resolves the AP-020 ForgePilot Gate by accepting,
      amending or rejecting each of ADR-0006 to ADR-0009; no agent
      self-resolves the Gate or marks an ADR accepted.
* [ ] AC-03: the contract answers, in one table, which identity can read or
      write the SQLite database, credentials, launcher ledger, sockets,
      runtime-home and Workspaces, and the Runtime identity cannot read Caller
      token hashes, `cursorSecret`, `continuationEncryptionKey` or control the
      launcher.

## Failure Cases

* [ ] AC-04: the contract states that unobserved, stale, credential-missing,
      recovery-blocked or launcher-unreachable conditions never report
      execution-ready, and that submission in those states creates no Task.
* [ ] AC-05: no document claims Claude Code redistribution rights,
      subscription-credential support, shared-host support, cross-Agent
      isolation or origin proof from a checksum.

## Regression Requirements

* [ ] AC-06: this Work Item changes no product source, public tool, schema,
      Task lifecycle or storage; the Story check and `make verify` pass on the
      same documentation candidate.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | human | `docs/adr/0006-0009 and docs/technical-design.md diff` | `AP-020 Story rules R1–R13` | `every rule traces to an ADR or technical-design statement without contradiction` |
| `AC-02` | human | `ForgePilot Gate resolution record for the AP-020 Work Item` | `four proposed ADRs` | `each ADR has a human decision and status matches it` |
| `AC-03` | human | `docs/technical-design.md identity access table` | `R2, R4, R5, R9` | `Runtime identity has no path to Caller token hashes, protected keys or launcher control` |
| `AC-04` | human | `docs/technical-design.md readiness section` | `R10, R11` | `every non-ready condition maps to a level and reason code and rejects submission` |
| `AC-05` | human | `AP-020 final documentation diff` | `ADR-0007, ADR-0008, ADR-0009` | `no overclaimed license, credential, platform, isolation or provenance statement` |
| `AC-06` | command | `pnpm exec praxisbound story check --ready specs/stories/AP-020-linux-deployment-contract && make verify` | `documentation-only candidate` | `commands exit zero and product sources are unchanged` |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `caller.bearerToken` | `ap020-caller-token-sentinel` | omit | `agentport.json stores hash only; no logs or readiness output` | `AC-03 human review` |
| `runtime.anthropicApiKey` | `ap020-api-key-sentinel` | redact | `/etc/agentport/credentials only; readiness shows configured-unverified` | `AC-03 and AC-04 human review` |
| `agent.workspacePath` | `/var/agentport/workspaces/../../etc` | reject | `no Registry entry` | `AC-01 contract review of R12` |
| `release.archive` | `archive with mismatched SHA-256` | reject | `no staging or release directory` | `AC-05 contract review of R13` |
| `readiness.reason` | `ap020-api-key-sentinel` | omit | `admin socket, CLI output and logs` | `AC-04 human review` |

## Verification Notes

This architecture Story authorizes decision recording only. Installer, daemon
entrypoint, release workflow and CLI each require separately approved
execution Stories that cite R1–R13.
