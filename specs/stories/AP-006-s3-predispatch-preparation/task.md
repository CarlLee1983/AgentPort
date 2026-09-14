# AP-006 working notes

This file is optional planning only. ForgePilot owns current lifecycle, Gate,
verification, Human Review, and completion state.

1. Add schema v3 and compatibility tests while preserving every v2 execution and claim record.
2. Persist bounded Reference-bound observations and candidate data with durable candidate/cancel ordering.
3. Extend restart recovery without Runtime replay, terminal commit, or claim release.
4. Fold lifecycle into `agentport_get_task` and remove the preparation-only product tool.
5. Strengthen production no-dispatch tripwires and record S3-A-only verification limits.
