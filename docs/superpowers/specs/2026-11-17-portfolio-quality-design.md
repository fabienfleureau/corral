# Portfolio and engineering quality foundation

Status: approved by the human on 2026-11-17. Scope: portfolio and quality foundation.

## Intent

Corral is a personal dispatch-and-review product and a project its author can
present in job interviews. A visitor should understand the user problem, see the
working product, and follow evidence of engineering judgment into the code.
Documentation must describe what exists without claiming team readiness or
commercial maturity that the implementation does not provide.

## Approaches

1. **Portfolio and quality foundation (selected).** Rewrite the product entry
   point, explain the current architecture, and add contribution and CI checks.
   This makes the project easier to evaluate and keeps the documentation useful.
2. **Presentation only.** Improve the README and technical documentation without
   adding checks. Smaller, but future changes can bypass the documented process.
3. **Foundation plus code restructuring.** Also split large modules. This needs a
   separate diagnosis and multiple focused PRs to preserve existing behavior.

The human selected approach 1 and approved this design. The implementation
choices below follow the repository's existing conventions.

## Deliverables

- `README.md`: concise English product introduction, intended users, concrete
  workflow, existing demo GIF, key benefits, prerequisites and quickstart,
  honest deployment limits, and links into the documentation. Avoid a feature
  inventory at the top and unverified performance or productivity claims.
- `docs/product-guide.md`: preserve the current feature details, CLI examples,
  configuration reference, and roadmap while removing duplication with README.
- `docs/architecture.md`: a native Mermaid diagram and a source-linked account of
  browser/HTTP/SSE, dispatch, WorkerBackend/omnigent, capture, PR readiness,
  SQLite, and Jira ownership. Explain a dispatch-to-review flow, additive
  migrations, integration boundaries, and local authentication assumptions.
  Distinguish existing seams from modules that still combine responsibilities.
- `docs/adr/README.md` and `template.md`: index, numbering, lifecycle, criteria,
  and a short context/decision/reason format with optional consequences and
  alternatives. Preserve the substance and URLs of ADRs 0001 and 0002.
- Add a new ADR for the approved decision-recording policy. Do not invent
  historical alternatives or imply today's documentation was decided earlier.
  Describe existing architectural constraints in the architecture guide with
  source evidence rather than manufacture retrospective decisions.
- `CONTRIBUTING.md`: reproducible setup using `npm ci`, verification commands,
  expectations for architecture/API/prompt documentation, PR review, and a
  practical explanation of when an ADR is required.
- `AGENTS.md`: point to canonical guides and enforce the same ADR policy for
  agents. Preserve product decisions, integration seams, screenshot procedure,
  and the human merge requirement. Remove the duplicated fixture sentence.
- PR descriptions use the existing `pr-description` skill format. Include an
  ADR reference or a specific explanation of why this change needs none within
  that format. Per the owner's review feedback, do not add a repository PR template.
- `.github/workflows/ci.yml`: PR and main-branch checks with read-only repository
  permissions, Node 22, `npm ci`, tests, both TypeScript projects, build, and ADR
  validation. Use standard GitHub-hosted runners and no application credentials.
- A small dependency-free ADR validator, exposed as `npm run check:adr`, with
  focused tests for invalid filenames, duplicate numbers, missing index entries,
  and empty records. It accepts the existing concise ADR format; the index and
  template are not decision records.

## ADR policy and enforcement boundary

An ADR is required for a consequential decision that changes an architectural or
product boundary, introduces durable technology/storage coupling, or replaces a
settled decision where alternatives and consequences matter. Routine fixes,
copy changes, and mechanical refactors do not need a new record.

Each PR must identify the applicable ADR, add one when making such a decision,
or explain why no ADR is needed. Review checks the rationale. CI validates the
records' structure and index; it cannot decide whether an architectural choice
has been documented honestly or completely. This PR does not change GitHub
branch protection, so it does not claim CI is a required merge gate.

## Constraints and non-goals

Keep Node's type-stripped TypeScript, React/Vite, plain CSS, SQLite, and existing
runtime dependencies. Do not change application behavior, APIs, schema, agent
prompts, or UI. Keep the current demo; no UI capture is needed for prose and CI.
Do not choose a license, add badges claiming unverified CI results, or add team
authentication, deployment infrastructure, or a large lint/tooling stack.

## Validation and delivery

Read the resulting README as a first-time visitor and trace architecture claims
to implementation. Verify moved feature/configuration content and relative links.
Exercise the ADR validator with valid and invalid fixtures, then run `npm test`,
both `tsc --noEmit` commands, `npm run build`, and `npm run check:adr`.
Inspect the final diff, commit, push the task branch, open a reviewable PR,
and report its URL and handoff to Corral. Identify overlaps with open PRs if
GitHub access permits; explicitly disclose any inability to check them.

The first attempt to list open PRs hit the GitHub GraphQL rate limit. This does
not block drafting, implementation, or local validation; retry through an
available API before delivery and report a question only if delivery is blocked.
