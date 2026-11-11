import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("screenshot capture refuses to launch Chrome in the macOS Codex sandbox", () => {
  const result = spawnSync(process.execPath, ["scripts/screenshot-page.ts", "/nonexistent/chrome", "http://127.0.0.1", "/tmp/unused.png"], {
    env: { ...process.env, CODEX_SANDBOX: "seatbelt" },
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside.*sandbox/i);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});
