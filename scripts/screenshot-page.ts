// Capture one page from the screenshot fixture through the Chrome DevTools
// Protocol. `chrome --screenshot` fires as soon as the page has loaded, which
// races pages that fetch after mount, so this waits for an optional settle
// expression instead.
// An optional prepare expression puts the page into the state to capture
// (selecting text, opening a panel) before that wait starts.

import { writeFileSync } from "node:fs";
import { openPage, refuseCodexSandbox } from "./cdp.ts";

const [chrome, url, output, settleExpression = "true", settleTimeoutMs = "10000", prepareExpression = ""] = process.argv.slice(2);
if (!chrome || !url || !output) {
  console.error("Usage: screenshot-page.ts <chrome> <url> <output.png> [settle-expression] [timeout-ms] [prepare-expression]");
  process.exit(2);
}
refuseCodexSandbox();

const page = await openPage(chrome);
try {
  await page.send("Page.navigate", { url });
  await page.waitForEvent("Page.loadEventFired", Number(settleTimeoutMs));
  // Put the page in the state to capture before waiting for it to settle.
  if (prepareExpression.trim()) {
    await page.evaluate(prepareExpression);
  }
  // Let post-mount fetches land; settleExpression decides when the page is done.
  const deadline = Date.now() + Number(settleTimeoutMs);
  await new Promise((r) => setTimeout(r, 150));
  let settled = false;
  while (Date.now() < deadline) {
    if (await page.evaluate(`Boolean(${settleExpression})`) === true) { settled = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!settled) throw new Error(`Page did not settle: ${settleExpression}`);
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(output, Buffer.from(data, "base64"));
} finally {
  await page.close();
}
console.log(`Saved ${output}`);
