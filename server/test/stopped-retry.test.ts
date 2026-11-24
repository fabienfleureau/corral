// Bounded automatic retries for dispatched tasks whose agent stopped without
// reporting (ADR 0016).
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { CaptureEngine, type CaptureEngineOptions } from "../capture.ts";
import {
  DEFAULT_STOPPED_RETRY,
  STOPPED_ESCALATED_METRIC,
  classifyStoppedRun,
  isFatalStopError,
  resolveStoppedRetryConfig,
  stoppedRetryDelayMs,
  stoppedRetryPrompt,
} from "../stopped-retry.ts";
import type { Config } from "../config.ts";
import type { JiraClient } from "../jira.ts";
import type { Task } from "../types.ts";
import type { WorkerBackend, WorkerEvent, WorkerRunOutcome, WorkerSession } from "../worker.ts";

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1",
    title: "Fix retry loop",
    prompt: "Fix retry loop",
    repo_path: "/tmp/repo",
    target: "claude",
    target_state: "suggested",
    base_branch: null,
    branch: null,
    worktree_path: null,
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    pr_url: null,
    pr_meta: null,
    status: "dispatched",
    terminal_address: "s1",
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    ...over,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setup(
  outcome: WorkerRunOutcome | null,
  opts: {
    task?: Partial<Task>;
    lastStatus?: string | null;
    engine?: CaptureEngineOptions;
    sendError?: Error | null;
  } = {},
) {
  const db = new Db(":memory:");
  db.insertTask(makeTask(opts.task));
  db.upsertTerminal({
    address: "s1",
    task_id: "task-1",
    name: null,
    agent: "claude",
    last_status: opts.lastStatus ?? "working",
    last_turn: 0,
    updated_ms: Date.now(),
  });
  let currentOutcome = outcome;
  let currentSendError = opts.sendError ?? null;
  const sent: string[] = [];
  const backend = {
    name: "fake",
    read: async () => "tail",
    send: async (_a: string, text: string) => {
      if (currentSendError) throw currentSendError;
      sent.push(text);
    },
    lastRunOutcome: async () => currentOutcome,
  } as unknown as WorkerBackend;
  const capture = new CaptureEngine(db, backend, { broadcast() {} }, null, null, {
    stoppedRetry: { maxAttempts: 2, delaysSec: [0.005, 0.005], silentStopAttempts: 1 },
    retryStallMs: 10,
    ...opts.engine,
  });
  const emit = (status: string, type: WorkerEvent["type"] = "status") =>
    capture.handleEvent({ type, address: "s1", task_id: "task-1", status });
  return {
    db,
    backend,
    capture,
    sent,
    emit,
    setOutcome: (o: WorkerRunOutcome | null) => { currentOutcome = o; },
    setSendError: (err: Error | null) => { currentSendError = err; },
    close: () => { capture.dispose(); db.close(); },
  };
}

test("fatal error classification distinguishes non-retryable auth/billing/model errors from transient ones", () => {
  for (const text of [
    "Pi model error: 402: Insufficient balance",
    "HTTP 401 Unauthorized",
    "Error 403: Forbidden",
    "invalid_api_key provided",
    "Quota exceeded for this billing account",
    "model_not_found: gpt-99",
    "maximum context length exceeded",
  ]) {
    assert.equal(isFatalStopError(text), true, `expected fatal: ${text}`);
    assert.equal(classifyStoppedRun("error", { kind: "error", text }), "fatal", text);
  }
  for (const text of [
    "HTTP 429 Too Many Requests",
    "503 Service Unavailable",
    "Request timed out after 30s",
    "ECONNRESET while streaming response",
    "Unexpected crash at line 402",
  ]) {
    assert.equal(isFatalStopError(text), false, `expected transient: ${text}`);
    assert.equal(classifyStoppedRun("error", { kind: "error", text }), "error", text);
  }
});

test("resolveStoppedRetryConfig applies defaults and clamps invalid values", () => {
  assert.deepEqual(resolveStoppedRetryConfig(undefined), DEFAULT_STOPPED_RETRY);
  assert.deepEqual(resolveStoppedRetryConfig({ maxAttempts: -3, delaysSec: [], silentStopAttempts: 99 }), {
    maxAttempts: 0,
    delaysSec: [15, 60],
    silentStopAttempts: 5,
  });
  assert.equal(stoppedRetryDelayMs({ maxAttempts: 3, delaysSec: [15, 60], silentStopAttempts: 1 }, "error", 0), 15_000);
  assert.equal(stoppedRetryDelayMs({ maxAttempts: 3, delaysSec: [15, 60], silentStopAttempts: 1 }, "error", 2), 60_000);
  assert.equal(stoppedRetryDelayMs({ maxAttempts: 3, delaysSec: [15, 60], silentStopAttempts: 1 }, "silent", 0), 15_000);
  assert.match(stoppedRetryPrompt("error", { kind: "error", text: "503" }, 1, 2), /automatic retry 1\/2/);
  assert.match(stoppedRetryPrompt("silent", { kind: "message", text: "hi" }, 1, 1), /automatic nudge 1\/1/);
});

test("fatal errors skip retries and escalate to inbox immediately", async () => {
  const env = setup({ kind: "error", text: "Pi model error: 402: Insufficient balance" });
  try {
    await env.emit("error");
    await wait(25);
    assert.equal(env.sent.length, 0, "no retry sent for fatal error");
    const item = env.db.openQuestionItemForTerminal("s1");
    assert.ok(item, "inbox item created immediately");
    assert.match(item.body, /The run failed\./);
    assert.doesNotMatch(item.body, /automatic retry/);
  } finally { env.close(); }
});

test("every escalation records the stopped-run marker, a reopened item included", async () => {
  const env = setup({ kind: "error", text: "401 Unauthorized" });
  const markers = () => env.db.raw
    .prepare("SELECT ref, data FROM metrics_events WHERE name = ? ORDER BY id")
    .all(STOPPED_ESCALATED_METRIC) as { ref: string; data: string }[];
  try {
    await env.emit("error");
    const item = env.db.openQuestionItemForTerminal("s1");
    assert.ok(item);
    assert.equal(markers().length, 1);
    assert.equal(markers()[0].ref, "task-1");
    assert.deepEqual(JSON.parse(markers()[0].data), { item_id: item.id, category: "fatal", attempts: 0, address: "s1" });

    env.db.updateItem(item.id, { status: "resolved", resolved_ms: Date.now() });
    env.db.recordMetric("item.replied", item.id, { address: "s1" });
    env.capture.resetStoppedRetries("s1");
    await env.emit("working");
    await env.emit("error");
    assert.equal(env.db.openQuestionItemForTerminal("s1")?.id, item.id, "the same item is reopened");
    assert.equal(markers().length, 2, "the reopen counts as a second escalation");
    assert.equal(
      (env.db.raw.prepare("SELECT COUNT(*) AS n FROM metrics_events WHERE name = 'item.created'").get() as { n: number }).n,
      1,
      "item.created alone misses the reopen",
    );
  } finally { env.close(); }
});

test("transient errors retry up to maxAttempts then escalate to inbox", async () => {
  const env = setup({ kind: "error", text: "503 Service Unavailable" });
  try {
    // 1st stop -> auto-retry 1/2
    await env.emit("error");
    assert.equal(env.db.openQuestionItemForTerminal("s1"), null, "waiting for backoff before retry 1");
    await wait(25);
    assert.equal(env.sent.length, 1);
    assert.match(env.sent[0], /automatic retry 1\/2/);
    assert.equal(env.db.openQuestionItemForTerminal("s1"), null);

    // Agent resumes then fails a 2nd time -> auto-retry 2/2
    await env.emit("working");
    await env.emit("error");
    await wait(25);
    assert.equal(env.sent.length, 2);
    assert.match(env.sent[1], /automatic retry 2\/2/);
    assert.equal(env.db.openQuestionItemForTerminal("s1"), null);

    // Agent resumes then fails a 3rd time -> budget exhausted -> inbox
    await env.emit("working");
    await env.emit("error");
    const item = env.db.openQuestionItemForTerminal("s1");
    assert.ok(item, "escalated to inbox after 2 retries");
    assert.match(item.body, /after 2 automatic retries/);
    assert.match(item.body, /503 Service Unavailable/);
    assert.equal(env.sent.length, 2, "no third retry sent");

    const events = env.db.listTaskEvents("task-1");
    assert.equal(events.filter((ev) => ev.kind === "prompt" && ev.message.includes("Auto-retry")).length, 2);
  } finally { env.close(); }
});

test("silent stop gets one automatic nudge then escalates to inbox", async () => {
  const env = setup({ kind: "message", text: "I finished editing the files." });
  try {
    // 1st silent stop on status=done (omnigent waiting) -> auto-nudge 1/1
    await env.emit("done");
    await wait(25);
    assert.equal(env.sent.length, 1);
    assert.match(env.sent[0], /automatic nudge 1\/1/);
    assert.equal(env.db.openQuestionItemForTerminal("s1"), null);

    // Still stops without reporting -> inbox
    await env.emit("working");
    await env.emit("done");
    const item = env.db.openQuestionItemForTerminal("s1");
    assert.ok(item, "escalated to inbox after 1 silent nudge");
    assert.match(item.body, /after 1 automatic nudge/);
    assert.match(item.body, /I finished editing the files/);
  } finally { env.close(); }
});

test("mid-run crash (lastRunOutcome === null) retries then escalates to inbox", async () => {
  const env = setup(null, { engine: { stoppedRetry: { maxAttempts: 1, delaysSec: [0.005], silentStopAttempts: 1 } } });
  try {
    await env.emit("idle");
    await wait(25);
    assert.equal(env.sent.length, 1);
    assert.match(env.sent[0], /automatic retry 1\/1/);

    await env.emit("working");
    await env.emit("idle");
    const item = env.db.openQuestionItemForTerminal("s1");
    assert.ok(item);
    assert.match(item.title, /stopped unexpectedly/i);
    assert.match(item.body, /after 1 automatic retry/);
  } finally { env.close(); }
});

test("pending retry is cancelled if the session resumes working or reports before the timer fires", async () => {
  const env = setup(
    { kind: "error", text: "503 Service Unavailable" },
    { engine: { stoppedRetry: { maxAttempts: 2, delaysSec: [0.05], silentStopAttempts: 1 } } },
  );
  try {
    await env.emit("error");
    await env.emit("working");
    await wait(80);
    assert.equal(env.sent.length, 0, "resuming working cancels the scheduled retry");

    await env.emit("error");
    await env.capture.createStructuredQuestion({
      kind: "question",
      taskId: "task-1",
      terminal: "s1",
      title: "Need input",
      body: "Which database?",
    });
    await wait(80);
    assert.equal(env.sent.length, 0, "reporting a question cancels the scheduled retry");
  } finally { env.close(); }
});

test("resetStoppedRetries starts a fresh retry episode after human intervention", async () => {
  const env = setup(
    { kind: "error", text: "503 Service Unavailable" },
    { engine: { stoppedRetry: { maxAttempts: 1, delaysSec: [0.005], silentStopAttempts: 0 } } },
  );
  try {
    await env.emit("error");
    await wait(25);
    assert.equal(env.sent.length, 1);

    await env.emit("working");
    await env.emit("error");
    const item = env.db.openQuestionItemForTerminal("s1");
    assert.ok(item, "budget spent -> inbox");

    // Human replies: resolve item + reset retry episode.
    env.db.updateItem(item.id, { status: "resolved", resolved_ms: Date.now() });
    env.db.recordMetric("item.replied", item.id, { address: "s1" });
    env.capture.resetStoppedRetries("s1");

    await env.emit("working");
    await env.emit("error");
    await wait(25);
    assert.equal(env.sent.length, 2, "fresh episode gets its retry budget back");
    assert.equal(env.db.openQuestionItemForTerminal("s1"), null);
  } finally { env.close(); }
});

test("retry budget persists across CaptureEngine restarts and picks up stops after an answered question", async () => {
  const env = setup(
    { kind: "error", text: "503 Service Unavailable" },
    { engine: { stoppedRetry: { maxAttempts: 1, delaysSec: [0.005], silentStopAttempts: 0 } } },
  );
  try {
    // Exhaust the 1 retry in the first engine instance.
    await env.emit("error");
    await wait(25);
    assert.equal(env.sent.length, 1);
    env.capture.dispose();

    // Simulate an earlier answered question on the same session before restart.
    env.db.insertItem({
      id: "q-prev",
      kind: "question",
      status: "resolved",
      title: "Earlier question",
      summary: "",
      body: "Earlier?\n\n**Reply:** Yes",
      context: "",
      options: null,
      ready: 1,
      source_ref: "s1",
      task_id: "task-1",
      structured: 1,
      created_ms: 1,
      updated_ms: 1,
      resolved_ms: 2,
      snooze_until_ms: null,
    });
    // Record reply BEFORE the retry metric? No, the retry already happened, so
    // only mark the item as replied at an older id by checking a fresh engine
    // without adding a newer item.replied metric: insert a fresh engine directly.
    const restarted = new CaptureEngine(env.db, env.backend, { broadcast() {} }, null, null, {
      stoppedRetry: { maxAttempts: 1, delaysSec: [0.005], silentStopAttempts: 0 },
    });
    try {
      // First sight after restart sees status=error again (from working -> error or created).
      await restarted.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "working" });
      await restarted.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "error" });
      assert.equal(env.sent.length, 1, "restarted engine does not exceed persisted retry budget");
      assert.ok(env.db.openQuestionItemForTerminal("s1"), "escalates straight to inbox");
    } finally { restarted.dispose(); }
  } finally { env.close(); }
});

test("restart picks up a stopped session when its prior question was answered (not dismissed)", async () => {
  const env = setup(
    { kind: "error", text: "Pi model error: 402: Insufficient balance" },
    { lastStatus: "idle" },
  );
  try {
    env.db.insertItem({
      id: "q-answered",
      kind: "question",
      status: "resolved",
      title: "Earlier question",
      summary: "",
      body: "Earlier?\n\n**Reply:** Go ahead",
      context: "",
      options: null,
      ready: 1,
      source_ref: "s1",
      task_id: "task-1",
      structured: 1,
      created_ms: 1,
      updated_ms: 1,
      resolved_ms: 2,
      snooze_until_ms: null,
    });
    env.db.recordMetric("item.replied", "q-answered", { address: "s1" });
    await env.emit("idle", "created");
    const item = env.db.openQuestionItemForTerminal("s1");
    assert.ok(item, "a stop after an answered question is not mistaken for a dismissed stop");
    assert.match(item.body, /Insufficient balance/);
  } finally { env.close(); }
});

test("failed retry delivery escalates to inbox immediately", async () => {
  const env = setup(
    { kind: "error", text: "503 Service Unavailable" },
    { sendError: new Error("session gone") },
  );
  try {
    await env.emit("error");
    await wait(25);
    const item = env.db.openQuestionItemForTerminal("s1");
    assert.ok(item, "escalated when backend.send failed");
    assert.match(item.body, /Automatic retry could not be delivered: session gone/);
  } finally { env.close(); }
});

test("a session that stays stopped after an auto-retry escalates after the stall window", async () => {
  const env = setup(
    { kind: "error", text: "503 Service Unavailable" },
    { engine: { stoppedRetry: { maxAttempts: 1, delaysSec: [0.005], silentStopAttempts: 0 }, retryStallMs: 15 } },
  );
  try {
    await env.emit("error");
    await wait(25);
    assert.equal(env.sent.length, 1);
    // Still error without ever seeing working: after stall window, next poll escalates.
    await wait(25);
    await env.emit("error");
    const item = env.db.openQuestionItemForTerminal("s1");
    assert.ok(item, "escalated even though session never transitioned back to working");
    assert.match(item.body, /after 1 automatic retry/);
  } finally { env.close(); }
});

function fakeSession(over: Partial<WorkerSession> = {}): WorkerSession {
  return {
    address: "s1",
    task_id: "task-1",
    name: "corral-test",
    harness: "claude",
    status: "done",
    blocked_kind: null,
    state: "live",
    turn: 1,
    cwd: "/tmp/repo",
    created_ms: Date.now(),
    exit_code: null,
    parent: null,
    ...over,
  };
}

test("delayed retry does not send or revive when session is archived in backend before timer fires", async () => {
  const env = setup({ kind: "message", text: "All done." }, {
    engine: { stoppedRetry: { maxAttempts: 1, delaysSec: [0.015], silentStopAttempts: 1 } },
  });
  let session: WorkerSession | null = fakeSession({ state: "live", status: "done" });
  (env.backend as { get: WorkerBackend["get"] }).get = async () => session;
  try {
    await env.emit("done");
    session = fakeSession({ state: "finished", status: "done" });
    await wait(40);
    assert.equal(env.sent.length, 0, "no nudge sent to archived session");
    assert.equal(env.db.metricSummary().find((m) => m.name === "task.stopped_retry"), undefined);
    assert.equal(env.db.openQuestionItemForTerminal("s1"), null);
  } finally { env.close(); }
});

test("stop event on an already-archived backend session does not retry or escalate", async () => {
  const env = setup({ kind: "message", text: "All done." }, {
    engine: { stoppedRetry: { maxAttempts: 0, delaysSec: [0.005], silentStopAttempts: 0 } },
  });
  (env.backend as { get: WorkerBackend["get"] }).get = async () => fakeSession({ state: "finished", status: "done" });
  try {
    await env.emit("done");
    await wait(25);
    assert.equal(env.sent.length, 0);
    assert.equal(env.db.openQuestionItemForTerminal("s1"), null);
  } finally { env.close(); }
});

test("delayed retry does not send or escalate when session was deleted (404) before timer fires", async () => {
  const env = setup({ kind: "message", text: "All done." }, {
    engine: { stoppedRetry: { maxAttempts: 1, delaysSec: [0.015], silentStopAttempts: 1 } },
  });
  let session: WorkerSession | null = fakeSession({ state: "live", status: "done" });
  (env.backend as { get: WorkerBackend["get"] }).get = async () => session;
  try {
    await env.emit("done");
    session = null;
    await wait(40);
    assert.equal(env.sent.length, 0, "no nudge sent to deleted session");
    assert.equal(env.db.metricSummary().find((m) => m.name === "task.stopped_retry"), undefined);
    assert.equal(env.db.openQuestionItemForTerminal("s1"), null);
  } finally { env.close(); }
});

test("archived task ignores blocked, idle, and done worker events", async () => {
  const env = setup({ kind: "message", text: "All done." }, {
    task: { status: "archived" },
    engine: { stoppedRetry: { maxAttempts: 1, delaysSec: [0.005], silentStopAttempts: 1 } },
  });
  try {
    await env.capture.handleEvent({
      type: "status",
      address: "s1",
      task_id: "task-1",
      status: "blocked",
      elicitations: [{ id: "el-1", kind: "permission", prompt: "Allow?", choices: ["yes"] }],
    });
    await env.emit("idle");
    await env.emit("done");
    await wait(25);
    assert.equal(env.sent.length, 0);
    assert.equal(env.db.listItems({ kind: "question" }).length, 0);
  } finally { env.close(); }
});

test("archived inbox question and done-to-idle decay do not re-nudge on restart or status poll", async () => {
  const env = setup({ kind: "message", text: "Finished." }, {
    lastStatus: "done",
    engine: { stoppedRetry: { maxAttempts: 1, delaysSec: [0.005], silentStopAttempts: 1 } },
  });
  try {
    env.db.insertItem({
      id: "q-archived",
      kind: "question",
      status: "archived",
      title: "Stopped",
      summary: "",
      body: "Stopped",
      context: "",
      options: null,
      ready: 1,
      source_ref: "s1",
      task_id: "task-1",
      structured: 0,
      created_ms: 1,
      updated_ms: 1,
      resolved_ms: 2,
      snooze_until_ms: null,
    });
    // Server restart ("created" with status="done") must respect archived question item.
    await env.emit("done", "created");
    await wait(25);
    assert.equal(env.sent.length, 0, "restart does not nudge after archived question");
    assert.equal(env.db.openQuestionItemForTerminal("s1"), null);

    // Waiting ("done") decaying to "idle" without running a new turn must not nudge.
    await env.emit("idle", "status");
    await wait(25);
    assert.equal(env.sent.length, 0, "done -> idle decay does not nudge");
    assert.equal(env.db.openQuestionItemForTerminal("s1"), null);
  } finally { env.close(); }
});

test("archive-session cancels in-flight delayed retries even when backend.archive is slow, and clears guard on failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-archive-race-"));
  const db = new Db(join(dir, "test.db"));
  db.insertTask(makeTask({ status: "dispatched", terminal_address: "s1" }));
  db.upsertTerminal({ address: "s1", task_id: "task-1", name: null, agent: "claude", last_status: "working", last_turn: 1, updated_ms: Date.now() });

  const sent: string[] = [];
  let releaseArchive!: () => void;
  let markArchiveStarted!: () => void;
  const archiveStarted = new Promise<void>((resolve) => { markArchiveStarted = resolve; });
  let failArchive = false;
  const backend = {
    name: "fake",
    read: async () => "tail",
    get: async () => fakeSession({ state: "live", status: "done" }),
    send: async (_a: string, text: string) => { sent.push(text); },
    lastRunOutcome: async () => ({ kind: "message" as const, text: "Finished." }),
    archive: async () => {
      if (failArchive) throw new Error("archive unavailable");
      markArchiveStarted();
      await new Promise<void>((resolve) => { releaseArchive = resolve; });
    },
  } as unknown as WorkerBackend;
  const hub = { broadcast: () => undefined, clients: new Set() };
  const capture = new CaptureEngine(db, backend, hub, null, null, {
    stoppedRetry: { maxAttempts: 1, delaysSec: [0.05], silentStopAttempts: 1 },
  });
  const server = createHttpServer({
    db,
    backend,
    capture,
    hub,
    cfg: { token: "test", agents: {}, favorites: [], reviewers: [] } as unknown as Config,
    jira: {} as JiraClient,
  } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    // 1. If archive fails, the guard clears and the task remains dispatched.
    failArchive = true;
    const failedRes = await fetch(`${baseUrl}/api/tasks/task-1/archive-session`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
    });
    assert.equal(failedRes.status, 500);
    assert.equal(db.getTask("task-1")?.status, "dispatched");

    // 2. Schedule a delayed nudge, then start a slow archive that outlasts the delay.
    failArchive = false;
    await capture.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "done" });
    const archivingReq = fetch(`${baseUrl}/api/tasks/task-1/archive-session`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
    });
    await archiveStarted;
    await wait(70); // Past the 50ms retry delay while backend.archive is still awaiting.
    assert.equal(sent.length, 0, "pending nudge was cancelled before archive completed");
    releaseArchive();
    const okRes = await archivingReq;
    assert.equal(okRes.status, 200);
    assert.equal(db.getTask("task-1")?.status, "archived");
    assert.equal(sent.length, 0);
  } finally {
    capture.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PATCH task to archived and POST item archive cancel pending stopped-run retries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-cancel-retry-"));
  const db = new Db(join(dir, "test.db"));
  db.insertTask(makeTask({ id: "t1", status: "dispatched", terminal_address: "s1" }));
  db.upsertTerminal({ address: "s1", task_id: "t1", name: null, agent: "claude", last_status: "working", last_turn: 1, updated_ms: Date.now() });
  db.insertTask(makeTask({ id: "t2", status: "dispatched", terminal_address: "s2" }));
  db.upsertTerminal({ address: "s2", task_id: "t2", name: null, agent: "claude", last_status: "working", last_turn: 1, updated_ms: Date.now() });
  db.insertItem({
    id: "item-2",
    kind: "question",
    status: "open",
    title: "Stopped",
    summary: "",
    body: "Stopped",
    context: "",
    options: null,
    ready: 1,
    source_ref: "s2",
    task_id: "t2",
    structured: 0,
    created_ms: 1,
    updated_ms: 1,
    resolved_ms: null,
    snooze_until_ms: null,
  });

  const sent: string[] = [];
  const backend = {
    name: "fake",
    read: async () => "tail",
    get: async (address: string) => fakeSession({ address, state: "live", status: "done" }),
    send: async (_a: string, text: string) => { sent.push(text); },
    lastRunOutcome: async () => ({ kind: "message" as const, text: "Finished." }),
  } as unknown as WorkerBackend;
  const hub = { broadcast: () => undefined, clients: new Set() };
  const capture = new CaptureEngine(db, backend, hub, null, null, {
    stoppedRetry: { maxAttempts: 1, delaysSec: [0.05], silentStopAttempts: 1 },
  });
  const server = createHttpServer({
    db,
    backend,
    capture,
    hub,
    cfg: { token: "test", agents: {}, favorites: [], reviewers: [] } as unknown as Config,
    jira: {} as JiraClient,
  } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    await capture.handleEvent({ type: "status", address: "s1", task_id: "t1", status: "done" });
    const patchRes = await fetch(`${baseUrl}/api/tasks/t1`, {
      method: "PATCH",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    assert.equal(patchRes.status, 200);

    // Schedule retry for t2 (when item-2 is still resolved? Actually resolve/archive cancels directly).
    db.updateItem("item-2", { status: "resolved", resolved_ms: Date.now() });
    await capture.handleEvent({ type: "status", address: "s2", task_id: "t2", status: "done" });
    const archiveItemRes = await fetch(`${baseUrl}/api/items/item-2/archive`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
    });
    assert.equal(archiveItemRes.status, 200);

    await wait(70);
    assert.equal(sent.length, 0);
  } finally {
    capture.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
