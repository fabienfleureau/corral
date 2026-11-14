// Headless Chrome driven over the DevTools Protocol, shared by the fixture
// capture scripts. Node built-ins only: WebSocket is global in Node 22.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const viewport = { width: 1440, height: 1000 };

export type Page = {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  waitForEvent: (method: string, timeoutMs: number) => Promise<void>;
  evaluate: (expression: string) => Promise<unknown>;
  close: () => Promise<void>;
};

export function refuseCodexSandbox(): void {
  if (process.env.CODEX_SANDBOX === "seatbelt") {
    console.error("Run the screenshot capture outside the macOS Codex sandbox to prevent Chrome from crashing.");
    process.exit(1);
  }
}

// Start Chrome with a throwaway profile and attach to one blank page sized to
// the fixture viewport.
export async function openPage(chrome: string): Promise<Page> {
  const profile = mkdtempSync(join(tmpdir(), "corral-cdp-"));
  const child = spawn(chrome, [
    "--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--remote-allow-origins=*",
    `--window-size=${viewport.width},${viewport.height}`, "about:blank",
  ], { stdio: "ignore" });
  const cleanup = async () => {
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
      setTimeout(resolve, 2000);
    });
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Chrome may still hold files. */ }
  };

  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(portFile); i += 1) await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(portFile)) {
    await cleanup();
    throw new Error("Chrome did not expose a DevTools port");
  }
  const [port, wsPath] = readFileSync(portFile, "utf8").split("\n");

  const socket = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("DevTools websocket failed")), { once: true });
  });

  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
  const events: { method: string; sessionId?: string }[] = [];
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data)) as { id?: number; method?: string; sessionId?: string; result?: unknown; error?: { message?: string } };
    if (data.id !== undefined) {
      const call = pending.get(data.id);
      if (!call) return;
      pending.delete(data.id);
      if (data.error) call.reject(new Error(`CDP ${data.error.message ?? "failed"}`));
      else call.resolve(data.result);
      return;
    }
    if (data.method) events.push({ method: data.method, sessionId: data.sessionId });
  });
  const rawSend = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };

  try {
    const { targetId } = await rawSend("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await rawSend("Target.attachToTarget", { targetId, flatten: true });
    const send = (method: string, params: Record<string, unknown> = {}) => rawSend(method, params, sessionId);
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
    return {
      send,
      async waitForEvent(method, timeoutMs) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          if (events.some((event) => event.method === method && event.sessionId === sessionId)) return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`Timed out waiting for ${method}`);
      },
      async evaluate(expression) {
        const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (result?.exceptionDetails) throw new Error(`Page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
        return result?.result?.value;
      },
      async close() {
        socket.close();
        await cleanup();
      },
    };
  } catch (err) {
    socket.close();
    await cleanup();
    throw err;
  }
}
