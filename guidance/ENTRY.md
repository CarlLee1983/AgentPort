# Engineering Guidance

Guidance is durable repository and team knowledge for implementation judgment.
It is advisory: an approved Story defines product intent, `make verify` provides
deterministic evidence, and Human Review makes the final product, design, and
architecture decision.

1. Read the approved Story and acceptance criteria first.
2. Read this entry, then identify only the principles, decisions, and practices
   relevant to that Story.
3. Load only relevant files or sections; do not load the entire guidance
   collection by default.
4. Give specific, explicitly approved repository context precedence over generic
   guidance. Do not use guidance to add product requirements or override a Story.
5. Surface a real unresolved conflict to Human Review rather than inventing a
   resolution.

A passing `make verify` does not prove guidance compliance or design quality.
A repository may turn a rule into an executable check deliberately; until then,
guidance remains judgment for agents and Human Review.
