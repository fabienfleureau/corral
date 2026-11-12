// Session facts (model / reasoning) for the tasks list.
//
// GET /api/tasks shows each task's session settings, and reading them costs one
// worker-backend round trip *per session* (neither the session listing nor the
// task row carries them). The UI reloads that list on every SSE event, so a
// queue of a few hundred tasks spent seconds per page load re-reading values
// that mostly cannot change: the backend reports a session as `finished` once it
// is over, and a finished session's model and reasoning are immutable. Those are
// read once and kept.
//
// Everything else is read again — through one shared pass per burst of requests,
// never one fan-out per page load:
//   - a live session still takes model overrides, so its facts are refreshed;
//   - a task being `done` is *not* evidence its session is over: capture.ts
//     marks a task done when the agent reports, and that session can keep
//     running (the PR loop, a fresh session continuing the work);
//   - an address the backend did not answer is retried after a window that
//     doubles each time, so a gone session costs one read per window instead of
//     a fan-out on every page load — and never loses its facts for good;
//   - a pass that answers nothing at all is an outage, not N missing sessions:
//     it backs off instead of counting every address out (which would lose the
//     whole queue) or re-reading it on every request.
//
// A request never waits longer than `requestBudgetMs`; the pass keeps going
// behind it, so the next page load is warmer.

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
  /** How long an unanswered address (or a down backend) waits before a retry. */
  retryMs?: number;
}

/** What the enricher needs from a task. */
export type FactTask = Pick<Task, "terminal_address">;

/** Addresses a task list points at, without duplicates. */
function addressesOf(tasks: FactTask[]): string[] {
  const seen = new Set<string>();
  for (const task of tasks) {
    const address = task.terminal_address;
    if (typeof address === "string" && address.length > 0) seen.add(address);
  }
  return [...seen];
}

/** One read: the facts, and whether the backend says the session is over. */
interface Outcome {
  fact: SessionFact;
  finished: boolean;
}

export class SessionFacts {
  private readonly backend: WorkerBackend;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly requestBudgetMs: number;
  private readonly retryMs: number;
  /** Facts of sessions the backend reports as finished: immutable, kept. */
  private readonly settled = new Map<string, SessionFact>();
  /** Last answer for a session that is still live — shown until a fresher one. */
  private readonly live = new Map<string, SessionFact>();
  /** Addresses a pass got no answer for, with when and how often that happened. */
  private readonly unanswered = new Map<string, { attempts: number; at: number }>();
  /** Reads in flight, so a burst of page loads shares them instead of repeating them. */
  private readonly reads = new Map<string, Promise<Outcome | null>>();
  /** The pass over the queue, shared by concurrent callers. */
  private pass: { addresses: Set<string>; done: Promise<void> } | null = null;
  /** Consecutive passes that answered nothing at all: the backend is down. */
  private outage: { passes: number; at: number } | null = null;
  /** Backoff cap: a recovered backend is noticed within this window. */
  private static readonly MAX_BACKOFF_MS = 2 * 60_000;

  constructor(backend: WorkerBackend, opts: SessionFactsOptions = {}) {
    this.backend = backend;
    this.concurrency = Math.max(1, opts.concurrency ?? 8);
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.requestBudgetMs = opts.requestBudgetMs ?? 3_000;
    this.retryMs = opts.retryMs ?? 30_000;
  }

  /** Read and keep the facts of every session that is over (startup warm-up). */
  prime(tasks: FactTask[]): Promise<void> {
    return this.fill(addressesOf(tasks), 0);
  }

  /** Facts per session address. An absent address has no known session. */
  async forTasks(tasks: FactTask[]): Promise<Map<string, SessionFact>> {
    const addresses = addressesOf(tasks);
    const out = new Map<string, SessionFact>();
    if (addresses.length === 0) return out;

    // One budget for the whole answer: a cold queue costs one pass over the
    // queue, and a stalled backend must not spend that budget twice. The page
    // gets what the pass has filled so far; the pass finishes in the background.
    await withDeadline(this.fill(addresses, 0), this.requestBudgetMs, undefined);
    for (const address of addresses) {
      const fact = this.settled.get(address) ?? this.live.get(address);
      if (fact) out.set(address, fact);
    }
    return out;
  }

  /** Read every address that has no settled fact yet, once per burst of callers. */
  private fill(addresses: string[], depth: number): Promise<void> {
    const pending = addresses.filter((address) => !this.settled.has(address) && this.retryable(address));
    if (pending.length === 0) return Promise.resolve();
    const running = this.pass;
    if (running) {
      if (pending.every((address) => running.addresses.has(address))) return running.done;
      // The pass in flight is reading a different slice of the queue (a
      // status-filtered list): let it finish, then cover what it did not.
      if (depth >= 1) return running.done;
      return running.done.then(() =>
        this.fill(pending.filter((address) => !this.settled.has(address)), depth + 1),
      );
    }
    if (!this.passAllowed()) return Promise.resolve();
    const done = this.readAll(pending).finally(() => {
      if (this.pass?.done === done) this.pass = null;
    });
    this.pass = { addresses: new Set(pending), done };
    return done;
  }

  /** An unanswered address is retried after a window that doubles each time. */
  private retryable(address: string): boolean {
    const missed = this.unanswered.get(address);
    if (!missed) return true;
    return Date.now() - missed.at >= this.backoffMs(missed.attempts);
  }

  /** Exponential and capped: a persistent miss costs one read per window. */
  private backoffMs(failures: number): number {
    return Math.min(this.retryMs * 2 ** Math.max(0, failures - 1), SessionFacts.MAX_BACKOFF_MS);
  }

  /** A down backend is retried, but the wait doubles on each pass that fails whole. */
  private passAllowed(): boolean {
    return !this.outage || Date.now() - this.outage.at >= this.backoffMs(this.outage.passes);
  }

  private async readAll(addresses: string[]): Promise<void> {
    const missed: string[] = [];
    let answered = 0;
    await mapLimit(addresses, this.concurrency, async (address) => {
      const outcome = await this.readOnce(address);
      if (!outcome) {
        missed.push(address);
        return;
      }
      answered++;
      this.unanswered.delete(address);
      if (outcome.finished) {
        this.settled.set(address, outcome.fact);
        this.live.delete(address);
      } else {
        this.live.set(address, outcome.fact);
      }
    });
    if (answered === 0) {
      // Nothing at all: that is an outage, not N missing sessions. Back off as a
      // whole — counting each address out would make one transient outage
      // inflate every backoff, and resetting the counters (as an earlier draft
      // did) would re-read the whole queue on every window forever.
      this.outage = { passes: (this.outage?.passes ?? 0) + 1, at: Date.now() };
      return;
    }
    this.outage = null;
    for (const address of missed) {
      const seen = this.unanswered.get(address);
      this.unanswered.set(address, { attempts: (seen?.attempts ?? 0) + 1, at: Date.now() });
    }
  }

  /** One read per address at a time, shared by every caller waiting on it. */
  private readOnce(address: string): Promise<Outcome | null> {
    const running = this.reads.get(address);
    if (running) return running;
    const read = this.read(address).finally(() => this.reads.delete(address));
    this.reads.set(address, read);
    return read;
  }

  /** null = the backend did not answer for this address. */
  private async read(address: string): Promise<Outcome | null> {
    if (typeof this.backend.get !== "function") return null;
    try {
      const session = await withDeadline(this.backend.get(address), this.timeoutMs, null);
      if (!session) return null;
      return {
        fact: { model: session.model ?? null, reasoning: session.reasoning ?? null },
        finished: session.state === "finished",
      };
    } catch {
      return null;
    }
  }
}
