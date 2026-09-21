# Engineering Practices

Practices are repeatable habits for working inside the existing protocol. They
guide implementation; they do not redefine Story authority, `make verify`, or
Human Review.

## Non-trivial business workflow

1. Identify input and expected output.
2. Identify business rules, external dependencies, and failure behavior.
3. Add or update behavior tests.
4. Run the canonical verification gate.

## Repair loop

1. Inspect failing evidence.
2. Identify whether the cause is implementation, test, fixture, or repository
   configuration.
3. Repair the root cause without weakening the approved Story.
4. Rerun the complete canonical gate.
