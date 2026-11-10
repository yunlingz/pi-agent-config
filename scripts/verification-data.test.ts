import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isRecord, readJson, readPackageInfo } from "./verification-data.ts";

async function withFile(text: string, check: (path: string) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-verification-data-"));
  try {
    const path = join(directory, "fixture.json");
    await writeFile(path, text);
    check(path);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

test("JSON values stay unknown until their shape is checked", async () => {
  await withFile('{"enabled":true}', (path) => {
    const value = readJson(path);
    assert.ok(isRecord(value));
    assert.equal(value.enabled, true);
  });
});

test("JSON parser errors do not expose private content", async () => {
  await withFile('{"private-marker":', (path) => {
    assert.throws(() => readJson(path), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Cannot read valid JSON/u);
      assert.doesNotMatch(error.message, /private-marker/u);
      return true;
    });
  });
});

test("trusted package metadata keeps its producer's fields", async () => {
  await withFile('{"name":"fixture","version":"1.0.0","extra":42}', (path) => {
    assert.deepEqual(readPackageInfo(path), { name: "fixture", version: "1.0.0", extra: 42 });
  });
});

test("record narrowing rejects null and arrays", () => {
  assert.equal(isRecord({}), true);
  for (const value of [null, [], "text", 1, undefined]) assert.equal(isRecord(value), false);
});
