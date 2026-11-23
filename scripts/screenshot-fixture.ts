import { Db } from "../server/db.ts";
import type { Favorite } from "../server/favorites.ts";
import { prItemBody, type PrInfo } from "../server/pr.ts";
import type { Pull } from "../server/pulls.ts";
import type { Item, Task } from "../server/types.ts";
import type { TaskEvent } from "../server/task-events.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Written by scripts/capture-screenshot.sh so the Markdown-path link has a file. */
export const SCREENSHOT_MARKDOWN_PATH = "/tmp/corral-screenshot-plan.md";

/** One favorite per context, plus more professional ones, to show the task form filter
 *  and (the OpenCode DeepSeek one) the peak-hours tag. */
export const screenshotFavorites: Favorite[] = [
  { name: "Careful review", harness: "claude", agent: "", model: "opus", reasoning: "high", context: "professional", review: "cubic" },
  { name: "Quick fix", harness: "codex", agent: "", model: "gpt-6.1-sol", reasoning: "low", context: "professional", review: "" },
  { name: "Bulk Go work", harness: "opencode", agent: "", model: "opencode-go/kimi-k3.1-pro", reasoning: "", context: "professional", review: "" },
  { name: "Cheap bulk", harness: "opencode", agent: "", model: "opencode-go/deepseek-v4.1-flash", reasoning: "", context: "professional", review: "" },
  { name: "Side project", harness: "opencode", agent: "", model: "opencode-go/claude-haiku-5-5", reasoning: "high", context: "personal", review: "" },
];

export function seedScreenshotData(db: Db): void {
  const rows: (Pick<Task, "id" | "title" | "status" | "target" | "model" | "reasoning" | "review"> & Partial<Pick<Task, "jira_key" | "jira_url" | "branch" | "pr_url">>)[] = [
    { id: "sample-open", title: "Improve search results", status: "open", target: "codex", model: "gpt-5.4", reasoning: "high" },
    { id: "sample-running", title: "Add keyboard navigation", status: "dispatched", target: "claude", model: null, reasoning: null, review: "cubic review --base main --json", jira_key: "EX-1234", jira_url: "https://jira.example.com/browse/EX-1234" },
    { id: "sample-done", title: "Update project documentation", status: "done", target: "codex", model: null, reasoning: null },
    // The task behind the "PR needs work" inbox item: the PR loop's escape
    // hatch (force refresh) lives on that row's detail pane.
    { id: "sample-pr-task", title: "fix(auth): refresh expired session tokens", status: "done", target: "claude", model: null, reasoning: null, branch: "fix/auth-refresh", pr_url: "https://gitlab.com/example/platform/-/merge_requests/29" },
    // The task behind the auto-captured question: its closing message carries
    // Markdown, which must render as prose and not as a raw code block.
    { id: "sample-stopped-task", title: "Investigate proposed KPI improvement", status: "dispatched", target: "claude", model: null, reasoning: null },
  ];
  const now = Date.UTC(2025, 0, 15, 12);
  rows.forEach((row, index) => db.insertTask({
    ...row,
    prompt: row.id === "sample-running" ? `${row.title}\n\nSpec: ${SCREENSHOT_MARKDOWN_PATH}` : row.title,
    repo_path: "/sample/example-project", target_state: "confirmed",
    base_branch: "main", branch: row.branch ?? null, worktree_path: null, assignee: null, jira_key: row.jira_key ?? null,
    jira_url: row.jira_url ?? null, jira_parent_key: null, pr_url: row.pr_url ?? null, pr_meta: null, terminal_address: null,
    exit_code: null, created_ms: now - index * 60000, updated_ms: now - index * 60000,
  }));
  seedMultiRepo(db, now);
  db.insertRepo({ id: "sample-work", name: "example-project", path: "/sample/example-project", jira_prefix: "EX", context: null, source: "manual", created_ms: now });
  db.insertRepo({ id: "sample-home", name: "side-project", path: "/sample/side-project", jira_prefix: null, context: "personal", source: "manual", created_ms: now });
  seedInboxItems(db, now);
  seedEpic(db, now);
  seedTaskHistory(db, now);
  seedPulls(db, now);
  seedKpis(db, now);
  seedAgentRuns(db, now);
}

/** The fixture has no worker, so seed the tracked terminals Corral would have
 *  recorded from session events: the in-progress badge reads their last status. */
function seedAgentRuns(db: Db, now: number): void {
  const runs = [
    { task_id: "sample-running", address: "fixture-session-running", agent: "claude", last_status: "working" },
    { task_id: "sample-spec", address: "fixture-session-stopped", agent: "claude", last_status: "idle" },
    { task_id: "sample-stopped-task", address: "fixture-session-stopped-2", agent: "claude", last_status: "idle" },
    { task_id: "sample-epic-EX-102", address: "fixture-session-blocked", agent: "codex", last_status: "blocked" },
  ];
  for (const run of runs) {
    db.updateTask(run.task_id, { terminal_address: run.address }, false);
    db.upsertTerminal({ ...run, name: null, last_turn: 3, updated_ms: now });
  }
}

/** Defined KPIs with a report, so the KPI page shows the two-column layout. */
export function seedKpis(db: Db, now: number): void {
  const settings = {
    name: "Weekly active reporters",
    definition: "Count distinct accounts that submitted a report during the week, UTC.",
    unit: "accounts", sources: "warehouse.reports, dashboard/activity",
    repoPath: "/sample/example-project", favorite: "Careful review",
    intervalHours: 24, context: "Exclude test accounts.",
    goal: { target: 1800, direction: "increase", deadline: "2025-06-30", why: "Reporting volume drives the quarterly renewal review." },
  };
  const report = {
    summary: "Reporting is steady week over week, but **mobile submissions dropped** in the latest window.\n\n- The events table has no device field\n- Weekend coverage is incomplete\n\nSee the [activity dashboard](https://example.com/activity) for the daily breakdown.",
    measurement: { value: 1420, from: "2025-01-06", to: "2025-01-13", sources: ["warehouse.reports", "[dashboard/activity](https://example.com/activity)"] },
    dataNeeds: ["Add a `device` field to mobile submission events; see the [event schema](https://example.com/schema)."],
    productQuestions: ["Should **trial accounts** count as reporters?"],
    proposals: [{ title: "Add device field to submission events", rationale: "Would explain the **mobile gap** and sharpen the weekly count:\n\n- Split mobile and desktop trends\n- Confirm the drop is real", evidence: "`dashboard/activity`, panel 3" }],
    memory: "Previous cycles confirmed the warehouse job completes by 06:00 UTC.\n\n- Keep that cut-off in mind for the next window",
    trajectory: { onTrack: "no", confidence: "medium", rationale: "Growth of about 20 accounts a week reaches roughly 1,900 only if the mobile gap closes; at the current pace the target lands in August." },
    goalReview: { verdict: "ambitious", rationale: "Needs +27% in six months; reachable only if mobile submissions recover." },
  };
  db.raw.prepare(`INSERT OR REPLACE INTO kpi_monitors
    (id, settings, run_state, report, report_ms, last_measurement, finished_ms)
    VALUES (?, ?, 'complete', ?, ?, ?, ?)`).run(
    "kpi-1", JSON.stringify(settings), JSON.stringify(report), now, JSON.stringify(report.measurement), now,
  );
  db.raw.prepare("UPDATE kpi_monitors SET goal_baseline = ? WHERE id = 'kpi-1'").run(JSON.stringify({ value: 1300, to: "2024-11-11" }));
  const weekly = [1300, 1315, 1340, 1332, 1360, 1371, 1388, 1395, 1410, 1420];
  weekly.forEach((value, index) => {
    const from = new Date(Date.UTC(2024, 10, 4) + index * 7 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(2024, 10, 11) + index * 7 * 86_400_000).toISOString().slice(0, 10);
    db.raw.prepare("INSERT OR REPLACE INTO kpi_measurements (kpi_id, from_day, to_day, value, sources, recorded_ms) VALUES ('kpi-1', ?, ?, ?, ?, ?)")
      .run(from, to, value, JSON.stringify(["warehouse.reports"]), now);
  });
  db.raw.prepare("INSERT OR REPLACE INTO kpi_monitors (id, settings) VALUES (?, ?)").run("kpi-2", JSON.stringify({
    name: "Median review time",
    definition: "Median hours from review request to first substantive review.",
    unit: "hours", sources: "", repoPath: "", favorite: "", intervalHours: 0, context: "",
  }));
}

/** A multi-repo spec with its plan waiting for approval, and a code task a
 *  previous plan created. */
/** One epic: a merged task, a PR ready, a task ready to launch (stacked), a blocked one and a killed ticket. */
export function seedEpic(db: Db, now = Date.UTC(2025, 0, 15, 12)): void {
  db.insertEpic({ id: "sample-epic", jira_key: "EX-100", title: "Widget sizes across the platform", description: "Design v1", error: null,
    favorite_name: "Careful review", repo_path: "/sample/example-project", synced_ms: now, created_ms: now - 86_400_000 });
  const rows: { key: string; title: string; status: Task["status"]; repo: string; branch?: string; pr?: string; jiraStatus?: string }[] = [
    { key: "EX-101", title: "Add a size field to the widget API", status: "done", repo: "/sample/example-project", branch: "feat/widget-size-api", pr: "https://gitlab.com/example/platform/-/merge_requests/31" },
    { key: "EX-102", title: "Store widget sizes", status: "dispatched", repo: "/sample/example-project", branch: "feat/widget-size-store", pr: "https://gitlab.com/example/platform/-/merge_requests/32" },
    { key: "EX-103", title: "Show the size in the console", status: "open", repo: "/sample/side-project" },
    { key: "EX-104", title: "Document widget sizes", status: "open", repo: "/sample/example-project" },
    { key: "EX-105", title: "Keep legacy size labels in sync", status: "open", repo: "/sample/example-project", jiraStatus: "Killed" },
  ];
  rows.forEach((r, i) => db.insertTask({
    id: `sample-epic-${r.key}`, title: `${r.key} ${r.title}`, prompt: r.title, repo_path: r.repo, target: "claude", target_state: "confirmed",
    base_branch: null, branch: r.branch ?? null, worktree_path: null, assignee: null, jira_key: r.key, jira_url: `https://jira.example.com/browse/${r.key}`,
    jira_parent_key: "EX-100", jira_status: r.jiraStatus ?? null, pr_url: r.pr ?? null, pr_meta: null, status: r.status, terminal_address: null, exit_code: null,
    created_ms: now - (10 - i) * 60_000, updated_ms: now - (10 - i) * 60_000, epic_id: "sample-epic",
  }));
  // A task created from the Epic page's request field: tracked on the Tasks
  // page, but it has no Jira ticket and must not appear on the epic board.
  db.insertTask({
    id: "sample-epic-request", title: "Draft a note on widget sizes", prompt: "Draft a note on widget sizes",
    repo_path: "/sample/example-project", target: "claude", target_state: "confirmed",
    base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: null,
    jira_url: null, jira_parent_key: null, jira_status: null, pr_url: null, pr_meta: null,
    status: "open", terminal_address: null, exit_code: null,
    created_ms: now - 30_000, updated_ms: now - 30_000, epic_id: "sample-epic",
  });
  db.replaceEpicLinks("sample-epic", [
    { task_key: "EX-102", blocked_by_key: "EX-101" },
    { task_key: "EX-105", blocked_by_key: "EX-101" },
    { task_key: "EX-103", blocked_by_key: "EX-102" },
    { task_key: "EX-104", blocked_by_key: "EX-103" },
  ]);
  const pr = (key: string, ready: number): Item => ({
    id: `sample-epic-pr-${key}`, kind: "pr", status: "open", title: `PR ${ready ? "ready for review" : "needs work"}: ${key}`, summary: ready ? "ready for review" : "checks pending", body: "", context: "",
    options: null, ready, handling: 0, source_ref: null, task_id: `sample-epic-${key}`, structured: 1, created_ms: now, updated_ms: now, resolved_ms: null, snooze_until_ms: null,
  });
  db.insertItem(pr("EX-102", 1));
  // The design changed after EX-102 started: it is impacted; EX-104 has a proposed amendment.
  db.insertDesign({ epic_id: "sample-epic", version: 1, body: "Widgets get a `size` field (small, medium, large).", reason: "Imported from Jira", author: "jira", created_ms: now - 86_400_000 });
  db.insertDesign({ epic_id: "sample-epic", version: 2, body: "Widgets get a numeric `size` in millimetres instead of named sizes.", reason: "Named sizes were too coarse", author: "human", created_ms: now - 3_600_000 });
  db.updateTask("sample-epic-EX-102", { design_version: 1 }, false);
  const amendmentItem: Item = {
    id: "sample-epic-amendment", kind: "amendment", status: "open", title: "Amend EX-104 Document widget sizes", summary: "Epic EX-100, design v2",
    body: "Document `size` as a number of millimetres, not small/medium/large. Update the examples and the API reference accordingly.", context: "", options: null, ready: 1, handling: 0,
    source_ref: null, task_id: "sample-epic-EX-104", structured: 1, created_ms: now, updated_ms: now, resolved_ms: null, snooze_until_ms: null,
  };
  db.insertItem(amendmentItem);
  db.insertAmendment({ id: "sample-amendment", epic_id: "sample-epic", task_id: "sample-epic-EX-104", design_version: 2, body: amendmentItem.body, status: "proposed", item_id: amendmentItem.id, created_ms: now });
}

export function seedMultiRepo(db: Db, now = Date.UTC(2025, 0, 15, 12)): void {
  const v1Contract = "`POST /v1/widgets` accepts `{size: \"s\" | \"m\" | \"l\"}` and returns it unchanged.\n\n### Delivery order\n\n`api-spec` first, then `core`.";
  const v1Subtasks = [
    { repo: "api-spec", title: "Add `size` to the Widget schema", prompt: "Add the `size` enum to `openapi.yaml` and bump the spec version." },
    { repo: "core", title: "Persist and return `size`", prompt: "Store `size` on widgets and return it from `POST /v1/widgets`." },
  ];
  const contract = "`POST /v1/widgets` accepts `{size: \"s\" | \"m\" | \"l\"}` with an optional `Idempotency-Key` header and returns it unchanged (`409` on key reuse with a different payload).\n\n### Delivery order\n\n`api-spec` first, then `core`.";
  const subtasks = [
    { repo: "api-spec", title: "Add `size` and `Idempotency-Key` to the Widget schema", prompt: "Add the `size` enum and `Idempotency-Key` header to `openapi.yaml` and bump the spec version." },
    { repo: "core", title: "Persist and return `size` with idempotency", prompt: "Store `size` on widgets, enforce `Idempotency-Key` on `POST /v1/widgets`, and return `409` on conflicting retries." },
  ];
  const base = {
    prompt: "Add a size to widgets", repo_path: "/sample/workspace", target: "claude", target_state: "confirmed" as const, base_branch: null,
    branch: null, worktree_path: null, assignee: null, jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null,
    terminal_address: null, exit_code: null, created_ms: now - 2 * 60_000, updated_ms: now - 2 * 60_000,
  };
  const v1Id = "sample-plan-rev-1";
  const v2Id = "sample-plan-rev-2";
  db.insertTask({
    ...base,
    id: "sample-spec",
    title: "Add a size to widgets",
    kind: "spec",
    status: "dispatched",
    model: null,
    reasoning: null,
    spec: JSON.stringify({ contract, subtasks, revision_id: v2Id, version: 2 }),
  });
  db.insertTask({ ...base, id: "sample-child", title: "Expose widget colors", kind: "code", status: "open", repo_path: "/sample/workspace/core", model: null, reasoning: null, parent_task_id: "sample-spec", created_ms: now - 3 * 60_000, updated_ms: now - 3 * 60_000 });
  const render = (c: string, subs: typeof subtasks) =>
    ["## Contract", "", c, "", "## Sub-tasks", "", ...subs.flatMap((s, i) => [`### ${i + 1}. ${s.title} — \`${s.repo}\``, "", s.prompt, ""])].join("\n").trimEnd();
  const v1Body = render(v1Contract, v1Subtasks);
  const body = render(contract, subtasks);
  db.insertPlanRevision({
    id: v1Id, task_id: "sample-spec", version: 1, title: "Add a size to widgets",
    contract: v1Contract, subtasks: v1Subtasks, markdown: v1Body, created_ms: now - 150_000,
  });
  db.insertPlanRevision({
    id: v2Id, task_id: "sample-spec", version: 2, title: "Add a size to widgets",
    contract, subtasks, markdown: body, created_ms: now - 90_000,
  });
  db.insertPlanReview({
    id: "sample-plan-review-1",
    task_id: "sample-spec",
    revision_id: v1Id,
    note: "Define retry behavior before splitting repo work.",
    comments: [{
      section: "Contract",
      repo: null,
      quote: '`POST /v1/widgets` accepts `{size: "s" | "m" | "l"}` and returns it unchanged.',
      body: "Require an optional Idempotency-Key header and return 409 on conflicting retries.",
    }],
    created_ms: now - 120_000,
  });
  db.insertItem({
    id: "sample-plan", kind: "plan", status: "open", title: "Add a size to widgets", summary: body, body, context: "", options: null,
    ready: 1, handling: 0, source_ref: null, task_id: "sample-spec", structured: 1,
    created_ms: now - 90_000, updated_ms: now - 90_000, resolved_ms: null, snooze_until_ms: null,
  });
}

/** The Pull Requests listing: what awaits the human (their own PRs, a requested
 *  review) plus colleagues' open PRs in the repos they can push to. */
export function seedPulls(db: Db, now = Date.UTC(2025, 0, 15, 12)): void {
  const minute = 60_000;
  const pulls: Pull[] = [
    {
      id: "https://github.com/example/project/pull/312", host: "github", number: 312, repo: "example/project",
      title: "feat(cli): add a --json flag to task history", author: "fabienf", isMine: true, awaitingMe: true,
      state: "open", url: "https://github.com/example/project/pull/312", color: "orange",
      reason: "checks running", updated_ms: now - 8 * minute,
    },
    {
      id: "https://github.com/example/project/pull/289", host: "github", number: 289, repo: "example/project",
      title: "fix(auth): refresh expired session tokens", author: "camille", isMine: false, awaitingMe: true,
      state: "open", url: "https://github.com/example/project/pull/289", color: "red",
      reason: "1 failing check", updated_ms: now - 24 * minute,
    },
    {
      id: "https://github.com/example/project/pull/303", host: "github", number: 303, repo: "example/project",
      title: "refactor(inbox): split the item pane into components", author: "thomas", isMine: false, awaitingMe: false,
      state: "open", url: "https://github.com/example/project/pull/303", color: "green",
      reason: "checks green, reviewed", updated_ms: now - 95 * minute,
    },
    {
      id: "https://gitlab.com/example/platform/-/merge_requests/31", host: "gitlab", number: 31, repo: "example/platform",
      title: "Draft: stream usage events instead of polling", author: "lea", isMine: false, awaitingMe: false,
      state: "draft", url: "https://gitlab.com/example/platform/-/merge_requests/31", color: "orange",
      reason: "draft", updated_ms: now - 3 * 60 * minute,
    },
    {
      id: "https://gitlab.com/example/platform/-/merge_requests/28", host: "gitlab", number: 28, repo: "example/platform",
      title: "chore(deps): bump the worker base image", author: "yuki", isMine: false, awaitingMe: false,
      state: "open", url: "https://gitlab.com/example/platform/-/merge_requests/28", color: "orange",
      reason: "2 unresolved review comments", updated_ms: now - 5 * 60 * minute,
    },
  ];
  db.raw.prepare("INSERT INTO pull_snapshot (id, fetched_ms, pulls) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET fetched_ms=excluded.fetched_ms, pulls=excluded.pulls")
    .run(now, JSON.stringify(pulls));
}

/** History for the tasks the inbox screenshots open: the dispatch timeline of
 *  the Jira-imported task (the one whose question is in the inbox) and the PR
 *  loop of the task behind the "PR needs work" row. */
export function seedTaskHistory(db: Db, now = Date.UTC(2025, 0, 15, 12)): void {
  const hour = 60 * 60_000;
  const events: { task: string; at: number; kind: TaskEvent["kind"]; message: string; data?: Record<string, unknown> }[] = [
    { task: "sample-running", at: now - 50 * hour, kind: "created", message: "Imported from Jira EX-1234", data: { source: "jira", key: "EX-1234", jira_status: "To Do" } },
    { task: "sample-running", at: now - 26 * hour, kind: "updated", message: "Model: sonnet", data: { field: "model", to: "sonnet" } },
    { task: "sample-running", at: now - 25 * hour, kind: "prompt", message: "Initial prompt sent to claude", data: { source: "dispatch", harness: "claude", model: "sonnet", reasoning: "high", chars: 1834, text: "Add keyboard navigation\n\nEvery list in the app is tab-navigable except the inbox: j/k should move the selection and enter should open the item." } },
    { task: "sample-running", at: now - 25 * hour, kind: "status", message: "Status: open → dispatched", data: { from: "open", to: "dispatched" } },
    { task: "sample-running", at: now - 25 * hour, kind: "session", message: "Worktree: /sample/example-project-worktrees/feat-keyboard-nav", data: { to: "/sample/example-project-worktrees/feat-keyboard-nav" } },
    { task: "sample-running", at: now - 25 * hour, kind: "jira", message: "Jira: To Do → In Progress", data: { from: "To Do", to: "In Progress" } },
    { task: "sample-running", at: now - 4 * hour, kind: "prompt", message: "Review comments sent to the agent (2)", data: { source: "pr-comments", threads: 2, pr: "https://github.com/example/project/pull/58" } },
    { task: "sample-running", at: now - 30_000, kind: "question", message: "Agent asked: Which keyboard shortcut should open the command palette?", data: { capture: "elicitation" } },
    { task: "sample-done", at: now - 47 * hour, kind: "created", message: "Task created", data: { source: "manual" } },
    { task: "sample-done", at: now - 46 * hour, kind: "status", message: "Status: open → dispatched", data: { from: "open", to: "dispatched" } },
    { task: "sample-done", at: now - 6 * hour, kind: "status", message: "Status: dispatched → done", data: { from: "dispatched", to: "done" } },
    { task: "sample-done", at: now - 5 * hour, kind: "prompt", message: "Merge conflicts sent to the agent (base main)", data: { source: "pr-conflict", base: "main", pr: "https://github.com/example/project/pull/57" } },
    { task: "sample-pr-task", at: now - 5 * hour, kind: "created", message: "Task created", data: { source: "manual" } },
    { task: "sample-pr-task", at: now - 4 * hour, kind: "pr", message: "PR linked: https://gitlab.com/example/platform/-/merge_requests/29", data: { to: "https://gitlab.com/example/platform/-/merge_requests/29" } },
    { task: "sample-pr-task", at: now - 3 * hour, kind: "pr", message: "PR no longer ready: 1 unresolved review comment, 1 failing check", data: { pr: "https://gitlab.com/example/platform/-/merge_requests/29" } },
  ];
  for (const event of events) {
    db.insertTaskEvent({
      task_id: event.task,
      ts: event.at,
      kind: event.kind,
      message: event.message,
      data: event.data ? JSON.stringify(event.data) : null,
    });
  }
}

/** Open inbox items: a ready PR, a PR still needing work, two questions — the
 *  last one from the Jira-imported task, so rows show ticket provenance. Plus,
 *  for the in-progress view, a PR item the agent is handling (merge conflicts)
 *  whose task has already reported done. */
export function seedInboxItems(db: Db, now = Date.UTC(2025, 0, 15, 12)): void {
  const pr = (overrides: Partial<PrInfo>): PrInfo => ({
    url: "https://github.com/example/project/pull/42",
    title: "feat(search): rank results by recency",
    state: "OPEN",
    number: 42,
    description: "## Why\n\nRecent results are buried under old but heavily linked ones.\n\n## What\n\nRank by recency and show why a result matched.",
    additions: 142,
    deletions: 38,
    changed_files: 6,
    mergeable: "MERGEABLE",
    base_ref: "main",
    review_decision: null,
    human_approvals: null,
    checks: { total: 3, failed: 0, pending: false },
    threads: [],
    ...overrides,
  });
  const items: Item[] = [
    {
      id: "sample-pr-ready",
      kind: "pr",
      status: "open",
      title: "PR ready for review: feat(search): rank results by recency",
      summary: "ready for review",
      body: prItemBody(pr({})),
      context: "",
      options: null,
      ready: 1,
      source_ref: null,
      task_id: null,
      structured: 1,
      created_ms: now - 20 * 60_000,
      updated_ms: now - 20 * 60_000,
      resolved_ms: null,
      snooze_until_ms: null,
    },
    {
      id: "sample-pr-work",
      kind: "pr",
      status: "open",
      title: "PR needs work: fix(auth): refresh expired session tokens",
      summary: "1 unresolved review comment, 1 failing check",
      body: prItemBody(pr({
        url: "https://gitlab.com/example/platform/-/merge_requests/29",
        title: "fix(auth): refresh expired session tokens",
        number: 29,
        description: "## Why\n\nLong-lived tabs lost their session after the access token expired.\n\n## What\n\nRefresh the token before the request and retry once on 401.",
        additions: 64,
        deletions: 12,
        changed_files: 3,
        checks: { total: 3, failed: 1, pending: false },
        threads: [{ id: "note-1", author: "reviewer", body: "Please cover the concurrent refresh case." }],
      })),
      context: "",
      options: null,
      ready: 0,
      source_ref: null,
      task_id: "sample-pr-task",
      structured: 1,
      created_ms: now - 3 * 60 * 60_000,
      updated_ms: now - 3 * 60 * 60_000,
      resolved_ms: null,
      snooze_until_ms: null,
    },
    {
      id: "sample-question",
      kind: "question",
      status: "open",
      title: "Which page size should the search endpoint default to?",
      summary: "",
      body: "Both clients paginate, but they disagree on the default.\n\n- `20` keeps the first response small.\n- `50` halves the number of round trips for bulk imports.\n\nThe endpoint is not public yet, so either default is cheap to change later.",
      context: "",
      options: JSON.stringify(["20", "50", "none"]),
      ready: 1,
      source_ref: null,
      task_id: null,
      structured: 1,
      created_ms: now - 26 * 60 * 60_000,
      updated_ms: now - 26 * 60 * 60_000,
      resolved_ms: null,
      snooze_until_ms: null,
    },
    {
      id: "sample-jira-question",
      kind: "question",
      status: "open",
      title: "Which keyboard shortcut should open the command palette?",
      summary: "",
      body: "Two shortcuts are already taken on this platform. Pick the one the new palette grabs.",
      context: "",
      options: JSON.stringify(["Cmd/Ctrl+K", "Cmd/Ctrl+Shift+P", "none"]),
      ready: 0,
      source_ref: null,
      task_id: "sample-running",
      structured: 1,
      created_ms: now - 30_000,
      updated_ms: now - 30_000,
      resolved_ms: null,
      snooze_until_ms: null,
    },
    {
      id: "sample-stopped-question",
      kind: "question",
      status: "open",
      title: "Agent stopped without reporting",
      summary: "",
      body: "**Evidence checks out** (fixture snapshot 2025-01-15T12:00Z): 30d = 202 failed / 3112.\n\n- Qovery-side failures explain most of the gap\n- The engine root cause is still unknown\n\nReview the [evidence](https://example.com/evidence) before replying.",
      context: "",
      options: null,
      ready: 1,
      source_ref: "fixture-session-stopped-2",
      task_id: "sample-stopped-task",
      structured: 0,
      created_ms: now - 10 * 60 * 60_000,
      updated_ms: now - 10 * 60 * 60_000,
      resolved_ms: null,
      snooze_until_ms: null,
    },
    {
      id: "sample-pr-rebase",
      kind: "pr",
      status: "open",
      title: "PR needs work: chore(ci): bump the release workflow to Node 22",
      summary: "merge conflicts",
      body: prItemBody(pr({
        url: "https://github.com/example/project/pull/57",
        title: "chore(ci): bump the release workflow to Node 22",
        number: 57,
        description: "## Why\n\nRelease builds still run on Node 20.\n\n## What\n\nMove the release job to Node 22.",
        additions: 9,
        deletions: 7,
        changed_files: 1,
        mergeable: "CONFLICTING",
        checks: { total: 2, failed: 0, pending: false },
      })),
      context: "",
      options: null,
      ready: 0,
      handling: 1,
      source_ref: null,
      task_id: "sample-done",
      structured: 1,
      created_ms: now - 45 * 60_000,
      updated_ms: now - 5 * 60_000,
      resolved_ms: null,
      snooze_until_ms: null,
    },
  ];
  for (const item of items) db.insertItem(item);
}

/** Synthetic Claude session logs so the Usage page has chart data in captures. */
export function seedScreenshotUsage(home: string): void {
  const models = [
    { id: "claude-opus-5-5", output: 18_000 },
    { id: "claude-sonnet-5-5", output: 32_000 },
    { id: "claude-haiku-5-5", output: 60_000 },
    { id: "claude-opus-4-7", output: 12_000 },
  ];
  const dir = join(home, ".claude", "projects", "corral-screenshot-fixture");
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const now = Date.now();
  for (let day = 6; day >= 0; day--) {
    for (const [mi, model] of models.entries()) {
      for (let call = 0; call < 2 + (day % 2); call++) {
        lines.push(JSON.stringify({
          type: "assistant",
          requestId: `fixture-${day}-${mi}-${call}`,
          cwd: "/sample/example-project",
          timestamp: new Date(now - day * 86_400_000 - call * 3_600_000).toISOString(),
          message: {
            id: `msg-${day}-${mi}-${call}`,
            model: model.id,
            usage: {
              input_tokens: 1_000 + call * 400,
              output_tokens: model.output + call * 1_000,
              cache_read_input_tokens: model.output * 2,
            },
          },
        }));
      }
    }
  }
  writeFileSync(join(dir, "usage.jsonl"), lines.join("\n") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dbPath, configPath] = process.argv.slice(2);
  if (!dbPath) throw new Error("Pass a new fixture database path");
  const db = new Db(dbPath);
  try { seedScreenshotData(db); } finally { db.close(); }
  if (configPath) {
    // The config lives at <home>/.config/corral/config.json; the usage scanner
    // reads the same temporary home through the server's HOME.
    seedScreenshotUsage(dirname(dirname(dirname(configPath))));
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, favorites: screenshotFavorites }, null, 2) + "\n");
  }
}
