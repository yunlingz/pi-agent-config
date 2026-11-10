import assert from "node:assert/strict";
import test from "node:test";
import { buildRecallArguments } from "./request.ts";

test("search preserves text and parses trailing modifiers", () => {
  assert.deepEqual(
    buildRecallArguments("search", "SF Mono Terminal page:2 scope:all"),
    { query: "SF Mono Terminal", page: 2, scope: "all" },
  );
});

test("range accepts common forms and normalizes direction", () => {
  assert.deepEqual(buildRecallArguments("range", "#9..#4 page:3"), { range: [4, 9], page: 3 });
  assert.deepEqual(buildRecallArguments("range", "[7, 11]"), { range: [7, 11] });
  assert.deepEqual(buildRecallArguments("range", "5"), { range: [5, 5] });
});

test("expand parses and deduplicates indices", () => {
  assert.deepEqual(
    buildRecallArguments("expand", "[#3, 5, #3] scope:all"),
    { expand: [3, 5], scope: "all" },
  );
});

test("touched accepts only universal modifiers", () => {
  assert.deepEqual(buildRecallArguments("touched", ""), { mode: "touched" });
  assert.deepEqual(
    buildRecallArguments("touched", "page:2 scope:lineage"),
    { mode: "touched", page: 2, scope: "lineage" },
  );
});

test("file validates drill-down syntax", () => {
  assert.deepEqual(
    buildRecallArguments("file", "#12:src/auth.ts:full scope:all"),
    { query: "#12:src/auth.ts:full", scope: "all" },
  );
  assert.deepEqual(buildRecallArguments("file", "#12"), { query: "#12" });
});

test("invalid actions and payloads fail clearly", () => {
  for (const [action, input, pattern] of [
    ["unknown", "text", /Unsupported action/],
    ["search", "", /cannot be empty/],
    ["range", "[1-2", /brackets must be paired/],
    ["range", "one-two", /from-to pair/],
    ["expand", "one,two", /entry indices/],
    ["touched", "unexpected", /only page or scope/],
    ["file", "12:path", /#N or #N:path/],
  ] as const) {
    assert.throws(() => buildRecallArguments(action, input), pattern);
  }
});

test("invalid or duplicate modifiers fail", () => {
  for (const [action, input, pattern] of [
    ["search", "text page:0", /at least 1/],
    ["search", "text page:1 page:2", /page only once/],
    ["search", "text scope:all scope:lineage", /scope only once/],
    ["expand", "1 page:2", /does not support page/],
    ["file", "#1 page:2", /does not support page/],
  ] as const) {
    assert.throws(() => buildRecallArguments(action, input), pattern);
  }
});
