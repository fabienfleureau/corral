# Portfolio and Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Present Corral as a product with an inspectable architecture and a maintainable decision process.

**Architecture:** Preserve the application. Separate product introduction from reference material and explain existing integration boundaries. Add a dependency-free ADR check alongside existing verification commands.

**Tech Stack:** Markdown, Mermaid, Node 22 TypeScript, node:test, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-17-portfolio-quality-design.md`

## Global Constraints

- Keep Node's type-stripped TypeScript, React/Vite, plain CSS, SQLite, and existing runtime dependencies.
- Do not change application behavior, APIs, schema, agent prompts, or UI.
- Keep the current demo; no UI capture is needed for prose and CI.
- Do not choose a license or change GitHub branch protection.
- Preserve existing ADR links and substance; do not invent historical reasoning.

## Review Focus

- Legacy paragraph-only ADRs must remain valid (Task 2 fixture).
- Duplicate IDs under different slugs must fail (Task 2 fixture).
- Stale index links and unlisted records must fail (Task 2 fixture).
- Heading-only or comment-only records must fail (Task 2 fixture).
- CI can check structure but cannot judge the need for a decision record (Task 3 manual review).

### Task 1: Product and architecture documentation

**Files:** `README.md`, `docs/product-guide.md`, `docs/architecture.md`.

**Interfaces:** Produces the product entry point and source-linked reference pages consumed by Task 3.

- [x] Move the existing feature/configuration/CLI detail into the product guide and fix relative links.
- [x] Rewrite README around problem, outcome, demo, setup, limits, and documentation links.
- [x] Trace dispatch, capture, PR readiness, storage, Jira, and SSE through code and document them with a Mermaid diagram.
- [x] Review factual claims and relative links; run `git diff --check` (expected: no errors).

### Task 2: Decision policy and validator

**Files:** `docs/adr/README.md`, `docs/adr/template.md`, `docs/adr/0003-record-consequential-decisions.md`, `scripts/check-adr.ts`, `server/test/adr.test.ts`, `package.json`.

**Interfaces:** Export `checkAdrs(directory: string): string[]`; CLI exits 1 with diagnostics on invalid records and 0 on success. Produces `npm run check:adr` for Task 3.

- [x] Write filesystem fixture tests for valid legacy records, invalid names, zero and duplicate IDs, empty records, missing/stale index links, and CLI failure/success.
- [x] Run `node --test server/test/adr.test.ts` and observe failure because the validator is missing.
- [x] Implement the validator with Node built-ins and a direct-execution guard; ignore only index/template files.
- [x] Write policy, template, index and ADR 0003; add the package script.
- [x] Run the focused tests and `npm run check:adr` (expected: all pass).

### Task 3: Contribution workflow and delivery

**Files:** `CONTRIBUTING.md`, `AGENTS.md`, `.github/workflows/ci.yml`.

**Interfaces:** Consumes Task 1 documentation and Task 2 `npm run check:adr`.

- [x] Align agent and contributor rules: an ADR reference or a specific no-ADR explanation is mandatory in review.
- [x] Keep PR descriptions in the existing `pr-description` skill format and add read-only CI on PRs/main using Node 22 and official actions pinned to commits.
- [x] Manually check that the contribution rules do not imply semantic ADR enforcement or branch protection.
- [x] Run `npm test`, both TypeScript checks, `npm run build`, `npm run check:adr`, and `git diff --check` (expected: all pass).
- [x] Obtain a whole-branch independent review; fix material findings and rerun relevant checks.
Delivery: commit logical changes, push `docs/portfolio-quality`, open a PR, verify its body, and send the Corral completion report with handoff. The completion report records the resulting PR URL.

Execution is inline in the existing isolated worktree, as authorized by “Approuver et implémenter”.
