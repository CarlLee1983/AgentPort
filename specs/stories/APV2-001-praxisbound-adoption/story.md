# Story: APV2-001 PraxisBound adoption proof

## Goal

Adopt the smallest PraxisBound repository surface that proves AgentPort v2 can
carry an approved Story to the project's existing verification gate without
replacing its local-ticket workflow.

## Context

AgentPort v2 records decisions and build tickets under `.scratch/` and uses
`pnpm check` as its required verification command. PraxisBound requires an
agent guide, a Story surface, and a `make verify` entrypoint. Service-install
ticket 07 is the completed feature used to trace this adoption to real package
and lifecycle evidence.

## Classification

* Security sensitive: no
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: no
* push: no
* deploy: no

## Scope

### In Scope

* Add the PraxisBound-managed Story and guidance structure.
* Preserve AgentPort v2's existing project instructions while adding Story and
  verification-gate guidance.
* Expose `pnpm check` through `make verify`.
* Trace service-install package and lifecycle evidence to an Acceptance
  Evidence map.

### Out of Scope

* Replacing local `.scratch` tickets with another tracker.
* Changing AgentPort runtime, service-install behavior, dependencies, CI, or
  GitHub settings.
* Recording mutable lifecycle state in this Story.

## Inputs

* `AGENTS.md`
* `docs/agents/issue-tracker.md`
* `.scratch/service-install/issues/07-packaging-docs-acceptance.md`
* `package.json`

## Outputs

* A repository `make verify` gate that delegates to `pnpm check`.
* PraxisBound Story and guidance files that coexist with the local-ticket
  workflow.

## Rules

* R1: `make verify` must run the project's complete existing `pnpm check`
  gate and propagate its exit status.
* R2: Existing `/implement NN` resolution and local-ticket lifecycle rules
  remain authoritative for local tickets.
* R3: The Story describes approved intent and evidence; it does not claim or
  persist current lifecycle state.

## Expected Errors

* A missing Node or pnpm installation makes `make verify` fail through the
  existing project gate.
* A missing PraxisBound Story surface or verification target makes Doctor
  report a static adoption failure.

## Dependencies

* Node.js and pnpm as required by `package.json`.
* PraxisBound CLI 0.2.0 for static adoption checks.

## Constraints

* Preserve unrelated working-tree changes.
* Do not commit, push, deploy, or alter existing product behavior.
