// Epics page board grouping: killed Jira tickets stay terminal in the graph
// but are omitted from the board columns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import type { EpicTaskView } from "../../web/src/types.ts";

const bundle = await build({
  stdin: { contents: `export { epicBoardGroups } from "./web/src/pages/Epics.tsx";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
});
const mod = { exports: {} as { epicBoardGroups: (views: EpicTaskView[]) => { state: string; label: string; views: EpicTaskView[] }[] } };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { epicBoardGroups } = mod.exports;

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
