import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownFileError, MAX_MARKDOWN_FILE_BYTES, readMarkdownFile } from "../markdown-file.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { Db } from "../db.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "corral-md-"));
  const md = join(dir, "plan.md");
  writeFileSync(md, "# Plan\n\nUse `/tmp/other.md`.\n");
  writeFileSync(join(dir, "notes.txt"), "not markdown");
  writeFileSync(join(dir, "big.md"), "x".repeat(MAX_MARKDOWN_FILE_BYTES + 1));
  mkdirSync(join(dir, "folder.md"));
  symlinkSync(join(dir, "notes.txt"), join(dir, "alias.md"));
  return { dir, md };
}

function statusOf(path: unknown): number {
  try {
    readMarkdownFile(path);
    return 200;
  } catch (err) {
    assert.ok(err instanceof MarkdownFileError);
    return err.status;
  }
}

test("readMarkdownFile serves a bounded, absolute Markdown file as text", () => {
  const { dir, md } = fixture();
  try {
    assert.deepEqual(readMarkdownFile(md), { path: md, content: "# Plan\n\nUse `/tmp/other.md`.\n" });
    assert.deepEqual(readMarkdownFile(`  ${md}  `), { path: md, content: "# Plan\n\nUse `/tmp/other.md`.\n" });
    assert.equal(statusOf("notes.md"), 400);
    assert.equal(statusOf(join(dir, "notes.txt")), 400);
    assert.equal(statusOf(join(dir, "missing.md")), 404);
    assert.equal(statusOf(join(dir, "folder.md")), 400);
    assert.equal(statusOf(join(dir, "big.md")), 413);
    assert.equal(statusOf(join(dir, "alias.md")), 400);
    assert.equal(statusOf(null), 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markdown files are served through the token-protected API", async () => {
  const { dir, md } = fixture();
  const db = new Db(join(dir, "test.db"));
  const server = createHttpServer({ db, cfg: { token: "test" } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = (path: string) => `http://127.0.0.1:${port}/api/markdown-file?path=${encodeURIComponent(path)}`;
  try {
    const anonymous = await fetch(url(md));
    assert.equal(anonymous.status, 401);
    const headers = { Authorization: "Bearer test" };
    const ok = await fetch(url(md), { headers });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { path: md, content: "# Plan\n\nUse `/tmp/other.md`.\n" });
    assert.equal((await fetch(url(join(dir, "notes.txt")), { headers })).status, 400);
    assert.equal((await fetch(url(join(dir, "missing.md")), { headers })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
