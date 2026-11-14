// Record the README demo GIF: a scripted tour of the screenshot fixture
// (inbox → tasks → pull requests), captured frame by frame over the Chrome
// DevTools Protocol and encoded with ffmpeg. Run it through
// capture-screenshot.sh with a .gif output; never point it at the live app.
// The tour only selects, types and filters: nothing it clicks dispatches a
// task, answers an agent or calls an LLM.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPage, refuseCodexSandbox, viewport } from "./cdp.ts";

const [chrome, url, output] = process.argv.slice(2);
if (!chrome || !url || !output) {
  console.error("Usage: record-demo.ts <chrome> <fixture-url> <output.gif>");
  process.exit(2);
}
refuseCodexSandbox();
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
if (spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status !== 0) {
  console.error("ffmpeg is required to encode the GIF; set FFMPEG to its path.");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frameDir = mkdtempSync(join(tmpdir(), "corral-demo-"));
// Runs on success and on any thrown error, so failed attempts leave no frames.
process.on("exit", () => rmSync(frameDir, { recursive: true, force: true }));
const frames: { file: string; seconds: number }[] = [];
const page = await openPage(chrome);
let cursor = { x: viewport.width / 2, y: viewport.height / 2 };

// A drawn pointer and caption: headless Chrome renders neither a cursor nor
// any hint of what the viewer is looking at.
const overlay = `(() => {
  if (document.getElementById("demo-cursor")) return;
  const style = document.createElement("style");
  style.textContent = \`
    #demo-cursor { position: fixed; z-index: 2147483647; pointer-events: none; width: 22px; height: 22px;
      margin: -3px 0 0 -3px; filter: drop-shadow(0 1px 2px rgb(0 0 0 / .35)); }
    #demo-cursor.press::after { content: ""; position: absolute; left: -11px; top: -11px; width: 28px; height: 28px;
      border-radius: 50%; background: rgb(59 91 219 / .35); }
    #demo-caption { position: fixed; z-index: 2147483646; pointer-events: none; left: 50%; bottom: 28px;
      transform: translateX(-50%); padding: 10px 20px; border-radius: 999px; background: rgb(17 24 39 / .88);
      color: #fff; font: 600 20px/1.3 system-ui, sans-serif; white-space: nowrap; }
    #demo-caption:empty { display: none; }\`;
  document.head.append(style);
  const pointer = document.createElement("div");
  pointer.id = "demo-cursor";
  pointer.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l14 9-6.5 1.3L7.6 19z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const caption = document.createElement("div");
  caption.id = "demo-caption";
  document.body.append(pointer, caption);
})()`;

async function shot(seconds: number): Promise<void> {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  const file = join(frameDir, `${String(frames.length).padStart(4, "0")}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  frames.push({ file, seconds });
}

async function waitFor(expression: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`Boolean(${expression})`) === true) return;
    await sleep(100);
  }
  throw new Error(`Page did not settle: ${expression}`);
}

async function setPointer(x: number, y: number, pressed = false): Promise<void> {
  await page.evaluate(`(() => {
    const p = document.getElementById("demo-cursor");
    p.style.left = "${x}px"; p.style.top = "${y}px";
    p.classList.toggle("press", ${pressed});
  })()`);
}

async function caption(text: string): Promise<void> {
  await page.evaluate(`document.getElementById("demo-caption").textContent = ${JSON.stringify(text)}`);
}

// Center of the first element matching `selector` whose text contains `text`.
async function locate(selector: string, text: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.textContent.includes(${JSON.stringify(text)}) && e.getClientRects().length);
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2) };
  })()`) as { x: number; y: number } | null;
  if (!point) throw new Error(`No ${selector} containing "${text}"`);
  return point;
}

// Glide the pointer to the target, press it, and capture the result.
async function click(selector: string, text: string, settle = "true"): Promise<void> {
  const target = await locate(selector, text);
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await setPointer(Math.round(cursor.x + (target.x - cursor.x) * ease), Math.round(cursor.y + (target.y - cursor.y) * ease));
    await shot(0.05);
  }
  cursor = target;
  await setPointer(target.x, target.y, true);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x: target.x, y: target.y, button: "left", clickCount: 1 });
  }
  await shot(0.15);
  await setPointer(target.x, target.y);
  await waitFor(settle);
  await sleep(250);
}

// Type into the focused field one character at a time; React only sees input
// events, so assigning .value would not reach its state.
async function type(text: string): Promise<void> {
  for (let i = 0; i < text.length; i += 1) {
    await page.send("Input.insertText", { text: text[i] });
    if (i % 2 === 1 || i === text.length - 1) await shot(0.07);
  }
}

try {
  await page.send("Page.navigate", { url });
  await page.waitForEvent("Page.loadEventFired", 10000);
  await waitFor(`document.querySelectorAll(".item-list .item-row").length >= 5`);
  await page.evaluate(overlay);
  await setPointer(cursor.x, cursor.y);

  await caption("Everything your agents need from you, in one inbox");
  await shot(2.6);
  await caption("Agents ask questions with one-click answers");
  await shot(2.2);

  await caption("Every task keeps its history, from dispatch to PR");
  await click("button", "History", "document.querySelector('dialog[open]')");
  await shot(2.6);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor("!document.querySelector('dialog[open]')");

  await caption("Review a multi-repo plan before it fans out");
  await click(".item-row", "Add a size to widgets");
  await shot(2.6);

  await caption("A PR shows up once its checks and reviews pass");
  await click(".item-row", "rank results by recency");
  await shot(2.6);

  await caption("Until then it stays with the agent to fix");
  await click(".item-row", "refresh expired session");
  await shot(2.4);

  await caption("Write a task, pick a harness, dispatch");
  await click(".nav-item", "Tasks", `document.querySelector('textarea[placeholder="What should the agent do?"]')`);
  await click('textarea[placeholder="What should the agent do?"]', "");
  await type("Add a dark mode toggle to the settings page");
  await shot(2.2);

  await caption("All your PRs and MRs, GitHub and GitLab");
  await click(".nav-item", "Pull Requests", "document.querySelector('.chip-row')");
  await shot(2.4);
  await caption("Spot the failing ones at a glance");
  await click(".chip-row .chip", "Failing");
  await shot(2.4);

  await caption("Corral: the work layer over your coding agents");
  await click(".nav-item", "Inbox", `document.querySelectorAll(".item-list .item-row").length >= 5`);
  await shot(3);
} catch (err) {
  // Keep the frame the tour stopped on: it usually shows why.
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${output}.failed.png`, Buffer.from(data, "base64"));
  console.error(`Tour failed; last frame in ${output}.failed.png`);
  throw err;
} finally {
  await page.close();
}

// The concat demuxer ignores the last entry's duration unless the file is
// listed once more.
const list = frames.map((f) => `file '${f.file}'\nduration ${f.seconds}`).join("\n") + `\nfile '${frames.at(-1)?.file}'\n`;
writeFileSync(join(frameDir, "frames.txt"), list);
const encoded = spawnSync(ffmpeg, [
  "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(frameDir, "frames.txt"),
  "-vf", "scale=1080:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
  "-fps_mode", "vfr", "-loop", "0", output,
], { stdio: "inherit" });
if (encoded.status !== 0) throw new Error("ffmpeg failed to encode the GIF");
console.log(`Saved ${output} (${frames.length} frames)`);
