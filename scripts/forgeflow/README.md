# ForgeFlow verification dependency

story-check and LICENSE are unmodified copies from ForgeFlowV2 0.9.0,
revision 2e012222b6bb24eca1059285b91ffcfc074a3440 (clean source checkout).
This is a repository-owned development check, never an AgentPort runtime dependency.
make verify invokes it using /bin/sh; no external ForgeFlow installation is needed.

The Story templates and adoption marker come from the same snapshot, recorded
in specs/.forgeflow-adoption. The 0.9.0 bootstrap upgrade dry-run was reviewed
before selectively applying its managed template and marker changes. Repository-
owned AGENTS.md, guidance, domain documentation, Makefile, and AgentPort
scripts remain under AgentPort ownership; no destructive bootstrap was used.

For upgrades, inspect the official bootstrap upgrade dry-run and diff, preserve
repository-owned files, update this checker and MIT notice together, and validate
make verify against the new templates. The 0.9.0 checker also validates explicit
risk-signal contracts and their Evidence AC mapping; it does not execute AC
commands, project lifecycle state, or prove acceptance. The Makefile remains
canonical.
