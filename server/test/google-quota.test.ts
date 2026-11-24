// Google quota on the Usage page: Antigravity local language server discovery,
// Connect RPC parsing, on-demand `agy` startup, and cache behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  GoogleQuotaCache,
  emptyGoogleQuota,
  googleQuota,
  listAntigravityServers,
  listListeningPorts,
  parseLanguageServers,
  parseListeningPorts,
  parseQuotaSummary,
  parseUserStatus,
  postConnectJson,
  probeLanguageServer,
  type LanguageServerProcess,
} from "../google-quota.ts";
import type { AgentQuota } from "../usage.ts";

const now = Date.parse("2026-11-21T12:00:00Z");

test("parseLanguageServers finds agy and Antigravity language_server processes, ignoring wrappers and other tools", () => {
  const ps = [
    "  101     1 /sbin/launchd",
    " 2042  2000 /Users/dev/.windsurf/language_server_macos_arm --csrf_token windsurf-tok --app_data_dir windsurf",
    " 2500  2000 tmux new-session /Users/dev/.local/bin/agy --csrf_token=wrapper-tok",
    " 2600  2000 /opt/homebrew/bin/Python -c import pty /Users/dev/.local/bin/agy --csrf_token=py-tok",
    " 3055  3000 /Users/dev/.local/bin/agy --csrf_token=agy-tok --model gemini-4-neon-medium",
    " 4010  4000 /Applications/Antigravity.app/Contents/Resources/language_server_macos --csrf_token ide-tok --extension_server_port 50123",
    " 4099  4000 /Applications/Antigravity.app/Contents/Resources/language_server_macos --no-token",
  ].join("\n");
  assert.deepEqual(parseLanguageServers(ps), [
    { pid: 3055, ppid: 3000, csrfToken: "agy-tok", extensionPort: null },
    { pid: 4010, ppid: 4000, csrfToken: "ide-tok", extensionPort: 50123 },
  ]);
});

test("parseListeningPorts extracts deduplicated loopback TCP ports from lsof", () => {
  const lsof = [
    "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "agy       3055 dev   12u  IPv4 0x1234      0t0  TCP 127.0.0.1:51234 (LISTEN)",
    "agy       3055 dev   13u  IPv6 0x1235      0t0  TCP [::1]:51234 (LISTEN)",
    "agy       3055 dev   14u  IPv4 0x1236      0t0  TCP localhost:51235 (LISTEN)",
    "agy       3055 dev   15u  IPv4 0x1237      0t0  TCP 127.0.0.1:51236 (ESTABLISHED)",
  ].join("\n");
  assert.deepEqual(parseListeningPorts(lsof), [51234, 51235]);
});

test("listAntigravityServers and listListeningPorts resolve ps and lsof when PATH omits system dirs", async () => {
  const prevPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    let psCmd = "";
    await listAntigravityServers(async (cmd) => {
      psCmd = cmd;
      return "";
    });
    let lsofCmd = "";
    await listListeningPorts(1234, async (cmd) => {
      lsofCmd = cmd;
      return "";
    });
    assert.match(psCmd, /^\/(?:bin|usr\/bin)\/ps$/);
    if (process.platform === "darwin") {
      assert.equal(lsofCmd, "/usr/sbin/lsof");
    } else {
      assert.ok(lsofCmd === "lsof" || /^\/(?:usr\/sbin|sbin|usr\/bin|bin)\/lsof$/.test(lsofCmd));
    }
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  }
});

test("parseQuotaSummary reads model-family buckets with disambiguated labels", () => {
  const payload = {
    response: {
      planName: "Google AI Pro",
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.18, resetTime: new Date(now + 86_400_000).toISOString() },
            { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: 0.964, resetTime: new Date(now + 3_600_000).toISOString() },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.55, resetTime: new Date(now + 86_400_000).toISOString() },
          ],
        },
        {
          displayName: "Gemini 4 Argon",
          buckets: [
            { bucketId: "gemini-argon-wtu-weekly", displayName: "Gemini 4 Argon Weekly Limit", window: "weekly", remainingFraction: 1, resetTime: new Date(now + 86_400_000).toISOString() },
          ],
        },
      ],
    },
  };
  const quota = parseQuotaSummary(payload, now);
  assert.ok(quota);
  assert.equal(quota.agent, "google");
  assert.equal(quota.source, "Antigravity");
  assert.equal(quota.plan, "Google AI Pro");
  assert.equal(quota.stale, false);
  assert.deepEqual(
    quota.windows.map((w) => [w.label, w.used_percent]),
    [
      ["Gemini · Weekly", 82],
      ["Gemini · Five Hour", 3.6],
      ["Claude and GPT · Weekly", 45],
      ["Gemini 4 Argon Weekly", 0],
    ],
  );
  assert.equal(quota.windows[0].resets_ms, now + 86_400_000);
  assert.equal(quota.windows[0].window_ms, 7 * 86_400_000);
  assert.equal(quota.windows[1].window_ms, 5 * 3_600_000);
  assert.equal(quota.windows[2].window_ms, 7 * 86_400_000);
  assert.equal(quota.windows[3].window_ms, 7 * 86_400_000);
  assert.equal(quota.note, null);
});

test("parseQuotaSummary marks stale when a reset has passed and rejects empty payloads", () => {
  const stale = parseQuotaSummary({
    groups: [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.2, resetTime: new Date(now - 60_000).toISOString() }] }],
  }, now);
  assert.ok(stale);
  assert.equal(stale.stale, true);
  assert.equal(stale.windows[0].label, "Gemini · 5h");
  assert.equal(parseQuotaSummary({}, now), null);
});

test("parseUserStatus reads clientModelConfigs fallback and deduplicates labels", () => {
  const payload = {
    userStatus: {
      planStatus: { planInfo: { planDisplayName: "Google AI Ultra" } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.4, resetTime: new Date(now + 3_600_000).toISOString() } },
          { label: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.9, resetTime: new Date(now + 3_600_000).toISOString() } },
          { label: "No Quota Model" },
          { label: "Claude Sonnet", quotaInfo: { remainingFraction: 1, resetTime: new Date(now + 7_200_000).toISOString() } },
        ],
      },
    },
  };
  const quota = parseUserStatus(payload, now);
  assert.ok(quota);
  assert.equal(quota.plan, "Google AI Ultra");
  assert.deepEqual(
    quota.windows.map((w) => [w.label, w.used_percent]),
    [["Gemini 3 Pro", 60], ["Claude Sonnet", 0]],
  );
});

test("probeLanguageServer tries RetrieveUserQuotaSummary then falls back to GetUserStatus", async () => {
  const calls: string[] = [];
  const server: LanguageServerProcess = { pid: 10, ppid: 1, csrfToken: "csrf-1", extensionPort: 40002 };
  const quota = await probeLanguageServer(server, {
    listPorts: async () => [40001],
    post: async (port, path) => {
      calls.push(`${port}:${path.split("/").pop()}`);
      if (port === 40001) return null;
      if (path.endsWith("GetUserStatus")) {
        return { userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: "Gemini", quotaInfo: { remainingFraction: 0.75 } }] } } };
      }
      return null;
    },
    now,
  });
  assert.ok(quota);
  assert.equal(quota.windows[0].used_percent, 25);
  assert.deepEqual(calls, [
    "40001:RetrieveUserQuotaSummary",
    "40001:GetUserStatus",
    "40002:RetrieveUserQuotaSummary",
    "40002:GetUserStatus",
  ]);
});

test("googleQuota uses an already-running language server without starting agy", async () => {
  let spawned = 0;
  const quota = await googleQuota({
    listServers: async () => [{ pid: 99, ppid: 1, csrfToken: "tok", extensionPort: null }],
    listPorts: async () => [50000],
    post: async (_port, path) =>
      path.endsWith("RetrieveUserQuotaSummary")
        ? { response: { groups: [{ displayName: "Gemini Models", buckets: [{ displayName: "Five Hour Limit Remaining", remainingFraction: 0.8 }] }] } }
        : null,
    agyExecutable: "/fake/agy",
    spawnAgy: () => {
      spawned++;
      return { pid: 100, csrfToken: "unused", stop: () => undefined };
    },
    now,
  });
  assert.equal(spawned, 0);
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.windows[0].label, "Gemini · Five Hour");
  assert.equal(quota.windows[0].used_percent, 20);
});

test("googleQuota starts agy temporarily when no language server is running and stops it after probing", async () => {
  let polls = 0;
  let spawned = 0;
  let stopped = 0;
  const quota = await googleQuota({
    listServers: async () => {
      polls++;
      // Initial scan finds nothing; after agy starts, second poll finds the server.
      if (polls < 3) return [];
      return [{ pid: 777, ppid: 700, csrfToken: "boot-tok", extensionPort: null }];
    },
    listPorts: async () => [55555],
    post: async (_port, path, csrf) => {
      assert.equal(csrf, "boot-tok");
      if (path.endsWith("RetrieveUserQuotaSummary")) {
        return { response: { groups: [{ displayName: "Gemini Models", buckets: [{ displayName: "Weekly Limit Remaining", remainingFraction: 0.65 }] }] } };
      }
      return null;
    },
    agyExecutable: "/fake/agy",
    spawnAgy: () => {
      spawned++;
      return { pid: 700, csrfToken: "boot-tok", stop: () => { stopped++; } };
    },
    pollIntervalMs: 1,
    startTimeoutMs: 500,
    sleep: async () => undefined,
    now,
  });
  assert.equal(spawned, 1);
  assert.equal(stopped, 1);
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.windows[0].label, "Gemini · Weekly");
  assert.equal(quota.windows[0].used_percent, 35);
});

test("googleQuota returns a note when agy is missing and stops agy on timeout", async () => {
  const missing = await googleQuota({ listServers: async () => [], agyExecutable: null, now });
  assert.match(missing.note ?? "", /Install Antigravity CLI/);

  let stopped = 0;
  const timedOut = await googleQuota({
    listServers: async () => [],
    agyExecutable: "/fake/agy",
    spawnAgy: () => ({ pid: 800, csrfToken: "boot-tok", stop: () => { stopped++; } }),
    pollIntervalMs: 1,
    startTimeoutMs: 0,
    sleep: async () => undefined,
    now,
  });
  assert.equal(stopped, 1);
  assert.match(timedOut.note ?? "", /did not report quota/);
});

test("postConnectJson sends Connect headers and falls back from HTTPS to HTTP on loopback", async () => {
  let receivedHeaders: http.IncomingHttpHeaders = {};
  const srv = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ response: { groups: [{ buckets: [{ displayName: "Gemini", remainingFraction: 0.5 }] }] } }));
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    const addr = srv.address();
    assert.ok(addr && typeof addr === "object");
    const data = await postConnectJson(addr.port, "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary", "secret-csrf", {});
    assert.equal(receivedHeaders["x-codeium-csrf-token"], "secret-csrf");
    assert.equal(receivedHeaders["connect-protocol-version"], "1");
    assert.equal(receivedHeaders["content-type"], "application/json");
    assert.ok(data?.response?.groups);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test("GoogleQuotaCache shares the probe and retries after a short failure pause", async () => {
  let calls = 0;
  let time = 0;
  const snapshot: AgentQuota = { ...emptyGoogleQuota(""), as_of_ms: 1, stale: false, plan: null, windows: [], note: null };
  const cache = new GoogleQuotaCache({ clock: () => time, fetchQuota: async () => { calls++; return snapshot; } });
  assert.deepEqual((await Promise.all([cache.get(), cache.get(), cache.get()])).map((q) => q.as_of_ms), [1, 1, 1]);
  assert.equal(calls, 1);
  time += 61_000;
  await cache.get();
  assert.equal(calls, 2);

  let failures = 0;
  const broken = new GoogleQuotaCache({ clock: () => time, fetchQuota: async () => { failures++; throw new Error("server down"); } });
  assert.match((await broken.get()).note ?? "", /Could not reach Antigravity/);
  await broken.get();
  assert.equal(failures, 1);
  time += 11_000;
  await broken.get();
  assert.equal(failures, 2);
});
