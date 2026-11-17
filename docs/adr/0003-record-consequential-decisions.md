# Record consequential decisions in the same PR

Status: Accepted by the project owner on 2026-11-17.

Corral already records some product decisions, but prose in a README or agent
instructions is easy to lose when implementation changes. We require a short
ADR in the same PR for consequential choices about architecture, product
boundaries or durable technology coupling. Each PR must reference an applicable
record or explain specifically why no ADR is needed. Keeping the choice
implicit was rejected because reviewers and future maintainers need its context;
requiring a new ADR for every change was rejected because routine fixes do not
create a new architectural decision.

Human review checks whether a record is needed and whether its reasoning is
sufficient. A dependency-free CI check validates record filenames, unique IDs,
substantive content and index links, preserving the existing concise format.
This catches mechanical drift but cannot detect an unrecorded decision or judge
its trade-offs. GitHub branch protection is an administrative setting outside
this change; adding the workflow alone does not make it a required merge gate.

See the [policy and index](README.md) for the record lifecycle and
[the approved design](../superpowers/specs/2026-11-17-portfolio-quality-design.md)
for the scope of this quality foundation.
