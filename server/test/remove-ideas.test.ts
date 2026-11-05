import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";

test("opening an existing database removes saved ideas without affecting tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-ideas-migration-"));
  const path = join(dir, "corral.db");
  try {
    const initial = new Db(path);
    initial.raw.exec("CREATE TABLE ideas (id TEXT PRIMARY KEY, text TEXT); INSERT INTO ideas VALUES ('1', 'old idea')");
    initial.raw.exec("INSERT INTO tasks (id, title, created_ms, updated_ms) VALUES ('task', 'keep', 1, 1)");
    initial.close();
    const migrated = new Db(path);
    assert.equal(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ideas'").get(), undefined);
    assert.equal(migrated.raw.prepare("SELECT title FROM tasks WHERE id = 'task'").get()?.title, "keep");
    migrated.close();
    const reopened = new Db(path);
    assert.equal(reopened.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ideas'").get(), undefined);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
