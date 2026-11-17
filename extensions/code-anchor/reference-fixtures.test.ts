import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyWrites, portablePath, supplyFile, type StagedEdit } from "./host-files.ts";
import { WasmEngine } from "./wasm-runtime.ts";
import type { NativeEdit, NativeRead } from "./core-types.ts";

interface Fixture {
  name: string;
  files?: Record<string, string>;
  snapshots?: { path: string; text?: string; seenLines?: number[] }[];
  args: { input: string };
  expect: { files?: Record<string, string>; deleted?: string[]; writes: number; error?: string; textContains?: string[] };
}

const root = dirname(fileURLToPath(import.meta.url));

test("the final portable core passes the pinned 26 disk-backed hashline fixtures", async () => {
  const engine = await WasmEngine.load(join(root, "wasm", "code_anchor_core.wasm"));
  const fixtures = JSON.parse(await readFile(join(root, "rust", "tests", "fixtures", "hashline", "patcher.json"), "utf8")) as { cases: Fixture[] };
  assert.equal(fixtures.cases.length, 26);
  const failures: string[] = [];
  for (const fixture of fixtures.cases) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "code-anchor-reference-case-")));
    try {
      engine.session({ action: "reset" });
      for (const [path, content] of Object.entries(fixture.files ?? {})) {
        await mkdir(dirname(join(directory, path)), { recursive: true });
        await writeFile(join(directory, path), content);
      }
      let input = fixture.args.input;
      for (const snapshot of fixture.snapshots ?? []) {
        const path = join(directory, snapshot.path);
        const current = await readFile(path, "utf8");
        if (snapshot.text !== undefined) await writeFile(path, snapshot.text);
        const file = await supplyFile(snapshot.path, directory);
        let tag: string | undefined;
        for (const line of snapshot.seenLines ?? [1]) {
          const result = engine.session<NativeRead>({ action: "read", file, offset: line, limit: snapshot.seenLines ? 1 : 2000 });
          tag = result.tag;
        }
        assert(tag);
        await writeFile(path, current);
        input = input.replaceAll(`{{tag:${snapshot.path}}}`, tag);
      }
      let error: string | undefined;
      let writes = 0;
      let result: NativeEdit | undefined;
      try {
        const paths = engine.session<string[]>({ action: "inspect", input, cwd: portablePath(directory) });
        const files = await Promise.all(paths.map(path => supplyFile(path, directory)));
        const plan = engine.session<StagedEdit>({ action: "stage", input, cwd: portablePath(directory), home: portablePath(directory), files });
        writes = plan.files.filter(file => file.operation !== "noop").length;
        result = await applyWrites(engine, plan);
      } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      if (fixture.expect.error) {
        assert(error, `Expected error containing ${fixture.expect.error}`);
        assert(error.includes(fixture.expect.error), error);
      } else {
        assert.equal(error, undefined, error);
      }
      assert.equal(writes, fixture.expect.writes, "Host write count");
      for (const [path, content] of Object.entries(fixture.expect.files ?? {})) {
        assert.equal(await readFile(join(directory, path), "utf8"), content, path);
      }
      for (const path of fixture.expect.deleted ?? []) assert.equal(existsSync(join(directory, path)), false, path);
      for (const text of fixture.expect.textContains ?? []) assert(result?.text.includes(text), result?.text ?? "Missing result");
    } catch (error) {
      failures.push(`${fixture.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
  }
  assert.deepEqual(failures, []);
});
