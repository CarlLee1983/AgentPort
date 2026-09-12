#!/bin/sh
set -eu

# The initial gate needs only GNU Make and the POSIX shell/userland declared in
# docs/development-workflow.md. No Git metadata, developer state or network.
fail() {
  printf 'FAIL repository contract: %s\n' "$1" >&2
  exit 1
}

for file in \
  AGENTS.md CONTEXT.md Makefile \
  .node-version .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml \
  eslint.config.js tsconfig.json tsconfig.build.json \
  compatibility/claude-capabilities.ts compatibility/mcp-fixture.ts compatibility/sqlite-probe.ts \
  tests/claude-capabilities.test.ts tests/mcp-compatibility.test.ts tests/sqlite-compatibility.test.ts \
  scripts/verify-toolchain.sh docs/toolchain-compatibility.md \
  specs/stories/AP-001-toolchain-mcp-compatibility/verification.md \
  guidance/ENTRY.md guidance/PRINCIPLES.md guidance/DECISIONS.md guidance/PRACTICES.md \
  specs/.forgeflow-adoption \
  specs/stories/_template/story.md specs/stories/_template/acceptance.md specs/stories/_template/task.md \
  specs/stories/AP-001-toolchain-mcp-compatibility/story.md \
  specs/stories/AP-001-toolchain-mcp-compatibility/acceptance.md \
  specs/stories/AP-001-toolchain-mcp-compatibility/task.md \
  specs/stories/AP-002-platform-neutral-durable-admission/story.md \
  specs/stories/AP-002-platform-neutral-durable-admission/acceptance.md \
  specs/stories/AP-002-platform-neutral-durable-admission/task.md \
  docs/development-workflow.md docs/implementation-plan.md docs/technical-design.md \
  docs/agents/domain.md docs/agents/issue-tracker.md docs/agents/triage-labels.md \
  docs/adr/0001-external-observation-and-control.md \
  docs/adr/0002-task-records-survive-restart.md \
  docs/adr/0003-local-transactional-task-store.md \
  docs/adr/0004-linux-execution-macos-development.md \
  .scratch/README.md .scratch/agentport-v0-1/spec.md \
  .scratch/agentport-v0-1/issues/01-mcp-version-compatibility.md \
  scripts/forgeflow/story-check scripts/forgeflow/LICENSE scripts/forgeflow/README.md
do
  [ -f "$file" ] && [ ! -L "$file" ] && [ -s "$file" ] || fail "missing, empty or symlinked file: $file"
  # Refuse unresolved merge markers in the adopted contract and input docs.
  if grep -Eq '^(<<<<<<< |=======$|>>>>>>> )' "$file"; then
    fail "unresolved merge marker: $file"
  fi
done

for entry in ./*; do
  case "$entry" in
    ./GNUmakefile|./makefile) fail "$entry would override the canonical Makefile" ;;
  esac
done

grep -Eq '^version=[0-9]+\.[0-9]+\.[0-9]+$' specs/.forgeflow-adoption || fail 'invalid adoption version'
grep -Eq '^revision=([0-9a-f]{40}(-dirty)?|unknown)$' specs/.forgeflow-adoption || fail 'invalid adoption revision'

for script in scripts/verify-repository.sh scripts/forgeflow/story-check; do
  /bin/sh -n "$script" || fail "invalid shell syntax: $script"
done

printf 'PASS repository contract\n'
