import assert from "node:assert/strict";
import { test } from "node:test";
import { applySection, digest, header, parsePatch, type Snapshot } from "./hashline.ts";

function edit(source: string | Buffer, body: string, ranges: Snapshot["ranges"] = [[1, 100_000]]) {
  const bytes = typeof source === "string" ? Buffer.from(source) : source;
  const snapshot: Snapshot = { path: "/fixture.txt", digest: digest(bytes), ranges };
  const section = parsePatch(`${header(snapshot.path, snapshot.digest)}\n${body}`)[0];
  assert(section);
  return applySection(bytes, section, snapshot);
}

const cases: [string, string, string, string][] = [
  ["single line", "before\nkeep\n", "PUT 1:\n+after", "after\nkeep\n"],
  ["mixed LF first", "head\nbefore\r\nkeep\r\ntail\n", "PUT 2:\n+after", "head\nafter\r\nkeep\r\ntail\n"],
  ["mixed CRLF first", "head\r\nbefore\nkeep\ntail\r\n", "PUT 2:\n+after", "head\r\nafter\nkeep\ntail\r\n"],
  ["unterminated final line", "keep\nbefore", "PUT 2:\n+after", "keep\nafter"],
  ["BOM", "\uFEFFbefore\r\nkeep\n", "PUT 1:\n+after", "\uFEFFafter\r\nkeep\n"],
  ["literal duplicate", "A\nB\nC\nD\n", "PUT 2.=3:\n+A\n+B2\n+C2", "A\nA\nB2\nC2\nD\n"],
  ["literal indentation", "function f() {\n  first();\n  second();\n}\n", "PUT 2.=3:\n+first();\n+second();", "function f() {\nfirst();\nsecond();\n}\n"],
  ["original line coordinates", "one\ntwo\nthree\nfour\n", "PUT 1:\n+ONE\n+extra\nPUT 4:\n+FOUR", "ONE\nextra\ntwo\nthree\nFOUR\n"],
  ["insert before", "one\ntwo\n", "PUT <2:\n+new", "one\nnew\ntwo\n"],
  ["insert after", "one\ntwo\n", "PUT >1:\n+new", "one\nnew\ntwo\n"],
  ["append terminated", "one\n", "PUT >$:\n+new", "one\nnew\n"],
  ["append unterminated", "one", "PUT >$:\n+new", "one\nnew"],
  ["prepend", "one\n", "PUT <1:\n+new", "new\none\n"],
  ["blank insertion", "one\ntwo\n", "PUT >1:\n+", "one\n\ntwo\n"],
  ["cut range", "one\ntwo\nthree\n", "CUT 2", "one\nthree\n"],
  ["cut all", "one\ntwo\n", "CUT 1.=2", ""],
  ["remove final LF", "one\n", "CUT 2", "one"],
  ["remove final CRLF", "one\r\n", "CUT 2", "one"],
  ["empty file insertion", "", "PUT 1:\n+new", "new"],
  ["literal protocol-like rows", "before\n", "PUT 1:\n++plus\n+PUT 9:\n+[path#ABCDEF123456]\n+# comment", "+plus\nPUT 9:\n[path#ABCDEF123456]\n# comment\n"],
  ["Unicode and whitespace", "  α😀before  \nkeep \t\n", "PUT 1:\n+  α😀after  ", "  α😀after  \nkeep \t\n"],
  ["insertion and replacement at one boundary", "A\nB\nC\n", "PUT <2:\n+A\nPUT 2.=3:\n+B2\n+C2", "A\nA\nB2\nC2\n"],
];
for (const [name, source, body, expected] of cases) {
  test(`literal byte edits: ${name}`, () => assert.equal(edit(source, body).toString("utf8"), expected));
}

test("untouched invalid UTF-8 bytes remain exact", () => {
  const source = Buffer.concat([Buffer.from("before\n"), Buffer.from([0xff, 0x80, 10])]);
  assert.deepEqual(edit(source, "PUT 1:\n+after"), Buffer.concat([Buffer.from("after\n"), source.subarray(7)]));
});
test("quoted headers support every literal path character", () => {
  for (const path of ["odd]name.txt", "two\nlines.txt", "literal;name,#tag[1].txt", 'quote"name', " trailing "]) {
    assert.equal(parsePatch(`${header(path, digest(Buffer.from("text")))}\nCUT 1`)[0]?.path, path);
  }
});
test("changed bytes, including whitespace and newline styles, reject snapshots", () => {
  const bytes = Buffer.from("one\n");
  const snapshot: Snapshot = { path: "file", digest: digest(bytes), ranges: [[1, 2]] };
  const section = parsePatch(`${header("file", snapshot.digest)}\nPUT 1:\n+after`)[0];
  assert(section);
  for (const changed of ["one \n", "one\r\n", "ONE\n"]) assert.throws(() => applySection(Buffer.from(changed), section, snapshot), /changed since/u);
});
test("unseen rows and overlapping operations reject before producing content", () => {
  assert.throws(() => edit("one\ntwo\n", "PUT 2:\n+after", [[1, 1]]), /read lines 2-2/u);
  assert.throws(() => edit("one\ntwo\n", "PUT 1.=2:\n+after\nPUT 2:\n+other"), /overlap/u);
  assert.throws(() => edit("one\ntwo\n", "PUT 1.=2:\n+after\nPUT >1:\n+other"), /overlap/u);
});
test("identical edits are errors, not successful no-ops", () => assert.throws(() => edit("one\n", "PUT 1:\n+one"), /identical content/u));
test("unsupported syntax and malformed payloads fail explicitly", () => {
  for (const body of ["PUT 1*:\n+new", "MV other.txt", "REM", "CUT 1 @held", "PUT 1", "PUT 2.=1:\n+new", "PUT 1:\n-old", "PUT 1:", "PUT <1.=2:\n+new", "CUT 1:"]) {
    assert.throws(() => parsePatch(`${header("file", "a".repeat(64))}\n${body}`));
  }
});
test("multiple files use separate independent sections", () => {
  assert.equal(parsePatch(`${header("one", "a".repeat(64))}\nCUT 1\n${header("two", "b".repeat(64))}\nPUT 1:\n+new`).length, 2);
});
