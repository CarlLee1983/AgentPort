# Engineering Principles

## Small coherent changes

Prefer the smallest coherent implementation that satisfies the approved Story.
Avoid unrelated cleanup unless it is required to complete the Story safely.

## Root cause over symptom suppression

Diagnose and repair the underlying cause of a failure. Do not weaken Stories,
acceptance criteria, tests, or static checks merely to obtain PASS.

## Explicit dependencies

Prefer visible dependencies and boundaries over hidden global state or
surprising coupling.

## Behavior-oriented testing

Test externally meaningful or contract-relevant behavior rather than incidental
implementation details.

## Avoid premature abstraction

Introduce shared abstraction only when a stable shared concept or behavior is
evident, not solely to remove trivial duplication.

## Preserve repository conventions

Established repository architecture and conventions take precedence over these
generic preferences unless an approved Story changes them. These principles are
not mechanical requirements unless a repository deliberately makes them so.
