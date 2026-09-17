SHELL := /bin/sh
.DEFAULT_GOAL := verify

.PHONY: verify verify-repository verify-dependencies verify-stories verify-toolchain

# Canonical local gate. External Linux evidence remains a separate required AC.
verify: verify-repository verify-toolchain verify-stories
	@pnpm run check

verify-repository:
	@/bin/sh scripts/verify-repository.sh

verify-toolchain:
	@/bin/sh scripts/verify-toolchain.sh

verify-dependencies: verify-toolchain
	@pnpm install --frozen-lockfile

verify-stories: verify-dependencies
	@pnpm exec praxisbound story check --ready
