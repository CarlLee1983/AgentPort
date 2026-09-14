# AP-007 working notes

This file is optional planning only. ForgePilot owns current lifecycle, Gate,
verification, Human Review, and completion state.

1. Confirm AP-004 G1-L is DONE and Human-reviewed, then verify GATE-020 runtime-account
   OAuth storage and target preconditions without recording a secret.
2. Implement the bounded `src/runtime/claude/` Driver and controlled harness seam only.
3. Prove real structured result, native AskUserQuestion/answer/continuation, safe Session
   reference, active cancellation, and pure-waiting cancellation.
4. Prove worker credential isolation and end-to-end redaction; retain the no-production-dispatch tripwire.
5. Run `make verify` and real `test:claude`, preserve same-candidate sanitized evidence, then request Human Review.
