// Passive local Antigravity (`agy`) activity probe and Omnigent idle
// reconciliation tests (ADR 0024).
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  AntigravityActivityCache,
  EMPTY_ANTIGRAVITY_ACTIVITY,
  isAntigravityCascadeRunning,
  parseAntigravitySessionProcesses,
  parseCascadeTrajectories,
  probeAntigravityActivity,
  type AntigravityActivitySnapshot,
} from "../antigravity-status.ts";
import { CaptureEngine } from "../capture.ts";
import { Db } from "../db.ts";
import { OmnigentBackend } from "../omnigent.ts";
import type { Task } from "../types.ts";

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1",
    title: "Antigravity status check",
    prompt: "Check local status",
    repo_path: "/tmp/repo",
    target: "antigravity",
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
    terminal_address: "sess-1",
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    ...over,
  };
}

test("parseAntigravitySessionProcesses extracts agy processes and links parent tmux session ids", () => {
  const ps = [
    "  101     1 /sbin/launchd",
    " 2000     1 /opt/homebrew/bin/tmux -S /tmp/t1/tmux.sock set-option -g @omnigent-conversation-link http://127.0.0.1:6767/c/sess_abc123 ; new-session -d",
    " 2001  2000 /Users/dev/.local/bin/agy --gemini_dir=/tmp/g1 --csrf_token=tok-1 --extension_server_port 50123 --conversation casc-1 --dangerously-skip-permissions",
    " 2500     1 /opt/homebrew/bin/tmux -S /tmp/t2/tmux.sock set-option -g @omnigent-conversation-link 'http://127.0.0.1:6767/c/sess_def456'",
    " 2501  2500 agy --csrf_token=tok-2",
    " 3000     1 /Applications/Antigravity.app/Contents/Resources/language_server_macos --csrf_token ide-tok",
    " 3100     1 /opt/homebrew/bin/python3 -c 'import pty' /Users/dev/.local/bin/agy --csrf_token=py-tok",
    " 3200     1 /Users/dev/.local/bin/agy --model gemini-4-neon-high",
  ].join("\n");

  assert.deepEqual(parseAntigravitySessionProcesses(ps), [
    {
      pid: 2001,
      ppid: 2000,
      csrfToken: "tok-1",
      extensionPort: 50123,
      conversationId: "casc-1",
      omnigentSessionId: "sess_abc123",
    },
    {
      pid: 2501,
      ppid: 2500,
      csrfToken: "tok-2",
      extensionPort: null,
      conversationId: null,
      omnigentSessionId: "sess_def456",
    },
  ]);
});

test("parseCascadeTrajectories reads running/idle statuses and propagates running child cascades to parent/root", () => {
  assert.equal(parseCascadeTrajectories(null), null);
  assert.equal(parseCascadeTrajectories({}), null);
  assert.equal(parseCascadeTrajectories({ trajectorySummaries: [] }), null);

  const parsed = parseCascadeTrajectories({
    trajectorySummaries: {
      "root-running": {
        status: "CASCADE_RUN_STATUS_RUNNING",
        trajectoryMetadata: { rootConversationId: "root-running" },
      },
      "root-idle": {
        status: "CASCADE_RUN_STATUS_IDLE",
        trajectoryMetadata: { rootConversationId: "root-idle" },
      },
      "child-running": {
        status: "CASCADE_RUN_STATUS_RUNNING",
        trajectoryMetadata: {
          parentConversationId: "parent-waiting",
          rootConversationId: "root-with-child",
        },
      },
      "child-idle": {
        status: "CASCADE_RUN_STATUS_IDLE",
        trajectoryMetadata: {
          parentConversationId: "root-idle",
          rootConversationId: "root-idle",
        },
      },
    },
  });

  assert.ok(parsed);
  assert.deepEqual(
    [...parsed.running].sort(),
    ["child-running", "parent-waiting", "root-running", "root-with-child"],
  );
  assert.deepEqual(
    [...parsed.known].sort(),
    ["child-idle", "child-running", "parent-waiting", "root-idle", "root-running", "root-with-child"],
  );
});

test("isAntigravityCascadeRunning prefers explicit cascade status over tmux session fallback", () => {
  const snapshot: AntigravityActivitySnapshot = {
    runningCascades: new Set(["casc-running"]),
    knownCascades: new Set(["casc-running", "casc-idle"]),
    runningSessions: new Set(["sess-idle", "sess-unlinked"]),
  };

  assert.equal(isAntigravityCascadeRunning(snapshot, { address: "sess-x", externalSessionId: "casc-running" }), true);
  assert.equal(isAntigravityCascadeRunning(snapshot, { address: "sess-idle", externalSessionId: "casc-idle" }), false);
  assert.equal(isAntigravityCascadeRunning(snapshot, { address: "sess-unlinked", externalSessionId: null }), true);
  assert.equal(isAntigravityCascadeRunning(snapshot, { address: "sess-unlinked", externalSessionId: "casc-unknown" }), true);
  assert.equal(isAntigravityCascadeRunning(EMPTY_ANTIGRAVITY_ACTIVITY, { address: "sess-unlinked", externalSessionId: null }), false);
});

test("probeAntigravityActivity queries local Connect-RPC server with X-Codeium-Csrf-Token", async () => {
  const seenHeaders: Array<string | string[] | undefined> = [];
  const seenPaths: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    seenPaths.push(req.url);
    seenHeaders.push(req.headers["x-codeium-csrf-token"]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        trajectorySummaries: {
          "casc-live": { status: "CASCADE_RUN_STATUS_RUNNING" },
          "casc-done": { status: "CASCADE_RUN_STATUS_IDLE" },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const snapshot = await probeAntigravityActivity({
      run: async () =>
        [
          "100 1 /opt/homebrew/bin/tmux -S /tmp/s/tmux.sock set-option -g @omnigent-conversation-link http://127.0.0.1:6767/c/sess-tmux",
          "101 100 /Users/dev/.local/bin/agy --csrf_token=secret-csrf",
        ].join("\n"),
      listPorts: async (pid) => {
        assert.equal(pid, 101);
        return [address.port];
      },
    });

    assert.deepEqual(seenPaths, ["/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories"]);
    assert.deepEqual(seenHeaders, ["secret-csrf"]);
    assert.equal(snapshot.runningCascades.has("casc-live"), true);
    assert.equal(snapshot.knownCascades.has("casc-done"), true);
    assert.equal(snapshot.runningSessions.has("sess-tmux"), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("AntigravityActivityCache deduplicates concurrent probes, refreshes after TTL, and fails open", async () => {
  let clock = 10_000;
  let calls = 0;
  let release!: (s: AntigravityActivitySnapshot) => void;
  const cache = new AntigravityActivityCache(
    () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve({
        runningCascades: new Set([`casc-${calls}`]),
        knownCascades: new Set([`casc-${calls}`]),
        runningSessions: new Set(),
      });
    },
    { ttlMs: 2_000, budgetMs: 500, now: () => clock },
  );

  const p1 = cache.snapshot();
  const p2 = cache.snapshot();
  assert.equal(calls, 1, "concurrent callers share one in-flight probe");
  release({
    runningCascades: new Set(["casc-1"]),
    knownCascades: new Set(["casc-1"]),
    runningSessions: new Set(),
  });
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1.runningCascades.has("casc-1"), true);
  assert.equal(s2.runningCascades.has("casc-1"), true);

  clock += 1_500;
  const cached = await cache.snapshot();
  assert.equal(calls, 1, "within TTL returns cached snapshot");
  assert.equal(cached.runningCascades.has("casc-1"), true);

  clock += 600;
  const refreshed = await cache.snapshot();
  assert.equal(calls, 2, "past TTL triggers a new probe");
  assert.equal(refreshed.runningCascades.has("casc-2"), true);

  const failingCache = new AntigravityActivityCache(
    async () => {
      throw new Error("ps failed");
    },
    { ttlMs: 2_000, budgetMs: 200 },
  );
  const failed = await failingCache.snapshot();
  assert.equal(failed.runningCascades.size, 0);

  const timedOutCache = new AntigravityActivityCache(
    () => new Promise(() => {}),
    { ttlMs: 2_000, budgetMs: 15 },
  );
  const timedOut = await timedOutCache.snapshot();
  assert.equal(timedOut.runningCascades.size, 0);
});

test("OmnigentBackend.list() and get() upgrade live idle antigravity sessions only when agy is running", async () => {
  let probeCalls = 0;
  let snapshot: AntigravityActivitySnapshot = {
    runningCascades: new Set(["casc-1"]),
    knownCascades: new Set(["casc-1", "casc-idle"]),
    runningSessions: new Set(["sess-tmux-only"]),
  };

  const backend = new OmnigentBackend(
    { baseUrl: "http://x", token: "", hostId: "", agents: {} },
    {
      antigravityActivity: async () => {
        probeCalls += 1;
        return snapshot;
      },
    },
  );

  const rows: Record<string, unknown>[] = [
    {
      id: "sess-1",
      live_status: "idle",
      external_session_id: "casc-1",
      labels: { "corral.harness": "antigravity", "corral.task": "t1" },
    },
    {
      id: "sess-tmux-only",
      live_status: "idle",
      external_session_id: null,
      labels: { "corral.harness": "antigravity", "corral.task": "t2" },
    },
    {
      id: "sess-really-idle",
      live_status: "idle",
      external_session_id: "casc-idle",
      labels: { "corral.harness": "antigravity", "corral.task": "t3" },
    },
    {
      id: "sess-blocked",
      live_status: "idle",
      external_session_id: "casc-1",
      pending_elicitations_count: 1,
      labels: { "corral.harness": "antigravity", "corral.task": "t4" },
    },
    {
      id: "sess-failed",
      live_status: "failed",
      external_session_id: "casc-1",
      labels: { "corral.harness": "antigravity", "corral.task": "t5" },
    },
    {
      id: "sess-archived",
      live_status: "idle",
      archived: true,
      external_session_id: "casc-1",
      labels: { "corral.harness": "antigravity", "corral.task": "t6" },
    },
    {
      id: "sess-claude",
      live_status: "idle",
      external_session_id: "casc-1",
      labels: { "corral.harness": "claude", "corral.task": "t7" },
    },
  ];

  (backend as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_m, path) => {
    if (path.startsWith("/v1/sessions?")) return { data: rows };
    const id = path.split("/").pop();
    return rows.find((r) => r.id === id) ?? { id };
  };

  const listed = await backend.list();
  assert.equal(probeCalls, 1);
  assert.deepEqual(
    listed.map((s) => [s.address, s.status]),
    [
      ["sess-1", "working"],
      ["sess-tmux-only", "working"],
      ["sess-really-idle", "idle"],
      ["sess-blocked", "blocked"],
      ["sess-failed", "error"],
      ["sess-archived", "idle"],
      ["sess-claude", "idle"],
    ],
  );

  assert.equal((await backend.get("sess-1"))?.status, "working");
  assert.equal(probeCalls, 2);

  // Non-antigravity or already-working sessions never trigger the probe.
  await backend.get("sess-claude");
  assert.equal(probeCalls, 2);

  snapshot = EMPTY_ANTIGRAVITY_ACTIVITY;
  assert.equal((await backend.get("sess-1"))?.status, "idle");
  assert.equal(probeCalls, 3);
});

test("OmnigentBackend.pollOnce() + CaptureEngine suppress false stopped-run retry while agy is running, then capture genuine idle", async () => {
  const db = new Db(":memory:");
  db.insertTask(makeTask({ id: "task-1", terminal_address: "sess-1", target: "antigravity" }));

  let omnigentLiveStatus = "running";
  let agyRunning = true;
  const sent: string[] = [];

  const backend = new OmnigentBackend(
    { baseUrl: "http://x", token: "", hostId: "", agents: {} },
    {
      antigravityActivity: async () =>
        agyRunning
          ? {
              runningCascades: new Set(["casc-1"]),
              knownCascades: new Set(["casc-1"]),
              runningSessions: new Set(["sess-1"]),
            }
          : {
              runningCascades: new Set(),
              knownCascades: new Set(["casc-1"]),
              runningSessions: new Set(),
            },
    },
  );

  (backend as unknown as { request: (m: string, p: string, b?: unknown) => Promise<unknown> }).request = async (
    method,
    path,
  ) => {
    if (method === "GET" && path.startsWith("/v1/sessions?")) {
      return {
        data: [
          {
            id: "sess-1",
            live_status: omnigentLiveStatus,
            external_session_id: "casc-1",
            labels: { "corral.harness": "antigravity", "corral.task": "task-1" },
          },
        ],
      };
    }
    if (method === "GET" && path === "/v1/sessions/sess-1") {
      return {
        id: "sess-1",
        live_status: omnigentLiveStatus,
        external_session_id: "casc-1",
        labels: { "corral.harness": "antigravity", "corral.task": "task-1" },
      };
    }
    if (method === "GET" && path.startsWith("/v1/sessions/sess-1/items")) {
      return {
        data: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Waiting on test run..." }],
          },
        ],
      };
    }
    if (method === "POST" && path === "/v1/sessions/sess-1/events") {
      sent.push(path);
      return {};
    }
    return {};
  };

  const capture = new CaptureEngine(db, backend, { broadcast() {} }, null, null, {
    stoppedRetry: { maxAttempts: 0, silentStopAttempts: 0 },
  });
  const pollOnce = () => (backend as unknown as { pollOnce: () => Promise<void> }).pollOnce();

  try {
    const subs = (backend as unknown as { subs: Set<(e: any) => void> }).subs;
    const pending: Promise<void>[] = [];
    const listener = (e: any) => {
      pending.push(capture.handleEvent(e));
    };
    subs.add(listener);

    // 1. Initial running poll
    await pollOnce();
    await Promise.all(pending.splice(0));
    assert.equal(db.getTerminal("sess-1")?.last_status, "working");
    assert.equal(db.openQuestionItemForTerminal("sess-1"), null);

    // 2. Omnigent drops to idle mid-turn while agy is still running
    omnigentLiveStatus = "idle";
    agyRunning = true;
    await pollOnce();
    await Promise.all(pending.splice(0));
    assert.equal(db.getTerminal("sess-1")?.last_status, "working");
    assert.equal(db.openQuestionItemForTerminal("sess-1"), null);
    assert.equal(sent.length, 0);

    // 3. agy finishes and becomes CASCADE_RUN_STATUS_IDLE -> genuine idle captured
    agyRunning = false;
    await pollOnce();
    await Promise.all(pending.splice(0));
    assert.equal(db.getTerminal("sess-1")?.last_status, "idle");
    const item = db.openQuestionItemForTerminal("sess-1");
    assert.ok(item, "genuine idle stop surfaces to inbox once agy is idle");
    assert.match(item.body, /Waiting on test run/);

    subs.delete(listener);
  } finally {
    capture.dispose();
    db.close();
  }
});
