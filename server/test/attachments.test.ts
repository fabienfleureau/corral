// Files attached to a task prompt: validation, storage with the task, delivery
// to the worker at dispatch, and the omnigent upload.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Db } from "../db.ts";
import { dispatchTask } from "../dispatch.ts";
import type { Config } from "../config.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { OmnigentBackend } from "../omnigent.ts";
import { ATTACHMENT_LIMITS, IMAGE_TYPES, MAX_ATTACHMENTS, TEXT_EXTENSIONS, TEXT_LIKE_APPLICATION, MAX_ATTACHMENT_TOTAL_BYTES, checkAttachments, classifyAttachment, formatBytes, safeFilename } from "../attachments.ts";
import * as web from "../../web/src/attachments.ts";
import type { WorkerBackend, WorkerSession, WorkerStart } from "../worker.ts";
import type { Task } from "../types.ts";

const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64");
const file = (filename: string, content_type: string, data: string | Buffer = "x") => ({ filename, content_type, data: b64(data) });

test("classifyAttachment: images, PDF and text/code only", () => {
  assert.equal(classifyAttachment("shot.png", "image/png"), "image");
  assert.equal(classifyAttachment("scan.pdf", ""), "pdf");
  assert.equal(classifyAttachment("notes.txt", "text/plain"), "text");
  assert.equal(classifyAttachment("data.json", "application/json"), "text");
  // A browser reports .ts as video/mp2t and .rs as nothing at all.
  assert.equal(classifyAttachment("main.ts", "video/mp2t"), "text");
  assert.equal(classifyAttachment("lib.rs", ""), "text");
  // Providers read these four image types only; an SVG is text the agent can read.
  assert.equal(classifyAttachment("shot.jpg", "image/jpeg"), "image");
  assert.equal(classifyAttachment("photo.heic", "image/heic"), null);
  assert.equal(classifyAttachment("scan.tiff", "image/tiff"), null);
  assert.equal(classifyAttachment("logo.svg", "image/svg+xml"), "text");
  assert.equal(classifyAttachment("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"), null);
  assert.equal(classifyAttachment("bundle.zip", "application/zip"), null);
  assert.equal(classifyAttachment("tool", "application/octet-stream"), null);
});

test("the web copy of the rules agrees with the server", () => {
  assert.deepEqual(web.ATTACHMENT_LIMITS, ATTACHMENT_LIMITS);
  assert.equal(web.MAX_ATTACHMENTS, MAX_ATTACHMENTS);
  assert.equal(web.MAX_ATTACHMENT_TOTAL_BYTES, MAX_ATTACHMENT_TOTAL_BYTES);
  // The tables themselves, so a type added to one copy cannot go unnoticed.
  assert.deepEqual([...web.IMAGE_TYPES].sort(), [...IMAGE_TYPES].sort());
  assert.deepEqual([...web.TEXT_LIKE_APPLICATION].sort(), [...TEXT_LIKE_APPLICATION].sort());
  assert.deepEqual([...web.TEXT_EXTENSIONS].sort(), [...TEXT_EXTENSIONS].sort());
  const samples: [string, string][] = [
    ["shot.png", "image/png"], ["", "image/webp"], ["scan.PDF", ""], ["scan", "application/pdf"], ["notes.txt", "text/plain"],
    ["data.json", "application/json"], ["nb.ipynb", "application/x-ipynb+json"], ["main.ts", "video/mp2t"], ["lib.rs", ""],
    ["Dockerfile.dockerfile", "application/octet-stream"], ["deck.pptx", "application/vnd.ms-powerpoint"], ["a.zip", "application/zip"],
    ["tool", "application/octet-stream"], ["p.heic", "image/heic"], ["l.svg", "image/svg+xml"], ["x.csv", "application/vnd.ms-excel"], ["page.html", "text/html; charset=utf-8"],
  ];
  for (const [name, type] of samples) assert.equal(web.classifyAttachment(name, type), classifyAttachment(name, type), `${name} (${type})`);
  for (const bytes of [0, 1023, 1024, 2048, 1024 * 1024 - 1, 5 * 1024 * 1024]) assert.equal(web.formatBytes(bytes), formatBytes(bytes));
});

test("safeFilename drops directories and the characters omnigent's marker regex trips on", () => {
  assert.equal(safeFilename("../../etc/passwd"), "passwd");
  assert.equal(safeFilename("C:\\Users\\me\\shot.png"), "shot.png");
  assert.equal(safeFilename("a[1]\n.png"), "a_1__.png");
  assert.equal(safeFilename(".."), "file");
  // A long name loses part of its stem, never its extension.
  const long = safeFilename(`${"a".repeat(300)}.ts`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith(".ts"));
  // Filesystems limit bytes: a CJK name of 104 characters is 312 bytes.
  const cjk = safeFilename(`${"界".repeat(100)}.txt`);
  assert.ok(Buffer.byteLength(cjk) <= 200, `${Buffer.byteLength(cjk)} bytes`);
  assert.ok(cjk.endsWith(".txt"));
  assert.equal(safeFilename("naïve résumé.md"), "naïve résumé.md");
  assert.equal(safeFilename(""), "file");
});

test("checkAttachments decodes valid files and normalizes mislabelled text", () => {
  const result = checkAttachments([file("a.png", "image/png", "png-bytes"), file("main.ts", "video/mp2t", "let x = 1;")]);
  assert.ok(result.ok);
  assert.deepEqual(result.files.map((f) => [f.filename, f.content_type, f.data.toString()]), [
    ["a.png", "image/png", "png-bytes"],
    ["main.ts", "text/plain", "let x = 1;"],
  ]);
  // The extension is what rescues this file, so a long name must keep it.
  const longTs = checkAttachments([file(`${"n".repeat(250)}.ts`, "video/mp2t", "let y = 2;")]);
  assert.ok(longTs.ok, "a long .ts name is still text");
  const svg = checkAttachments([file("logo.svg", "image/svg+xml", "<svg/>")]);
  assert.ok(svg.ok);
  assert.equal(svg.files[0].content_type, "text/plain", "an SVG is delivered as text");
  assert.deepEqual(checkAttachments(undefined), { ok: true, files: [] });
});

test("checkAttachments rejects the first bad file with a status that says why", () => {
  const status = (input: unknown) => {
    const r = checkAttachments(input);
    return r.ok ? 200 : r.status;
  };
  assert.equal(status("nope"), 400);
  assert.equal(status([file("deck.pptx", "application/vnd.ms-powerpoint")]), 415);
  assert.equal(status([{ filename: "a.png", content_type: "image/png", data: "not base64!" }]), 400);
  assert.equal(status([{ filename: "a.png", content_type: "image/png" }]), 400);
  assert.equal(status([file("empty.txt", "text/plain", "")]), 400);
  assert.equal(status([file("big.png", "image/png", Buffer.alloc(ATTACHMENT_LIMITS.image + 1))]), 413);
  assert.equal(status(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(`${i}.txt`, "text/plain"))), 400);
  // Each file is within its own cap; together they pass omnigent's ceiling.
  const pdf = Buffer.alloc(ATTACHMENT_LIMITS.pdf);
  assert.ok(2 * ATTACHMENT_LIMITS.pdf > MAX_ATTACHMENT_TOTAL_BYTES);
  assert.equal(status([file("a.pdf", "application/pdf", pdf), file("b.pdf", "application/pdf", pdf)]), 413);
});

function fakeBackend() {
  const started: WorkerStart[] = [];
  const backend: WorkerBackend = {
    name: "fake",
    async start(s: WorkerStart): Promise<WorkerSession> {
      started.push(s);
      return {
        address: "s1", task_id: s.taskId, name: s.name, harness: s.harness, status: "working",
        blocked_kind: null, state: "live", turn: 1, cwd: s.repoPath, created_ms: Date.now(), exit_code: null, parent: null,
      };
    },
    list: async () => [],
    get: async () => null,
    read: async () => "",
    send: async () => undefined,
    resolveElicitation: async () => undefined,
    kill: async () => undefined,
    history: async () => "",
    tree: async () => [],
    onEvent: () => ({ stop: () => undefined }),
  };
  return { backend, started };
}

async function withApi(fn: (ctx: { db: Db; repo: string; call: (method: string, path: string, body?: unknown) => Promise<Response>; started: WorkerStart[]; cfg: Config; backend: WorkerBackend }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "corral-attach-"));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", repo]);
  const db = new Db(join(dir, "test.db"));
  const cfg = { token: "t", host: "127.0.0.1", port: 4787, configDir: dir } as Config;
  const { backend, started } = fakeBackend();
  const server = createHttpServer({ db, cfg, backend, hub: { broadcast() {}, clients: new Set() } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await fn({ db, repo, call, started, cfg, backend });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a task created with attachments stores them and lists them in drop order", () =>
  withApi(async ({ db, repo, call }) => {
    const res = await call("POST", "/api/tasks", {
      prompt: "Fix the layout shown here",
      repo_path: repo,
      target: "codex",
      attachments: [file("shot.png", "image/png", "png-bytes"), file("log.txt", "text/plain", "boom")],
    });
    assert.equal(res.status, 200);
    const task = (await res.json()) as Task;

    const list = (await (await call("GET", `/api/tasks/${task.id}/attachments`)).json()) as { filename: string; bytes: number; content_type: string }[];
    assert.deepEqual(list.map((a) => [a.filename, a.content_type, a.bytes]), [["shot.png", "image/png", 9], ["log.txt", "text/plain", 4]]);
    assert.ok(!("data" in list[0]), "the listing is metadata only");

    const tasks = (await (await call("GET", "/api/tasks")).json()) as { id: string; attachment_count: number }[];
    assert.equal(tasks.find((t) => t.id === task.id)?.attachment_count, 2);

    const created = db.listTaskEvents(task.id).find((e) => e.kind === "created");
    assert.equal(JSON.parse(created?.data ?? "{}").attachments, 2);
  }));

test("a rejected attachment creates no task", () =>
  withApi(async ({ db, repo, call }) => {
    const res = await call("POST", "/api/tasks", {
      prompt: "x",
      repo_path: repo,
      attachments: [file("ok.png", "image/png"), file("deck.pptx", "application/vnd.ms-powerpoint")],
    });
    assert.equal(res.status, 415);
    assert.match(((await res.json()) as { error: string }).error, /deck\.pptx/);
    assert.equal(db.listTasks().length, 0);
  }));

test("a task without attachments reports none", () =>
  withApi(async ({ call, repo }) => {
    const task = (await (await call("POST", "/api/tasks", { prompt: "plain", repo_path: repo })).json()) as Task;
    assert.deepEqual(await (await call("GET", `/api/tasks/${task.id}/attachments`)).json(), []);
    const tasks = (await (await call("GET", "/api/tasks")).json()) as { id: string; attachment_count: number }[];
    assert.equal(tasks[0].attachment_count, 0);
    assert.equal((await call("GET", "/api/tasks/nope/attachments")).status, 404);
  }));

test("a body past the default cap is accepted only when it carries attachments", () =>
  withApi(async ({ call, repo }) => {
    // 3 MiB of raw image bytes is ~4 MiB of JSON: over the 2 MiB default cap.
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const res = await call("POST", "/api/tasks", { prompt: "x", repo_path: repo, attachments: [file("big.png", "image/png", big)] });
    assert.equal(res.status, 200);
    // Every other route keeps the 2 MiB cap, which drops the connection.
    await assert.rejects(call("PATCH", "/api/tasks/whatever", { prompt: "y".repeat(3 * 1024 * 1024) }));
  }));

test("dispatch hands the stored files to the worker and records them in the history", () =>
  withApi(async ({ db, repo, call, cfg, backend, started }) => {
    const task = (await (await call("POST", "/api/tasks", {
      prompt: "Match this mock",
      repo_path: repo,
      target: "codex",
      attachments: [file("mock.png", "image/png", "png-bytes")],
    })).json()) as Task;
    await dispatchTask(db, cfg, backend, db.getTask(task.id)!, "codex", { useWorktree: false });

    assert.equal(started.length, 1);
    const [sent] = started[0].attachments ?? [];
    assert.equal(sent.filename, "mock.png");
    assert.equal(sent.contentType, "image/png");
    assert.equal(Buffer.from(sent.data).toString(), "png-bytes");

    const prompt = db.listTaskEvents(task.id).find((e) => e.kind === "prompt");
    assert.equal(JSON.parse(prompt?.data ?? "{}").attachments, "mock.png (9 B)");
  }));

test("dispatch without attachments sends none", () =>
  withApi(async ({ db, repo, call, cfg, backend, started }) => {
    const task = (await (await call("POST", "/api/tasks", { prompt: "plain", repo_path: repo, target: "codex" })).json()) as Task;
    await dispatchTask(db, cfg, backend, db.getTask(task.id)!, "codex", { useWorktree: false });
    assert.equal(started[0].attachments, undefined);
  }));

// ---- omnigent delivery ----

/** Stands in for the omnigent HTTP API: only `fetch` is replaced, so the real
 *  request path (auth, multipart headers, error formatting) runs. */
function fakeOmnigent(uploadStatus = 201) {
  const calls: string[] = [];
  const uploads: { auth: string | null; contentType: string | null; name: string; type: string; text: string }[] = [];
  const state: { message: { data: { content: Record<string, unknown>[] } } | null } = { message: null };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push(`${method} ${url.pathname}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (method === "POST" && url.pathname === "/v1/sessions") return json({ id: "sess-1" }, 201);
    if (method === "GET" && url.pathname === "/v1/sessions/sess-1") return json({ id: "sess-1" });
    if (method === "POST" && url.pathname === "/v1/sessions/sess-1/resources/files") {
      if (uploadStatus !== 201) return new Response("Unsupported attachment type", { status: uploadStatus });
      const upload = (init?.body as FormData).get("file") as File;
      uploads.push({ auth: headers.get("authorization"), contentType: headers.get("content-type"), name: upload.name, type: upload.type, text: await upload.text() });
      return json({ id: `file-${uploads.length}`, name: upload.name, metadata: { filename: upload.name } }, 201);
    }
    if (method === "POST" && url.pathname === "/v1/sessions/sess-1/events") {
      state.message = JSON.parse(String(init?.body));
      return json({});
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
  const backend = new OmnigentBackend({ baseUrl: "http://omnigent.test", token: "secret", hostId: "", agents: {} });
  (backend as unknown as { ensureHarnessAgent: () => Promise<string> }).ensureHarnessAgent = async () => "agent-1";
  return { backend, calls, uploads, state, restore: () => { globalThis.fetch = realFetch; } };
}

const startOptions = { taskId: "t1", name: null, repoPath: "/tmp/repo", git: null, harness: "codex", model: null, reasoning: null } as const;

test("omnigent uploads each file to the session, then sends one message that references them", async () => {
  const omnigent = fakeOmnigent();
  try {
    await omnigent.backend.start({
      ...startOptions,
      prompt: "look at these",
      attachments: [
        { filename: "shot.png", contentType: "image/png", data: Buffer.from("png-bytes") },
        { filename: "report.pdf", contentType: "application/pdf", data: Buffer.from("pdf-bytes") },
      ],
    });
  } finally {
    omnigent.restore();
  }
  assert.deepEqual(omnigent.calls, [
    "POST /v1/sessions",
    "GET /v1/sessions/sess-1",
    "POST /v1/sessions/sess-1/resources/files",
    "POST /v1/sessions/sess-1/resources/files",
    "POST /v1/sessions/sess-1/events",
  ]);
  assert.deepEqual(omnigent.uploads.map((u) => [u.name, u.type, u.text, u.auth]), [
    ["shot.png", "image/png", "png-bytes", "Bearer secret"],
    ["report.pdf", "application/pdf", "pdf-bytes", "Bearer secret"],
  ]);
  // The multipart boundary is fetch's to set: a JSON content type would break the upload.
  assert.ok(omnigent.uploads.every((u) => u.contentType === null));
  assert.deepEqual(omnigent.state.message?.data.content, [
    { type: "input_image", file_id: "file-1", filename: "shot.png" },
    { type: "input_file", file_id: "file-2", filename: "report.pdf" },
    { type: "input_text", text: "look at these" },
  ]);
});

test("omnigent: an upload failure fails the dispatch and sends no prompt", async () => {
  const omnigent = fakeOmnigent(415);
  try {
    await assert.rejects(
      omnigent.backend.start({ ...startOptions, prompt: "p", attachments: [{ filename: "a.png", contentType: "image/png", data: Buffer.from("x") }] }),
      /prompt delivery failed.*a\.png.*415/,
    );
  } finally {
    omnigent.restore();
  }
  assert.ok(!omnigent.calls.includes("POST /v1/sessions/sess-1/events"), "no prompt reaches a session whose files failed");
});

test("omnigent: a start without attachments sends the prompt as plain text, as before", async () => {
  const omnigent = fakeOmnigent();
  try {
    await omnigent.backend.start({ ...startOptions, prompt: "just text" });
  } finally {
    omnigent.restore();
  }
  assert.deepEqual(omnigent.state.message?.data.content, [{ type: "input_text", text: "just text" }]);
  assert.ok(!omnigent.calls.some((c) => c.includes("resources/files")));
});
