import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readJson, readPackageInfo, resolveInstalledEntry } from "./verification-data.ts";

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

test("installed entry resolution supports hoisted and nested import-only packages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-package-entry-"));
  try {
    const host = join(directory, "node_modules/fixture-host");
    const packageName = "@fixture/import-only";
    await mkdir(host, { recursive: true });
    await writeFile(join(host, "package.json"), JSON.stringify({ name: "fixture-host" }));
    for (const location of [directory, host]) {
      const dependency = join(location, "node_modules", packageName);
      await mkdir(join(dependency, "dist"), { recursive: true });
      await writeFile(join(dependency, "package.json"), JSON.stringify({
        name: packageName,
        type: "module",
        main: "./dist/index.js",
        exports: { ".": { import: "./dist/index.js" } },
      }));
      await writeFile(join(dependency, "dist/index.js"), "");
      assert.equal(resolveInstalledEntry(packageName, host), join(dependency, "dist/index.js"));
    }
    assert.throws(() => resolveInstalledEntry("@fixture/missing", host), /Cannot locate installed package/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    assert.equal(existsSync(directory), false);
  }
});
