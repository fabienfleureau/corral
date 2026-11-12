// The Usage page shows how much GitHub/GitLab API quota the PR loop has left.
// Both platforms answer in different shapes: GitHub with a JSON resource list,
// GitLab only with response headers. Malformed answers must degrade to "no
// windows" rather than throwing, so the page keeps rendering the agent quotas.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubRateLimit, parseGitLabRateHeaders } from "../pulls.ts";

test("GitHub: keeps the resources the PR loop spends, in a stable order", () => {
  const json = JSON.stringify({
    resources: {
      graphql: { limit: 5000, used: 5000, remaining: 0, reset: 1_794_526_227 },
      core: { limit: 5000, used: 21, remaining: 4979, reset: 1_794_525_724 },
      search: { limit: 30, used: 0, remaining: 30, reset: 1_794_525_687 },
      // Resources Corral never calls are dropped.
      actions_runner_registration: { limit: 10_000, used: 0, remaining: 10_000, reset: 1_794_529_227 },
    },
  });
  assert.deepEqual(parseGitHubRateLimit(json), [
    { name: "core", limit: 5000, remaining: 4979, reset_ms: 1_794_525_724_000 },
    { name: "search", limit: 30, remaining: 30, reset_ms: 1_794_525_687_000 },
    { name: "graphql", limit: 5000, remaining: 0, reset_ms: 1_794_526_227_000 },
  ]);
});

test("GitHub: a missing or empty payload yields no windows", () => {
  assert.deepEqual(parseGitHubRateLimit("{}"), []);
  assert.deepEqual(parseGitHubRateLimit('{"resources":{"core":{"limit":0,"remaining":0}}}'), []);
});

test("GitLab: reads the authenticated throttle from the response headers", () => {
  const output = [
    "HTTP/2.0 200 OK",
    "Content-Type: application/json",
    "RateLimit-Limit: 2000",
    "RateLimit-Name: throttle_authenticated_api",
    "RateLimit-Observed: 300",
    "RateLimit-Remaining: 1700",
    "RateLimit-Reset: 1794525660",
    "",
    '{"id":21667289,"username":"someone"}',
  ].join("\n");
  assert.deepEqual(parseGitLabRateHeaders(output), [
    { name: "authenticated api", limit: 2000, remaining: 1700, reset_ms: 1_794_525_660_000 },
  ]);
});

test("GitLab: a body or a throttled response without headers yields no windows", () => {
  assert.deepEqual(parseGitLabRateHeaders('{"id":1}'), []);
  assert.deepEqual(parseGitLabRateHeaders("HTTP/2.0 429 Too Many Requests\nContent-Type: application/json\n\n{}"), []);
});
