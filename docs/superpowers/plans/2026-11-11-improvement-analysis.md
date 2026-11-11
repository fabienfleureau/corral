# Improvement Analysis Implementation Plan

**Goal:** Run a manual or scheduled evidence-based improvement analysis and deliver proposals to the inbox.

**Architecture:** A server service reads bounded task and lifecycle evidence, calls the configured assistant, and stores a digest. SQLite persists schedule and run state; the server checks for missed runs. Settings provides controls; the existing inbox displays results.

**Constraints:** No new dependencies, no automatic implementation or dispatch, scheduling defaults off, no invented outcomes, failures remain visible.

1. Add tests for evidence limits, schedule persistence, missed runs, concurrency and failures; implement the analysis service.
2. Expose authenticated status, run and schedule endpoints and start the scheduler.
3. Add settings controls, document the API, and run the project checks and screenshot procedure.
