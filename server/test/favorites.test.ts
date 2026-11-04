import { test } from "node:test";
import { deepStrictEqual, throws } from "node:assert";
import { parseFavorites } from "../favorites.ts";

test("favorites retain all dispatch choices and reject malformed input", () => {
  const favorites = [{ name: "Review", harness: "codex", agent: "reviewer", model: "m", reasoning: "high" }];
  deepStrictEqual(parseFavorites(favorites), favorites);
  deepStrictEqual(parseFavorites([]), []);
  throws(() => parseFavorites([{ ...favorites[0], harness: "" }]));
  throws(() => parseFavorites([{ ...favorites[0], agent: 42 }]));
});
