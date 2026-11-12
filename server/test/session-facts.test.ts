import { test } from "node:test";
import assert from "node:assert/strict";

const { SessionFacts } = await import("../session-facts.ts");

type Facts = { model: string | null; reasoning: string | null; state?: string };

/** Worker backend stub: counts point reads and records peak concurrency. */
type Answer = Facts | null | Error | Promise<Facts | null | Error>;

function fakeBackend(answer: (address: string, call: number) => Answer) {
  const seen: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const backend = {
    name: "fake",
    async get(address: string) {
      seen.push(address);
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        const call = seen.filter((a) => a === address).length;
        const value = await answer(address, call);
        if (value instanceof Error) throw value;
        // The backend reports whether the session is over; the default stub is a
        // session that is over (the tasks queue is mostly history).
        return value ? { address, state: value.state ?? "finished", status: "done", ...value } : null;
      } finally {
        inFlight--;
      }
    },
  };
  return {
    backend: backend as never,
    reads: () => seen.length,
    addresses: () => seen,
    peak: () => peak,
  };
}

const done = (address: string) => ({ terminal_address: address, status: "done" as const });
const dispatched = (address: string) => ({ terminal_address: address, status: "dispatched" as const });
const live = { state: "live" };

test("a warm queue is read once and then answers from memory", async () => {
  const counts = fakeBackend(() => ({ model: "gpt-6.1-terra", reasoning: "high" }));
  const facts = new SessionFacts(counts.backend);
  const tasks = [done("a"), done("b"), done("c")];

  const first = await facts.forTasks(tasks);
  assert.equal(counts.reads(), 3);
  assert.deepEqual(first.get("a"), { model: "gpt-6.1-terra", reasoning: "high" });

  const second = await facts.forTasks(tasks);
  assert.equal(counts.reads(), 3, "a finished session must not be read again");
  assert.deepEqual(second.get("c"), { model: "gpt-6.1-terra", reasoning: "high" });
});

test("a live session is re-read so a model override shows up", async () => {
  const counts = fakeBackend((_address, call) => ({ ...live, model: call === 1 ? "sonnet-5" : "opus-5-5", reasoning: null }));
  const facts = new SessionFacts(counts.backend);
  const tasks = [dispatched("live")];

  assert.equal((await facts.forTasks(tasks)).get("live")?.model, "sonnet-5");
  assert.equal((await facts.forTasks(tasks)).get("live")?.model, "opus-5-5");
  assert.equal(counts.reads(), 2);
});

test("a task marked done whose session is still live keeps showing a new override", async () => {
  // capture.ts marks a task done when the agent reports, and the session can keep
  // running (the PR loop, a fresh session continuing the work): a done task is
  // not evidence its session is over.
  const counts = fakeBackend((_address, call) => ({ ...live, model: call === 1 ? "sonnet-5" : "opus-5-5", reasoning: null }));
  const facts = new SessionFacts(counts.backend);
  const tasks = [done("continuing")];

  assert.equal((await facts.forTasks(tasks)).get("continuing")?.model, "sonnet-5");
  assert.equal((await facts.forTasks(tasks)).get("continuing")?.model, "opus-5-5");
});

test("a session the backend reports as finished is kept even for a dispatched task", async () => {
  const counts = fakeBackend(() => ({ model: "m", reasoning: null }));
  const facts = new SessionFacts(counts.backend);
  const tasks = [dispatched("dead")];

  assert.equal((await facts.forTasks(tasks)).get("dead")?.model, "m");
  assert.equal((await facts.forTasks(tasks)).get("dead")?.model, "m");
  assert.equal(counts.reads(), 1, "the backend says it is over: no reason to read it again");
});

test("concurrent page loads share one pass over the queue", async () => {
  const counts = fakeBackend(() => ({ model: "m", reasoning: null }));
  const facts = new SessionFacts(counts.backend);
  const tasks = [done("a"), done("b"), done("c"), done("d")];

  await Promise.all([facts.forTasks(tasks), facts.forTasks(tasks), facts.forTasks(tasks)]);
  assert.equal(counts.reads(), 4, "one pass, not one per caller");
});

test("peak concurrency stays inside the configured bound", async () => {
  const counts = fakeBackend(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { model: "m", reasoning: null };
  });
  const facts = new SessionFacts(counts.backend, { concurrency: 2 });
  await facts.forTasks(Array.from({ length: 10 }, (_v, i) => done(`a${i}`)));
  assert.ok(counts.peak() <= 2, `peak ${counts.peak()} exceeded the bound`);
  assert.equal(counts.reads(), 10);
});

test("a backend that answers nothing is not re-read on the next request", async () => {
  const counts = fakeBackend(() => new Error("backend down"));
  const facts = new SessionFacts(counts.backend, { retryMs: 60_000 });
  const tasks = [done("a"), done("b"), done("c")];

  assert.equal((await facts.forTasks(tasks)).size, 0);
  assert.equal(counts.reads(), 3);
  await facts.forTasks(tasks);
  assert.equal(counts.reads(), 3, "a dead backend must not turn each page load into a fan-out");
});

test("a down backend is retried once the window is over", async () => {
  const counts = fakeBackend((_address, call) => (call === 1 ? new Error("down") : { model: "m", reasoning: null }));
  const facts = new SessionFacts(counts.backend, { retryMs: 0 });
  const tasks = [done("a")];
  assert.equal((await facts.forTasks(tasks)).size, 0);
  assert.equal((await facts.forTasks(tasks)).get("a")?.model, "m");
});

test("an address the backend missed on the first pass is retried, then kept", async () => {
  const counts = fakeBackend((address, call) => (address === "flaky" && call === 1 ? null : { model: "m", reasoning: null }));
  const facts = new SessionFacts(counts.backend, { retryMs: 0 });
  const tasks = [done("stable"), done("flaky")];

  const first = await facts.forTasks(tasks);
  assert.equal(first.get("stable")?.model, "m");
  assert.equal(first.has("flaky"), false, "an unanswered read is unknown, not a value");
  assert.equal((await facts.forTasks(tasks)).get("flaky")?.model, "m");
});

test("an address that never answers is retried rarely, not on every request", async () => {
  const counts = fakeBackend((address) => (address === "gone" ? null : { model: "m", reasoning: null }));
  const facts = new SessionFacts(counts.backend, { retryMs: 20 });
  const tasks = [done("gone"), done("stable")];

  for (let i = 0; i < 40; i++) {
    await facts.forTasks(tasks);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The window doubles (20, 40, 80, 160…): a few reads in 400ms, not 40.
  const gone = counts.addresses().filter((a) => a === "gone").length;
  assert.ok(gone >= 2, `an unanswered address is still retried (${gone} reads)`);
  assert.ok(gone <= 8, `${gone} reads in 400ms: the retry window must grow`);
  assert.equal((await facts.forTasks(tasks)).get("stable")?.model, "m", "and the rest stays answered");
});

test("a long outage backs off instead of re-reading the queue every window", async () => {
  const counts = fakeBackend(() => new Error("down"));
  const facts = new SessionFacts(counts.backend, { retryMs: 20 });
  const tasks = [done("a"), done("b"), done("c")];

  for (let i = 0; i < 40; i++) {
    await facts.forTasks(tasks);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Windows 20, 40, 80, 160, 320… over ~400ms: a handful of passes, not 40.
  assert.ok(counts.reads() >= 3, "an outage is still retried");
  assert.ok(counts.reads() <= 18, `${counts.reads()} reads in 400ms: the outage must back off`);
});

test("a long outage does not write the queue off as unknown", async () => {
  let down = true;
  const counts = fakeBackend(() => (down ? new Error("down") : { model: "m", reasoning: null }));
  const facts = new SessionFacts(counts.backend, { retryMs: 10 });
  const tasks = [done("a"), done("b"), done("c")];

  for (let i = 0; i < 6; i++) {
    await facts.forTasks(tasks);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  down = false;
  let size = 0;
  for (let i = 0; i < 100 && size < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    size = (await facts.forTasks(tasks)).size;
  }
  assert.equal(size, 3, "the queue recovers once the backend answers again");
});

test("a single missing session does not back off the healthy ones", async () => {
  // A status-filtered page can hold one task whose session is gone. The backend
  // answered ("no session here"), so that is not an outage: the next request for
  // a healthy list must still be read.
  const counts = fakeBackend((address) => (address === "gone" ? null : { model: "m", reasoning: null }));
  const facts = new SessionFacts(counts.backend, { retryMs: 30_000 });

  assert.equal((await facts.forTasks([done("gone")])).size, 0);
  assert.equal((await facts.forTasks([done("healthy")])).get("healthy")?.model, "m");
});

test("joiners with different slices each get their own read", async () => {
  const counts = fakeBackend(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { model: "m", reasoning: null };
  });
  const facts = new SessionFacts(counts.backend, { concurrency: 1 });

  // Three status-filtered lists arriving together: the first starts the pass,
  // the other two must not be left waiting on it forever.
  const [a, b, c] = await Promise.all([
    facts.forTasks([done("a1"), done("a2")]),
    facts.forTasks([done("b1")]),
    facts.forTasks([done("c1")]),
  ]);
  assert.equal(a.size, 2);
  assert.equal(b.size, 1);
  assert.equal(c.size, 1);
  assert.deepEqual(counts.addresses().sort(), ["a1", "a2", "b1", "c1"], "every slice is read once");
});

test("a request answers without waiting for the whole cold queue", async () => {
  const counts = fakeBackend(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { model: "m", reasoning: null };
  });
  const facts = new SessionFacts(counts.backend, { concurrency: 1, requestBudgetMs: 40 });
  const tasks = Array.from({ length: 20 }, (_v, i) => done(`a${i}`));

  const started = Date.now();
  const partial = await facts.forTasks(tasks);
  assert.ok(Date.now() - started < 400, "the page must not wait for the whole queue");
  assert.ok(partial.size < 20, "a cold queue is served partially");

  // The pass keeps filling in the background; the next loads pick it up.
  let size = partial.size;
  for (let i = 0; i < 100 && size < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    size = (await facts.forTasks(tasks)).size;
  }
  assert.equal(size, 20, "the background pass fills the rest");
  assert.equal(counts.reads(), 20, "and no address is read twice");
});

test("a hanging backend cannot spend the request budget twice", async () => {
  const backend = { name: "hung", get: () => new Promise<never>(() => undefined) };
  const facts = new SessionFacts(backend as never, { requestBudgetMs: 200, concurrency: 2, retryMs: 60_000 });
  const tasks = [dispatched("live"), done("old"), done("older")];

  const started = Date.now();
  const out = await facts.forTasks(tasks);
  const elapsed = Date.now() - started;
  assert.equal(out.size, 0, "nothing is known yet, and nothing is invented");
  assert.ok(elapsed < 330, `a stalled backend took ${elapsed}ms (budget is 200ms)`);
});

test("a hanging read is shared by the requests waiting on it", async () => {
  const reads: string[] = [];
  const backend = { name: "hung", get: (address: string) => { reads.push(address); return new Promise<never>(() => undefined); } };
  const facts = new SessionFacts(backend as never, { requestBudgetMs: 30, concurrency: 4 });
  const tasks = [dispatched("live")];

  await facts.forTasks(tasks);
  await facts.forTasks(tasks);
  assert.deepEqual(reads, ["live"], "a burst of page loads is one read, not one per load");
});

test("tasks without a session address are left out", async () => {
  const counts = fakeBackend(() => ({ model: "m", reasoning: null }));
  const facts = new SessionFacts(counts.backend);
  const out = await facts.forTasks([
    { terminal_address: null },
    { terminal_address: "" },
  ]);
  assert.equal(out.size, 0);
  assert.equal(counts.reads(), 0);
});

test("the tasks endpoint enriches from memory on the second load", async () => {
  const { createHttpServer } = await import("../api.ts");
  const { Db } = await import("../db.ts");
  // s2 is the dispatched task: its session is still live, so it is read again.
  const counts = fakeBackend((address) => ({ model: `model-${address}`, reasoning: "high", ...(address === "s2" ? live : {}) }));
  const db = new Db(":memory:");
  for (const [i, status] of (["done", "done", "dispatched", "archived"] as const).entries()) {
    db.insertTask({
      id: `t${i}`, title: `task ${i}`, prompt: "", repo_path: "", target: "claude", target_state: "suggested",
      base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: null, jira_url: null,
      jira_parent_key: null, pr_url: null, pr_meta: null, status, terminal_address: `s${i}`, exit_code: null,
      created_ms: 1 + i, updated_ms: 1 + i,
    });
  }
  const server = createHttpServer({ db, cfg: { token: "test" }, backend: counts.backend, hub: { broadcast() {}, clients: new Set() } } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const get = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers: { Authorization: "Bearer test" } });
    return (await response.json()) as { id: string; status: string; session_model: string | null; session_reasoning: string | null }[];
  };
  try {
    const first = await get();
    assert.equal(first.find((t) => t.id === "t0")?.session_model, "model-s0");
    assert.equal(first.find((t) => t.id === "t1")?.session_reasoning, "high");
    assert.equal(first.find((t) => t.id === "t2")?.session_model, "model-s2");
    const afterFirst = counts.reads();
    assert.equal(afterFirst, 4, "one read per session, the live one included");

    const second = await get();
    assert.deepEqual(second.map((t) => t.session_model), first.map((t) => t.session_model));
    // Only the live session is read again.
    assert.equal(counts.reads() - afterFirst, 1);
  } finally {
    server.close();
    db.close();
  }
});
