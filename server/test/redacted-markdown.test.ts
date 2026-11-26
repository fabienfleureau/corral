// Redaction is the boundary between local Corral evidence and a shareable
// report. These cases are the leaks it must never let through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactMarkdown } from "../../shared/redacted-markdown.ts";

test("home and worktree paths are replaced, URLs and API routes stay", () => {
  const out = redactMarkdown([
    "Read `/Users/ffleureau/workspace/perso/corral-worktrees/corral-x-ed2e4d/server/api.ts`.",
    "Config: $HOME/.config/corral/config.json and ~/workspace/perso/notes.md.",
    "Branch worktree: /mnt/data/project-worktrees/feat-x.",
    "PR: https://github.com/example/project/pull/58",
    "POST /api/reports and web/src/TaskHistory.tsx are not local paths.",
  ].join("\n"));
  assert.doesNotMatch(out, /ffleureau|config\.json|corral-x-ed2e4d|project-worktrees|notes\.md/);
  assert.match(out, /\[local path\]/);
  assert.match(out, /https:\/\/github\.com\/example\/project\/pull\/58/);
  assert.match(out, /POST \/api\/reports and web\/src\/TaskHistory\.tsx/);
});

test("Windows paths and file URLs are local too", () => {
  const out = redactMarkdown("See C:\\Users\\fabien\\repo\\.env and [plan](file:///Users/fabien/plan.md).");
  assert.doesNotMatch(out, /Users\\fabien|Users\/fabien|file:\/\//);
  assert.equal(out.match(/\[local path\]/g)?.length, 2);
});

test("bearer tokens, named secrets and token query values are removed", () => {
  const out = redactMarkdown([
    "Authorization: Bearer c3f6eb4fce829ec4820b3f4d963985f6d71a1749b631eb44",
    '"api_key": "sk-abcdefghijklmnopqrstuvwx"',
    "token: ghp_123456789012345678901234567890123456",
    "--password hunter2see https://example.com/cb?token=secretvalue123&state=ok",
    "JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturevalue1234",
  ].join("\n"));
  assert.doesNotMatch(out, /c3f6eb4f|sk-abcdef|ghp_1234|hunter2see|secretvalue123|signaturevalue1234/);
  assert.match(out, /Authorization: \[redacted\]/);
  assert.match(out, /"api_key": "\[redacted\]"/);
  assert.match(out, /state=ok/);
  assert.doesNotMatch(out, /Bearer [a-z0-9]/);
});

test("raw shell transcripts are omitted by default, with the prose around them kept", () => {
  const out = redactMarkdown([
    "# Investigation",
    "",
    "Ran the suite:",
    "",
    "```bash",
    "$ export TOKEN=abc123456789",
    "$ npm test -- --run",
    "> 12 tests passed",
    "```",
    "",
    "Then:",
    "",
    "$ git status",
    "On branch main",
    "",
    "Conclusion: safe to share.",
  ].join("\n"));
  assert.equal(out.match(/\[shell transcript omitted\]/g)?.length, 2);
  assert.doesNotMatch(out, /TOKEN=|npm test|git status|On branch main/);
  assert.match(out, /# Investigation/);
  assert.match(out, /Ran the suite:/);
  assert.match(out, /Conclusion: safe to share\./);
});

test("opted-in transcripts keep the commands but still lose paths and secrets", () => {
  const out = redactMarkdown("$ cat /Users/fabien/.config/corral/config.json && export TOKEN=abc123456789\non branch main", {
    includeShellTranscripts: true,
  });
  assert.match(out, /^\$ cat \[local path\]/);
  assert.match(out, /TOKEN: \[redacted\]|TOKEN=\[redacted\]/);
  assert.doesNotMatch(out, /abc123456789|fabien/);
});

test("redaction is idempotent and does not eat Markdown structure", () => {
  const text = [
    "## Findings",
    "",
    "- **Verified** on [the PR](https://example.com/pull/12).",
    "- Relative path `web/src/TaskHistory.tsx` is fine.",
    "",
    "$ ls /Users/fabien/repo",
    "",
    "Done.",
  ].join("\n");
  const once = redactMarkdown(text);
  assert.equal(redactMarkdown(once), once);
  assert.match(once, /^## Findings/);
  assert.match(once, /- \*\*Verified\*\* on \[the PR\]/);
  assert.match(once, /Done\./);
});
