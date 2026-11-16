import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';

test('daily activity includes only registered professional repositories and the requested interval', () => {
  const db = new Db(':memory:');
  try {
    db.raw.exec(`INSERT INTO repos (id,name,path,created_ms,context) VALUES ('r','Work','/work',0,'professional'),('p','Home','/home',0,'personal'),('legacy','Legacy','/legacy',0,NULL);
      INSERT INTO tasks (id,title,repo_path,created_ms,updated_ms) VALUES ('a','Work task','/work',0,0),('b','Private task','/home',0,0),('c','Legacy task','/legacy',0,0),('d','Unknown','/unknown',0,0);
      INSERT INTO task_events (task_id,ts,kind,message) VALUES ('a',100,'pr','Opened PR'),('a',200,'status','Done'),('b',100,'created','Created'),('c',199,'created','Created'),('d',100,'created','Created');`);
    const rows = db.listDailyActivity(100, 200);
    assert.deepEqual(rows.map(r => [r.task_id, r.message]), [['a', 'Opened PR'], ['c', 'Created']]);
  } finally { db.close(); }
});
