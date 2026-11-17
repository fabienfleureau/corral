import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkAdrs } from "../../scripts/check-adr.ts";

const record = "# A decision\n\nWe chose a local store because deployment must stay small.\n";

function fixture(files: Record<string, string>, run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "corral-adr-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validFiles(): Record<string, string> {
  return {
    "README.md": "# Decisions\n\n- [0001](0001-local-store.md)\n",
    "template.md": "# Decision title\n\nExplain the decision.\n",
    "0001-local-store.md": record,
  };
}

test("ADR check accepts legacy paragraph records and ignores index and template", () => {
  fixture(validFiles(), (directory) => assert.deepEqual(checkAdrs(directory), []));
});

test("ADR check accepts CRLF records", () => {
  fixture({ ...validFiles(), "0001-local-store.md": record.replaceAll("\n", "\r\n") }, (directory) => {
    assert.deepEqual(checkAdrs(directory), []);
  });
});

test("ADR check ignores links hidden in index comments", () => {
  fixture({ ...validFiles(), "README.md": "# Decisions\n\n<!-- [hidden](0001-local-store.md) -->\n" }, (directory) => {
    assert.ok(checkAdrs(directory).some((error) => error.includes("not linked")));
  });
});

test("ADR check rejects malformed names and zero IDs", () => {
  for (const name of ["notes.md", "001-short.md", "0000-zero.md", "0002-UPPER.md", "0002-.md"]) {
    fixture({ ...validFiles(), [name]: record }, (directory) => {
      assert.ok(checkAdrs(directory).some((error) => error.includes(name) && error.includes("filename")));
    });
  }
});

test("ADR check rejects duplicate IDs with different slugs", () => {
  fixture({ ...validFiles(), "0001-other-store.md": record }, (directory) => {
    assert.ok(checkAdrs(directory).some((error) => error.includes("Duplicate ADR number 0001")));
  });
});

test("ADR check requires an actual index link for every record", () => {
  fixture({ ...validFiles(), "README.md": "# Decisions\n\n0001-local-store.md\n" }, (directory) => {
    assert.ok(checkAdrs(directory).some((error) => error.includes("not linked")));
  });
});

test("ADR check rejects stale index links", () => {
  fixture({ ...validFiles(), "README.md": "# Decisions\n\n[old](0002-missing.md)\n" }, (directory) => {
    assert.ok(checkAdrs(directory).some((error) => error.includes("0002-missing.md") && error.includes("missing")));
  });
});

test("ADR check rejects records without a title or substantive body", () => {
  for (const content of ["", "A body without a heading", "# Title\n", "# Title\n\n<!-- TODO: decide -->\n", "# Title\n\n## Context\n"]) {
    fixture({ ...validFiles(), "0001-local-store.md": content }, (directory) => {
      assert.ok(checkAdrs(directory).some((error) => error.includes("title and decision text")));
    });
  }
});

test("ADR check reports a missing index and an empty registry", () => {
  fixture({ "0001-local-store.md": record }, (directory) => {
    assert.ok(checkAdrs(directory).some((error) => error.includes("README.md")));
  });
  fixture({ "README.md": "# Decisions\n", "template.md": record }, (directory) => {
    assert.ok(checkAdrs(directory).some((error) => error.includes("No ADR records")));
  });
});

test("ADR CLI returns failure diagnostics and success without importing side effects", () => {
  const script = resolve("scripts/check-adr.ts");
  fixture(validFiles(), (directory) => {
    const result = spawnSync(process.execPath, [script, directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ADR check passed/);
    writeFileSync(join(directory, "0001-local-store.md"), "# Empty\n");
    const invalid = spawnSync(process.execPath, [script, directory], { encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /0001-local-store.md/);
  });
  const missing = spawnSync(process.execPath, [script, join(tmpdir(), "nonexistent-corral-adr-directory")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot read ADR directory/);
});
