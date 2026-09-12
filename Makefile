SHELL := /bin/sh
.DEFAULT_GOAL := verify

.PHONY: verify verify-repository verify-stories

# Canonical local gate. AP-001 adds real format/lint/typecheck/build/test layers
# here; unavailable product checks must not be represented by no-op PASS targets.
verify: verify-repository verify-stories

verify-repository:
	@/bin/sh scripts/verify-repository.sh

verify-stories:
	@/bin/sh scripts/forgeflow/story-check --ready
