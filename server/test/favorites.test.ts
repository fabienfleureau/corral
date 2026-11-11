import { test } from "node:test";
import { deepStrictEqual, throws } from "node:assert";
import { parseFavorites } from "../favorites.ts";

test("favorites retain all dispatch choices and reject malformed input", () => {
  const favorites = [{ name: "Review", harness: "codex", agent: "reviewer", model: "m", reasoning: "high", context: "personal" }];
  deepStrictEqual(parseFavorites(favorites), favorites);
  deepStrictEqual(parseFavorites([]), []);
  throws(() => parseFavorites([{ ...favorites[0], harness: "" }]));
  throws(() => parseFavorites([{ ...favorites[0], agent: 42 }]));
});

test("favorites without a context are professional and unknown contexts are rejected", () => {
  const legacy = { name: "Review", harness: "codex", agent: "", model: "", reasoning: "" };
  deepStrictEqual(parseFavorites([legacy]), [{ ...legacy, context: "professional" }]);
  throws(() => parseFavorites([{ ...legacy, context: "work" }]));
  throws(() => parseFavorites([{ ...legacy, context: null }]));
});
