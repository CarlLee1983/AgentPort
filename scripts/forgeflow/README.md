# ForgeFlow verification dependency

`story-check` and `LICENSE` are unmodified copies from ForgeFlowV2 0.7.0,
revision `cb4bc97673ad3098a4689a1589e1f2c4b5175c63` (clean source checkout).
This is a repository-owned development check, never an AgentPort runtime dependency.
`make verify` invokes it using `/bin/sh`; no external ForgeFlow installation is needed.

The bootstrap-provided guidance and Story templates come from the same snapshot,
recorded in `specs/.forgeflow-adoption`. Bootstrap dry-run refused the existing
`AGENTS.md`; adoption used an empty staging directory and selective copying,
with a manual merge of the AgentPort agent guide. No force bootstrap was used.

For upgrades, inspect the official bootstrap dry-run and upgrade diff, preserve
repository-owned AGENTS/guidance, update this checker and MIT notice together,
and validate `make verify` against the new templates. Static structure checks
do not execute AC commands or prove acceptance. The Makefile remains canonical.
