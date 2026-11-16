# Task and inbox progression Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Reward task creation and manual inbox handling with local XP, progressive levels and badges.

**Architecture:** Store deduplicated reward events in SQLite, record them at successful API actions, expose a summary, and display it on Daily. Levels cost 100 × current level XP.

**Tech Stack:** Node SQLite, TypeScript, React, CSS.

**Spec:** docs/superpowers/specs/2026-11-16-gamification-design.md

## Global Constraints

No historical backfill, automated rewards, PR-specific rewards, runtime dependencies, streaks or rankings.

## Review Focus

Duplicate action, missing item, failed reply, automatic resolution, and existing entities: test API action paths and deduplication. Level boundaries and persistence: test stored events and thresholds.

### Task 1: Progression and integration

**Files:** `server/db.ts`, `server/api.ts`, `server/test/gamification.test.ts`, `API.md`.

- [ ] Write failing tests for deduplication, persistence, level boundaries and eligible action paths.
- [ ] Implement the reward table, summary and successful action hooks; document the endpoint.
- [ ] Run targeted tests.

### Task 2: Display and verification

**Files:** `web/src/api.ts`, `web/src/pages/Daily.tsx`, `web/src/styles.css`.

- [ ] Show level progress and earned/upcoming badges with accessible labels.
- [ ] Run all required checks and capture comparable fixture screenshots.
- [ ] Commit, push and open a PR with the verified screenshots.
