// Session facts (model / reasoning) for the tasks list.
//
// GET /api/tasks shows each task's session settings, and reading them costs one
// worker-backend round trip *per session* (neither the session listing nor the
// task row carries them). The UI reloads that list on every SSE event, so a
// queue of a few hundred tasks spent seconds per page load re-reading values
// that cannot have changed: once a task is no longer dispatched its session is
// over, and a finished session's model and reasoning are immutable. Those are
// read once and kept; only the dispatched tasks (a handful at a time) are
// re-read per request.
//
// The first pass over an existing queue still costs one round over all of it,
// so startup primes it in the background (see index.ts) — by the time the human
// opens the page, that pass is usually done. Concurrent callers share one pass,
// a request never waits longer than `requestBudgetMs` in total, reads in flight
// are shared by the callers waiting on them, and an address the backend did not
// answer is retried on a later pass instead of being written off (or re-read on
// every request).

import { withDeadline } from "./deadline.ts";
import { mapLimit } from "./exec.ts";
import type { Task } from "./types.ts";
import type { WorkerBackend } from "./worker.ts";

export interface SessionFact {
  model: string | null;
  reasoning: string | null;
}

export interface SessionFactsOptions {
  /** Point reads in flight at once. */
  concurrency?: number;
  /** Per backend call. */
  timeoutMs?: number;
  /** How long a request waits for the backend before answering without it. */
  requestBudgetMs?: number;
  /** How long an unanswered address waits before it is retried. */
  retryMs?: number;
}

/** What the enricher needs from a task. */
export type FactTask = Pick<Task, "terminal_address" | "status">;

/** A task that is not dispatched holds a session that is over. */
function hasRunningSession(task: FactTask): boolean {
  return task.status === "dispatched";
}

/** Addresses a task list points at, without duplicates. */
function addressesOf(tasks: FactTask[]): string[] {
  const seen = new Set<string>();
  for (const task of tasks) {
    const address = task.terminal_address;
    if (typeof address === "string" && address.length > 0) seen.add(address);
  }
  return [...seen];
}

export class SessionFacts {
  private readonly backend: WorkerBackend;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly requestBudgetMs: number;
  private readonly retryMs: number;
  /** Facts of sessions that are over: immutable, kept for the process lifetime. */
  private readonly settled = new Map<string, SessionFact>();
  /** Addresses a pass got no answer for, with when and how often that happened. */
  private readonly unanswered = new Map<string, { attempts: number; at: number }>();
  /** Reads in flight, so a burst of page loads shares them instead of repeating them. */
  private readonly reads = new Map<string, Promise<SessionFact | null>>();
  /** The pass over the queue, shared by concurrent callers. */
  private pass: Promise<void> | null = null;
  private static readonly MAX_ATTEMPTS = 3;

  constructor(backend: WorkerBackend, opts: SessionFactsOptions = {}) {
    this.backend = backend;
    this.concurrency = Math.max(1, opts.concurrency ?? 8);
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.requestBudgetMs = opts.requestBudgetMs ?? 3_000;
    this.retryMs = opts.retryMs ?? 30_000;
  }

  /** Read and keep the facts of every task whose session is over. */
  prime(tasks: FactTask[]): Promise<void> {
    const running = runningAddresses(tasks);
    const pending = addressesOf(tasks).filter(
      (address) => !this.settled.has(address) && !running.has(address) && this.retryable(address),
    );
    if (pending.length === 0) return Promise.resolve();
    if (this.pass) return this.pass;
    this.pass = this.readAll(pending).finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  /** Facts per session address. An absent address has no known session. */
  async forTasks(tasks: FactTask[]): Promise<Map<string, SessionFact>> {
    const addresses = addressesOf(tasks);
    const out = new Map<string, SessionFact>();
    if (addresses.length === 0) return out;

    // One budget for the whole answer: a cold queue costs one round over the
    // queue, and a stalled backend must not spend that budget twice. The page
    // gets what the pass has filled so far; the pass finishes in the background.
    const deadline = Date.now() + this.requestBudgetMs;
    await withDeadline(this.prime(tasks), this.requestBudgetMs, undefined);
    for (const address of addresses) {
      const settled = this.settled.get(address);
      if (settled) out.set(address, settled);
    }
    // A dispatched session still takes model overrides: read those now. They
    // are few, and they are the only reads a warm queue performs.
    const live = runningAddresses(tasks);
    const running = addresses.filter((address) => live.has(address));
    const left = deadline - Date.now();
    // withDeadline(0) means "no budget": skip the read instead of awaiting it.
    if (running.length > 0 && left > 0) await withDeadline(this.readRunning(running, out), left, undefined);
    return out;
  }

  /** A pass retries an unanswered address, but not on every request and not forever. */
  private retryable(address: string): boolean {
    const missed = this.unanswered.get(address);
    if (!missed) return true;
    return missed.attempts < SessionFacts.MAX_ATTEMPTS && Date.now() - missed.at >= this.retryMs;
  }

  private async readAll(addresses: string[]): Promise<void> {
    let answered = 0;
    await mapLimit(addresses, this.concurrency, async (address) => {
      const fact = await this.readOnce(address);
      if (!fact) {
        const missed = this.unanswered.get(address);
        this.unanswered.set(address, { attempts: (missed?.attempts ?? 0) + 1, at: Date.now() });
        return;
      }
      answered++;
      this.settled.set(address, fact);
      this.unanswered.delete(address);
    });
    // Nothing at all: the backend is down. Do not run another full pass on the
    // next request; the per-address retry window keeps the queue pending.
    if (answered === 0 && addresses.length > 1) {
      for (const address of addresses) this.unanswered.set(address, { attempts: 0, at: Date.now() });
    }
  }

  private async readRunning(addresses: string[], out: Map<string, SessionFact>): Promise<void> {
    const facts = await mapLimit(addresses, this.concurrency, (address) => this.readOnce(address));
    // Not settled: a running session can still take a model override.
    addresses.forEach((address, i) => {
      const fact = facts[i];
      if (fact) out.set(address, fact);
    });
  }

  /** One read per address at a time, shared by every caller waiting on it. */
  private readOnce(address: string): Promise<SessionFact | null> {
    const running = this.reads.get(address);
    if (running) return running;
    const read = this.read(address).finally(() => this.reads.delete(address));
    this.reads.set(address, read);
    return read;
  }

  /** null = the backend did not answer for this address. */
  private async read(address: string): Promise<SessionFact | null> {
    if (typeof this.backend.get !== "function") return null;
    try {
      const session = await withDeadline(this.backend.get(address), this.timeoutMs, null);
      if (!session) return null;
      return { model: session.model ?? null, reasoning: session.reasoning ?? null };
    } catch {
      return null;
    }
  }
}

function runningAddresses(tasks: FactTask[]): Set<string> {
  return new Set(addressesOf(tasks.filter(hasRunningSession)));
}
