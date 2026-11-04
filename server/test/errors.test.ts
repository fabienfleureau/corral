import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ErrorCenter } from "../errors.ts";

test("error center keeps the latest failure per source and clears it on recovery", () => {
  const center = new ErrorCenter();
  center.fail("GitLab sync", new Error("authentication failed"));
  center.fail("GitLab sync", new Error("connection refused"));
  assert.equal(center.list().length, 1);
  assert.match(center.list()[0].message, /connection refused/);
  center.clear("GitLab sync");
  assert.deepEqual(center.list(), []);
});

test("GitLab refresh reports failure, retains cached MRs, and clears on recovery", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { refreshPulls, cachedPulls } = await import("../pulls.ts");
  const { errors } = await import("../errors.ts");
  const dir = mkdtempSync(join(tmpdir(), "corral-sync-"));
  const oldPath = process.env.PATH;
  const script = (body: string) => writeFileSync(join(dir, "glab"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  process.env.PATH = dir;
  try {
    script(`case "$2" in user) echo '{"username":"me"}';; *approvals) echo '{"approved_by":[]}';; projects/*) echo '{}';; *) echo '[{"web_url":"https://gitlab.test/a/-/merge_requests/1","title":"MR","state":"opened","iid":1,"project_id":1}]';; esac`);
    await refreshPulls();
    assert.equal(cachedPulls().pulls.length, 1);
    script("echo 'GitLab unavailable' >&2; exit 1");
    await refreshPulls();
    assert.equal(cachedPulls().pulls.length, 1);
    assert.match(errors.list()[0].message, /GitLab unavailable/);
    script(`case "$2" in user) echo '{"username":"me"}';; *) echo '[]';; esac`);
    await refreshPulls();
    assert.deepEqual(errors.list(), []);
    assert.equal(cachedPulls().pulls.length, 0);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
