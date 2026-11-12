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
  // GitHub answers, so this test stays about the GitLab sync.
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho '{"login":"me"}'\n`, { mode: 0o755 });
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

test("a failing platform keeps its last listing instead of emptying the page", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { refreshPulls, cachedPulls } = await import("../pulls.ts");
  const dir = mkdtempSync(join(tmpdir(), "corral-sync-"));
  const oldPath = process.env.PATH;
  const gh = (body: string) => writeFileSync(join(dir, "gh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "glab"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  process.env.PATH = dir;
  try {
    gh(`case "$1 $2" in
  "api user") echo '{"login":"me"}';;
  "search prs") echo '[{"url":"https://github.com/acme/app/pull/7"}]';;
  "pr view") echo '{"title":"feat: x","url":"https://github.com/acme/app/pull/7","number":7,"state":"OPEN","isDraft":false,"author":{"login":"them"},"reviewDecision":null,"reviews":[{"state":"APPROVED"}],"statusCheckRollup":[{"conclusion":"SUCCESS"}],"mergeable":"MERGEABLE","updatedAt":"2025-01-01T00:00:00Z"}';;
  "api graphql") echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}';;
  *) echo '[]';;
esac`);
    await refreshPulls();
    assert.equal(cachedPulls().pulls.length, 1);
    gh("echo 'gh: not found' >&2; exit 1");
    await refreshPulls();
    assert.equal(cachedPulls().pulls.length, 1, "the GitHub listing survives an unreachable gh");
    assert.equal(cachedPulls().pulls[0].url, "https://github.com/acme/app/pull/7");
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
