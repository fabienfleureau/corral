// herdr-core client: JSON-RPC 2.0 over its Unix socket, plus the `hc events`
// streaming subprocess for live status changes.
//
// Request/response uses one connection per call with a `hello` handshake first
// (legal on every core, and required by none we know of — harmless either way).
// Wire format is newline-delimited JSON.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { connect } from "node:net";
import type { HcEvent, HcTerminal } from "./types.ts";

export interface RunArgs {
  argv: string[];
  cwd?: string;
  name?: string;
  labels?: Record<string, string>;
  env?: Record<string, string>;
  keep?: boolean;
  outlive_parent?: boolean;
  no_parent?: boolean;
  wait?: boolean;
}

export class HerdrClient {
  socketPath: string;
  timeoutMs: number;

  constructor(socketPath: string, timeoutMs = 30000) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  private send(sock: import("node:net").Socket, id: number, method: string, params: Record<string, unknown>): void {
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  }

  /** One JSON-RPC call on a fresh connection (with hello handshake). */
  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const sock = connect(this.socketPath);
      let buf = "";
      let phase: "hello" | "call" | "done" = "hello";
      const fail = (err: Error) => {
        if (phase === "done") return;
        phase = "done";
        clearTimeout(timer);
        sock.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error(`herdr ${method}: timeout after ${this.timeoutMs}ms`)), this.timeoutMs);

      const consume = () => {
        for (;;) {
          const idx = buf.indexOf("\n");
          let line: string | null = null;
          if (idx >= 0) {
            line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
          } else {
            // Tolerate a complete JSON response with no trailing newline.
            try {
              JSON.parse(buf);
              line = buf;
              buf = "";
            } catch {
              return;
            }
          }
          if (!line.trim()) continue;
          let msg: { id?: number; result?: unknown; error?: { message?: string } };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (phase === "hello" && msg.id === 1) {
            phase = "call";
            this.send(sock, 2, method, params);
          } else if (phase === "call" && msg.id === 2) {
            phase = "done";
            clearTimeout(timer);
            sock.end();
            if (msg.error) {
              reject(new Error(`herdr ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
            } else {
              resolve(msg.result as T);
            }
            return;
          }
        }
      };

      sock.on("connect", () => this.send(sock, 1, "hello", {}));
      sock.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        consume();
      });
      sock.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
      sock.on("close", () => fail(new Error(`herdr ${method}: connection closed before reply`)));
    });
  }

  // Convenience wrappers over the schema methods.

  listTerminals(all = false, labels: Record<string, string> = {}): Promise<{ terminals: HcTerminal[]; hidden_finished: number; machines: unknown[] }> {
    return this.call("terminal.list", { all, labels });
  }

  getTerminal(terminal: string): Promise<HcTerminal> {
    return this.call("terminal.get", { terminal });
  }

  readTerminal(terminal: string, lines = 40): Promise<{ text: string; complete: boolean }> {
    return this.call("terminal.read", { terminal, lines });
  }

  sendText(terminal: string, text: string, opts: { force?: boolean } = {}): Promise<{ started: boolean | null; turn: number }> {
    return this.call("terminal.send", { terminal, text, force: opts.force ?? true, wait: false });
  }

  run(args: RunArgs): Promise<HcTerminal> {
    return this.call("terminal.run", { ...args });
  }

  kill(terminal: string): Promise<unknown> {
    return this.call("terminal.kill", { terminal });
  }

  setLabels(terminal: string, labels: Record<string, string>): Promise<unknown> {
    return this.call("terminal.label", { terminal, labels });
  }

  exec(line: string, opts: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return this.call("machine.exec", { line, cwd: opts.cwd, timeout: opts.timeout ?? 60 });
  }
}

export interface EventStreamHandlers {
  onEvent: (e: HcEvent) => void;
  onSnapshot?: (terminals: HcTerminal[]) => void;
  onStatus?: (err: Error | null) => void;
}

/**
 * Streams `hc events --json` and normalizes its output:
 *  - a snapshot object with a `terminals` array,
 *  - JSON-RPC "event" notifications,
 *  - tolerant of a bare compact object line for `created`.
 */
export class HerdrEventStream {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private stopped = false;
  private retryMs = 1000;
  private handlers: EventStreamHandlers;

  constructor(handlers: EventStreamHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    if (this.stopped) return;
    const child = spawn("hc", ["events", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        this.handleLine(line);
      }
    });
    child.stderr.on("data", () => undefined);
    child.on("exit", () => {
      this.child = null;
      if (!this.stopped) {
        this.handlers.onStatus?.(new Error("hc events exited; retrying"));
        setTimeout(() => this.start(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 30000);
      }
    });
    child.on("spawn", () => {
      this.retryMs = 1000;
      this.handlers.onStatus?.(null);
    });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
  }

  private handleLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(t);
    } catch {
      return;
    }
    if (msg.method === "event" && msg.params && typeof msg.params === "object") {
      const p = msg.params as { type?: string; terminal?: string; seq?: number; data?: Record<string, unknown> };
      if (p.type && p.terminal) {
        this.handlers.onEvent({
          type: p.type as HcEvent["type"],
          terminal: p.terminal,
          seq: p.seq ?? 0,
          data: p.data ?? {},
        });
      }
      return;
    }
    if (Array.isArray(msg.terminals)) {
      this.handlers.onSnapshot?.(msg.terminals as HcTerminal[]);
      return;
    }
    // Bare compact line, e.g. a created echo: {address, state, ...}
    if (typeof msg.address === "string" && typeof msg.state === "string" && !msg.type) {
      this.handlers.onEvent({
        type: "created",
        terminal: msg.address,
        seq: 0,
        data: msg,
      });
    }
  }
}
