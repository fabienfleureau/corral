// Capture one page from the screenshot fixture through the Chrome DevTools
// Protocol. `chrome --screenshot` fires as soon as the page has loaded, which
// races pages that fetch after mount (benchmarks waits for the harness
// catalog), so this waits for an optional settle expression instead.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [chrome, url, output, settleExpression = "true", settleTimeoutMs = "10000"] = process.argv.slice(2);
if (!chrome || !url || !output) {
  console.error("Usage: screenshot-page.ts <chrome> <url> <output.png> [settle-expression] [timeout-ms]");
  process.exit(2);
}

if (process.env.CODEX_SANDBOX === "seatbelt") {
  console.error("Run the screenshot capture outside the macOS Codex sandbox to prevent Chrome from crashing.");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "corral-cdp-"));
const child = spawn(chrome, [
  "--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
  "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--remote-allow-origins=*",
  "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });

const portFile = join(profile, "DevToolsActivePort");
for (let i = 0; i < 200 && !existsSync(portFile); i += 1) await new Promise((r) => setTimeout(r, 50));
if (!existsSync(portFile)) {
  child.kill();
  rmSync(profile, { recursive: true, force: true });
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
    if (data.error) call.reject(new Error(`CDP ${data.method ?? ''} ${data.error.message ?? 'failed'}`));
    else call.resolve(data.result);
    return;
  }
  if (data.method) events.push({ method: data.method, sessionId: data.sessionId });
});
function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function waitForEvent(method: string, sessionId: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (events.some((event) => event.method === method && event.sessionId === sessionId)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${method}`);
}

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  await waitForEvent("Page.loadEventFired", sessionId, Number(settleTimeoutMs));
  // Let post-mount fetches land; settleExpression decides when the page is done.
  const deadline = Date.now() + Number(settleTimeoutMs);
  await new Promise((r) => setTimeout(r, 150));
  let settled = false;
  while (Date.now() < deadline) {
    const result = await send("Runtime.evaluate", { expression: `Boolean(${settleExpression})`, returnByValue: true }, sessionId);
    if (result?.result?.value === true) { settled = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!settled) throw new Error(`Page did not settle: ${settleExpression}`);
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(output, Buffer.from(data, "base64"));
} finally {
  socket.close();
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(resolve, 2000);
  });
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Chrome may still hold files. */ }
}
console.log(`Saved ${output}`);
