// Tests for CI failure auto-fix in the PR loop, observe-only PR risk triage
// (ADR 0019), and adversarial verification in review skill prompts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { MAX_CI_FIX_ATTEMPTS, syncTaskPr, type PrDelivery, type PrInfo } from "../pr.ts";
import { classifyPrTriage, loadRepoTriagePolicy, matchGlob, parsePrTriage } from "../pr-triage.ts";
import type { WorkerBackend, WorkerSession, WorkerStart } from "../worker.ts";
import type { Task } from "../types.ts";

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1", title: "Fix parser", prompt: "Fix parser", kind: "code", repo_path: "/tmp/repo",
    target: "claude", target_state: "suggested", base_branch: "main", branch: "fix/parser", worktree_path: null,
    assignee: null, jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null,
    status: "dispatched", terminal_address: "s1", exit_code: null, created_ms: now, updated_ms: now, ...over,
  };
}

function fakeBackend() {
  const sent: { address: string; text: string }[] = [];
  const backend = {
    name: "fake",
    async start(s: WorkerStart): Promise<WorkerSession> {
      return {
        address: "s2", task_id: s.taskId, name: s.name, harness: s.harness, status: "working",
        blocked_kind: null, state: "live", turn: 1, cwd: s.repoPath, created_ms: Date.now(), exit_code: null, parent: null,
      };
    },
    list: async () => [],
    get: async (address: string) => ({
      address, task_id: "task-1", name: "x", harness: "claude", status: "idle", blocked_kind: null,
      state: "live", turn: 1, cwd: "/tmp/repo", created_ms: Date.now(), exit_code: null, parent: null,
    }),
    read: async () => "",
    send: async (address: string, text: string) => { sent.push({ address, text }); },
    resolveElicitation: async () => undefined,
    kill: async () => undefined,
    history: async () => "",
    tree: async () => [],
    onEvent: () => ({ stop: () => undefined }),
  } as WorkerBackend;
  return { backend, sent };
}

const cfg = (dir: string) => ({ agents: { claude: {} }, configDir: dir, host: "127.0.0.1", port: 4787, token: "t" }) as never;

function basePr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    url: "https://github.com/example/repo/pull/99",
    title: "fix: parser edge case",
    state: "OPEN",
    number: 99,
    description: "Fixes edge case",
    additions: 24,
    deletions: 6,
    changed_files: 2,
    changed_file_paths: ["src/parser.ts", "src/parser.test.ts"],
    head_sha: "sha-1",
    mergeable: "MERGEABLE",
    base_ref: "main",
    review_decision: null,
    checks: { total: 2, failed: 1, pending: false },
    failed_checks: [{ name: "unit-tests", conclusion: "failure", url: "https://github.com/example/repo/actions/runs/1" }],
    threads: [],
    ...over,
  };
}

function withDb(fn: (db: Db, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-pr-ci-triage-"));
    const db = new Db(join(dir, "test.db"));
    try {
      await fn(db, dir);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const settle = () => new Promise((r) => setTimeout(r, 15));

test("PR loop: pushes failing CI checks once, bounds retries per SHA, and resets on new SHA or pass", withDb(async (db, dir) => {
  db.insertTask(makeTask({ repo_path: dir }));
  const hub = { broadcast: () => undefined };
  const { backend, sent } = fakeBackend();

  // While checks are still pending, do not auto-push.
  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => basePr({ checks: { total: 2, failed: 1, pending: true } }),
    backend, cfg: cfg(dir),
  });
  await settle();
  assert.equal(sent.length, 0, "waits for pending checks before auto-pushing");

  // Once settled with failure, pushes once.
  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => basePr(),
    backend, cfg: cfg(dir),
  });
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^PR failing checks need handling/);
  assert.ok(sent[0].text.includes("unit-tests (failure)"));

  // Same failure signature on same SHA is not pushed again.
  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => basePr(),
    backend, cfg: cfg(dir),
  });
  await settle();
  assert.equal(sent.length, 1);

  // Different failing check on same SHA counts as attempt 2 (allowed up to MAX_CI_FIX_ATTEMPTS).
  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => basePr({ failed_checks: [{ name: "lint", conclusion: "failure", url: null }] }),
    backend, cfg: cfg(dir),
  });
  await settle();
  assert.equal(sent.length, MAX_CI_FIX_ATTEMPTS);

  // Attempt 3 on the same SHA is suppressed automatically.
  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => basePr({ failed_checks: [{ name: "typecheck", conclusion: "failure", url: null }] }),
    backend, cfg: cfg(dir),
  });
  await settle();
  assert.equal(sent.length, MAX_CI_FIX_ATTEMPTS, "caps automatic CI retries per head SHA");

  // Force refresh overrides the cap and reports checks: true.
  const deliveries: PrDelivery[] = [];
  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => basePr({ failed_checks: [{ name: "typecheck", conclusion: "failure", url: null }] }),
    backend, cfg: cfg(dir), force: true, onDelivered: (d) => deliveries.push(d),
  });
  assert.equal(sent.length, MAX_CI_FIX_ATTEMPTS + 1);
  assert.deepEqual(deliveries, [{ address: "s1", comments: false, conflict: false, checks: true }]);

  // A new head SHA gets a fresh retry budget.
  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => basePr({ head_sha: "sha-2", failed_checks: [{ name: "unit-tests", conclusion: "failure", url: null }] }),
    backend, cfg: cfg(dir),
  });
  await settle();
  assert.equal(sent.length, MAX_CI_FIX_ATTEMPTS + 2);

  // Passing checks clear the stored CI failure state.
  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => basePr({ head_sha: "sha-2", checks: { total: 2, failed: 0, pending: false }, failed_checks: [] }),
    backend, cfg: cfg(dir),
  });
  const meta = JSON.parse(db.getTask("task-1")!.pr_meta ?? "{}") as { checks_pushed?: string; checks_attempts?: unknown };
  assert.equal(meta.checks_pushed, undefined);
  assert.equal(meta.checks_attempts, undefined);
}));

test("triage: glob matching and built-in default tiers", () => {
  assert.equal(matchGlob("docs/**", "docs/adr/0019.md"), true);
  assert.equal(matchGlob("**/db.*", "server/db.ts"), true);
  assert.equal(matchGlob("**/auth/**", "server/auth/session.ts"), true);
  assert.equal(matchGlob("**/*.md", "README.md"), true);
  assert.equal(matchGlob("docs/**", "server/pr.ts"), false);

  const docsOnly = classifyPrTriage({ additions: 20, deletions: 5, changed_files: 2, changed_file_paths: ["docs/guide.md", "README.md"] });
  assert.equal(docsOnly.tier, "routine");
  assert.equal(docsOnly.depth, "quick");
  assert.equal(docsOnly.mode, "observe");

  const smallCode = classifyPrTriage({ additions: 30, deletions: 10, changed_files: 2, changed_file_paths: ["src/util.ts", "src/util.test.ts"] });
  assert.equal(smallCode.tier, "routine");
  assert.equal(smallCode.depth, "standard");

  const highRisk = classifyPrTriage({ additions: 10, deletions: 2, changed_files: 1, changed_file_paths: ["server/db.ts"] });
  assert.equal(highRisk.tier, "deep");
  assert.equal(highRisk.depth, "deep");
  assert.match(highRisk.reasons[0], /server\/db\.ts/);

  const largeDiff = classifyPrTriage({ additions: 220, deletions: 40, changed_files: 4, changed_file_paths: ["src/a.ts"] });
  assert.equal(largeDiff.tier, "deep");
  assert.match(largeDiff.reasons[0], /large diff/);
});

test("triage: repo .corral/triage.json overrides defaults and falls back when malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-triage-policy-"));
  try {
    mkdirSync(join(dir, ".corral"), { recursive: true });
    writeFileSync(join(dir, ".corral", "triage.json"), JSON.stringify({
      deepPaths: ["billing/**"],
      maxRoutineLines: 50,
    }));
    const loaded = loadRepoTriagePolicy(dir);
    assert.equal(loaded.source, "policy");
    assert.deepEqual(loaded.policy.deepPaths, ["billing/**"]);
    assert.equal(loaded.policy.maxRoutineLines, 50);

    const billing = classifyPrTriage({ additions: 10, deletions: 0, changed_files: 1, changed_file_paths: ["billing/invoice.ts"] }, { repoPath: dir });
    assert.equal(billing.tier, "deep");
    assert.equal(billing.source, "policy");

    writeFileSync(join(dir, ".corral", "triage.json"), "{not valid json");
    assert.equal(loadRepoTriagePolicy(dir).source, "default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("triage: syncTaskPr persists observe-only triage on item and snapshot without blocking readiness", withDb(async (db, dir) => {
  db.insertTask(makeTask({ repo_path: dir }));
  const hub = { broadcast: () => undefined };
  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => basePr({
      checks: { total: 2, failed: 0, pending: false },
      failed_checks: [],
      changed_file_paths: ["server/db.ts"],
    }),
  });
  const item = db.listItems({ kind: "pr" })[0];
  assert.equal(item.ready, 1, "observe-only triage never blocks PR readiness");
  const triage = parsePrTriage(item.triage);
  assert.ok(triage);
  assert.equal(triage.tier, "deep");
  assert.equal(triage.mode, "observe");
  assert.match(item.body, /\| Review triage \| deep review \(observe\)/);
  const meta = JSON.parse(db.getTask("task-1")!.pr_meta ?? "{}") as { pr?: { triage?: { tier?: string } } };
  assert.equal(meta.pr?.triage?.tier, "deep");
}));

test("review skills include adversarial verification instructions", () => {
  const reviewSkill = readFileSync(join(process.cwd(), "skills", "review.md"), "utf8");
  const ocrSkill = readFileSync(join(process.cwd(), "skills", "ocr-delegate.md"), "utf8");
  assert.match(reviewSkill, /Adversarially verify/i);
  assert.match(reviewSkill, /disprove/i);
  assert.match(ocrSkill, /Adversarially verify/i);
  assert.match(ocrSkill, /disprove/i);
});
