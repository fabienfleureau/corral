import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshPulls, cachedPulls } from "../pulls.ts";

test("GitHub listing avoids thread queries when checks already determine the color", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-quota-"));
  const oldPath = process.env.PATH;
  const log = join(dir, "calls");
  writeFileSync(join(dir, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  "api user") echo '{"login":"me"}' ;;
  "search prs") echo '[{"url":"https://github.com/acme/app/pull/1"},{"url":"https://github.com/acme/app/pull/2"}]' ;;
  "pr view")
    case "$3" in */1) check=FAILURE;; *) check=SUCCESS;; esac
    echo "{\\"title\\":\\"PR\\",\\"url\\":\\"$3\\",\\"number\\":1,\\"state\\":\\"OPEN\\",\\"author\\":{\\"login\\":\\"me\\"},\\"reviews\\":[{}],\\"statusCheckRollup\\":[{\\"conclusion\\":\\"$check\\"}],\\"updatedAt\\":\\"2025-01-01T00:00:00Z\\"}" ;;
  "api graphql") echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, "glab"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  process.env.PATH = dir;
  try {
    await refreshPulls();
    assert.deepEqual(cachedPulls().pulls.map((p) => p.color).sort(), ["green", "red"]);
    const calls = readFileSync(log, "utf8").split("\n");
    assert.equal(calls.filter((line) => line.startsWith("api graphql ")).length, 1);
    assert.ok(calls.some((line) => line === "api user --cache 1h"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
