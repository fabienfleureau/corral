import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { isRepeatSnoozed, openInboxItems, repeatSnoozedFirst } from "../../web/src/inbox-selection.ts";
import type { Item } from "../types.ts";
import type { Item as WebItem } from "../../web/src/types.ts";

function item(id: string, over: Partial<Item> = {}): Item {
  const now = Date.now();
  return {
    id, kind: "question", status: "open", title: id, summary: "", body: "", context: "", options: null,
    ready: 1, handling: 0, source_ref: null, task_id: null, structured: 1,
    created_ms: now, updated_ms: now, resolved_ms: null, snooze_until_ms: null, ...over,
  };
}

test("each snooze through the API counts on the item", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-repeat-snooze-"));
  const db = new Db(join(dir, "corral.db"));
  const hub = { broadcast: () => undefined };
  const server = createHttpServer({ db, hub, cfg: { token: "test" } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    db.insertItem(item("q1"));
    const snooze = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/items/q1/snooze`, {
        method: "POST",
        headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
        body: JSON.stringify({ until_ms: Date.now() + 3_600_000 }),
      });
      return (await res.json()) as Item;
    };
    assert.equal((await snooze()).snooze_count, 1);
    const second = await snooze();
    assert.equal(second.snooze_count, 2);
    assert.ok(second.snooze_until_ms! > Date.now());
    assert.equal(isRepeatSnoozed(second as unknown as WebItem), true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migration backfills snooze counts from the metrics log", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-repeat-snooze-"));
  const path = join(dir, "corral.db");
  try {
    // A database from before the column existed.
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', source_ref TEXT, task_id TEXT, structured INTEGER NOT NULL DEFAULT 0,
      created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, resolved_ms INTEGER, snooze_until_ms INTEGER)`);
    old.exec(`CREATE TABLE metrics_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, name TEXT NOT NULL, ref TEXT, data TEXT)`);
    old.exec(`INSERT INTO items (id, kind, title, created_ms, updated_ms) VALUES ('twice', 'question', 'q', 1, 1), ('never', 'pr', 'p', 1, 1)`);
    old.exec(`INSERT INTO metrics_events (ts, name, ref) VALUES (1, 'item.snoozed', 'twice'), (2, 'item.snoozed', 'twice'), (3, 'item.resolved', 'never')`);
    old.close();

    const db = new Db(path);
    assert.equal(db.getItem("twice")?.snooze_count, 2);
    assert.equal(db.getItem("never")?.snooze_count, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeatedly snoozed items sort ahead of the rest, keeping order otherwise", () => {
  const webItem = (id: string, over: Partial<WebItem> = {}): WebItem => ({ ...item(id), elicitation: null, handling: 0, ...over } as WebItem);
  const a = webItem("a");
  const b = webItem("b", { snooze_count: 1 });
  const c = webItem("c", { snooze_count: 2 });
  const d = webItem("d", { snooze_count: 3 });
  assert.deepEqual(repeatSnoozedFirst([a, b, c, d]).map((i) => i.id), ["c", "d", "a", "b"]);
  const handled = webItem("h", { snooze_count: 5, handling: 1 });
  assert.deepEqual(openInboxItems([a, handled, c]).map((i) => i.id), ["c", "a"]);
});
