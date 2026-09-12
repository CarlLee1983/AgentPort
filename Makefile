SHELL := /bin/sh
.DEFAULT_GOAL := verify

.PHONY: verify verify-repository verify-stories verify-toolchain

# Canonical local gate. External Linux evidence remains a separate required AC.
verify: verify-repository verify-stories verify-toolchain
	@pnpm install --frozen-lockfile
	@pnpm run check

verify-repository:
	@/bin/sh scripts/verify-repository.sh

verify-stories:
	@/bin/sh scripts/forgeflow/story-check --ready

verify-toolchain:
	@/bin/sh scripts/verify-toolchain.sh
