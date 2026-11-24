// Epics page board grouping: killed Jira tickets stay terminal in the graph
// but are omitted from the board columns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import type { EpicTaskView, Favorite, Repo } from "../../web/src/types.ts";

const bundle = await build({
  stdin: { contents: `export { epicBoardGroups, epicTaskConf, favoriteConfSummary, nextSelectedEpicAfterRemove, reconcileSelectedEpic } from "./web/src/pages/Epics.tsx";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
});
const mod = {
  exports: {} as {
    epicBoardGroups: (views: EpicTaskView[]) => { state: string; label: string; views: EpicTaskView[] }[];
    favoriteConfSummary: (f: Pick<Favorite, "harness" | "agent" | "model" | "reasoning" | "review">) => string;
    epicTaskConf: (
      task: Pick<EpicTaskView["task"], "repo_path" | "target" | "agent" | "model" | "reasoning" | "review">,
      epicFavorite: Favorite | null,
      repos: Pick<Repo, "path" | "context">[],
    ) => { target: string; agent: string | null; model: string | null; reasoning: string | null; review: string | null; inherited: boolean; favoriteName?: string } | null;
    reconcileSelectedEpic: (currentId: string | null, rows: readonly { id: string }[]) => string | null;
    nextSelectedEpicAfterRemove: (rows: readonly { id: string }[], removedId: string) => string | null;
  },
};
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { epicBoardGroups, epicTaskConf, favoriteConfSummary, nextSelectedEpicAfterRemove, reconcileSelectedEpic } = mod.exports;

const view = (id: string, state: EpicTaskView["state"]): EpicTaskView => ({
  task: { id, title: id, jira_key: id } as EpicTaskView["task"],
  state,
  blockers: [],
  alert: null,
  testable: state === "merged" || state === "pr_ready",
  stack_on: null,
});

test("epicBoardGroups omits killed Jira tickets while keeping active and out groups in order", () => {
  const groups = epicBoardGroups([
    view("E-1", "merged"),
    view("E-2", "killed"),
    view("E-3", "ready"),
    view("E-4", "blocked"),
    view("E-5", "out"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.state, g.views.map((v) => v.task.id)]),
    [
      ["blocked", ["E-4"]],
      ["ready", ["E-3"]],
      ["merged", ["E-1"]],
      ["out", ["E-5"]],
    ],
  );
  assert.ok(groups.every((g) => g.state !== "killed"));
});

test("favoriteConfSummary and epicTaskConf resolve explicit conf, inherited epic favorite, and context mismatches", () => {
  const workFav: Favorite = { name: "Careful", harness: "claude", agent: "builder", model: "opus", reasoning: "high", context: "professional", review: "cubic" };
  const bareFav: Favorite = { name: "Auto", harness: "codex", agent: "", model: "", reasoning: "", context: "professional", review: "" };
  const repos: Pick<Repo, "path" | "context">[] = [
    { path: "/work/app", context: null },
    { path: "/home/side", context: "personal" },
  ];

  assert.equal(favoriteConfSummary(workFav), "claude · builder · opus · high · review: cubic");
  assert.equal(favoriteConfSummary(bareFav), "codex · smart-route");

  assert.deepEqual(
    epicTaskConf({ repo_path: "/work/app", target: "", agent: null, model: null, reasoning: null, review: null }, workFav, repos),
    { target: "claude", agent: "builder", model: "opus", reasoning: "high", review: "cubic", inherited: true, favoriteName: "Careful" },
  );
  assert.deepEqual(
    epicTaskConf({ repo_path: "/work/app", target: "codex", agent: null, model: "gpt-6", reasoning: null, review: null }, workFav, repos),
    { target: "codex", agent: null, model: "gpt-6", reasoning: null, review: null, inherited: false },
  );
  assert.equal(
    epicTaskConf({ repo_path: "/home/side", target: "", agent: null, model: null, reasoning: null, review: null }, workFav, repos),
    null,
  );
  assert.equal(
    epicTaskConf({ repo_path: "/work/app", target: "", agent: null, model: null, reasoning: null, review: null }, null, repos),
    null,
  );
});

test("reconcileSelectedEpic keeps a valid selection and falls back when the selected epic disappears", () => {
  const rows = [{ id: "e1" }, { id: "e2" }];
  assert.equal(reconcileSelectedEpic(null, rows), "e1");
  assert.equal(reconcileSelectedEpic("e2", rows), "e2");
  assert.equal(reconcileSelectedEpic("deleted", rows), "e1");
  assert.equal(reconcileSelectedEpic("deleted", []), null);
});

test("nextSelectedEpicAfterRemove picks the neighbor after removal or null when none remain", () => {
  const rows = [{ id: "e1" }, { id: "e2" }, { id: "e3" }];
  assert.equal(nextSelectedEpicAfterRemove(rows, "e1"), "e2");
  assert.equal(nextSelectedEpicAfterRemove(rows, "e2"), "e3");
  assert.equal(nextSelectedEpicAfterRemove(rows, "e3"), "e2");
  assert.equal(nextSelectedEpicAfterRemove([{ id: "e1" }], "e1"), null);
  assert.equal(nextSelectedEpicAfterRemove(rows, "missing"), "e1");
});
