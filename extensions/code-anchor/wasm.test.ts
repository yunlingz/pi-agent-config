import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WasmEngine } from "./wasm-runtime.ts";
import { NativeClient, addonPath } from "./core-client.ts";
import { applyWrites, portablePath, resolveHostPath, supplyFile, type StagedEdit } from "./host-files.ts";
import type { NativeEdit, NativePlan, NativeRead, NativeSearch } from "./core-types.ts";

const root = dirname(fileURLToPath(import.meta.url));
const artifact = join(root, "wasm", "code_anchor_core.wasm");

test("the final core imports only explicit services and parses the 22 selected grammars", async () => {
  const module = await WebAssembly.compile(await readFile(artifact));
  const imports = WebAssembly.Module.imports(module);
  assert(imports.length > 0);
  for (const entry of imports) {
    assert.equal(entry.module, "code_anchor");
    assert(["monotonic_ms", "stream_write", "stream_close", "stream_dup"].includes(entry.name));
  }
  const engine = await WasmEngine.load(artifact);
  const fixtures = JSON.parse(await readFile(join(root, "tests", "languages.json"), "utf8")) as Record<string, string>;
  const languages = engine.compute<{ languages: string[] }>({ action: "languages" }).languages;
  assert.deepEqual(languages, ["bash", "c", "cmake", "cpp", "csharp", "css", "dockerfile", "go", "html", "java", "javascript", "json", "lua", "make", "powershell", "python", "rust", "toml", "tsx", "typescript", "yaml", "zig"]);
  assert.deepEqual(languages, Object.keys(fixtures));
  for (const [language, source] of Object.entries(fixtures)) {
    const parsed = engine.compute<{ has_error: boolean }>({ action: "parse", language, source });
    assert.equal(parsed.has_error, false, language);
  }
  const rewrite = engine.compute<{ content: string }>({ action: "rewrite", language: "javascript", source: "console.log(value);", operations: [{ pattern: "console.log($VALUE)", replacement: "logger.info($VALUE)" }] });
  assert.equal(rewrite.content, "logger.info(value);");
  const json = engine.compute<{ matches: { text: string; captures: Record<string, string> }[] }>({ action: "find", language: "json", source: '[{"value":1}]', pattern: '{"value": $VALUE}' });
  assert.equal(json.matches[0]?.text, '{"value":1}');
  assert.equal(json.matches[0]?.captures.VALUE, "1");
});

test("all 22 grammars support captures, structural rewrites, and actual host writes", async () => {
  interface Fixture { path: string; source: string; pattern: string; replacement: string; expected: string }
  const fixtures = JSON.parse(await readFile(join(root, "tests", "language-operations.json"), "utf8")) as Record<string, Fixture>;
  const engine = await WasmEngine.load(artifact);
  assert.deepEqual(Object.keys(fixtures), engine.compute<{ languages: string[] }>({ action: "languages" }).languages);
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-languages-"));
  const client = new NativeClient(await addonPath());
  try {
    for (const [language, fixture] of Object.entries(fixtures)) {
      const found = engine.compute<{ matches: { captures: Record<string, string> }[]; warnings: string[] }>({ action: "find", language, source: fixture.source, pattern: fixture.pattern });
      assert.equal(found.matches.length, 1, `${language}: ${JSON.stringify(found)}`);
      assert(found.matches[0]?.captures.VALUE, `${language}: missing capture`);
      assert.deepEqual(found.warnings, [], language);
      const rewritten = engine.compute<{ content: string; changes: number; warnings: string[] }>({ action: "rewrite", language, source: fixture.source, operations: [{ pattern: fixture.pattern, replacement: fixture.replacement }] });
      assert.equal(rewritten.content, fixture.expected, language);
      assert.equal(rewritten.changes, 1, language);
      assert.deepEqual(rewritten.warnings, [], language);
      assert.equal(engine.compute<{ has_error: boolean }>({ action: "parse", language, source: rewritten.content }).has_error, false, language);
      const path = join(directory, fixture.path);
      await writeFile(path, fixture.source);
      const plan = JSON.parse(await client.request({ action: "preview", paths: [fixture.path], cwd: directory, operations: [{ pattern: fixture.pattern, replacement: fixture.replacement }] })) as NativePlan;
      assert.equal(plan.totalReplacements, 1, `${language}: ${JSON.stringify(plan)}`);
      assert.equal(await readFile(path, "utf8"), fixture.source, language);
      await client.request({ action: "pending_paths" });
      await client.request({ action: "resolve", apply: true });
      assert.equal(await readFile(path, "utf8"), fixture.expected, language);
    }
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("omitted languages retain hashline text operations without implicit parser substitution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-no-parser-"));
  const client = new NativeClient(await addonPath());
  const engine = await WasmEngine.load(artifact);
  try {
    for (const language of ["scss", "json5", "jsonc", "ruby", "swift", "markdown"]) {
      assert.throws(() => engine.compute({ action: "parse", language, source: "value" }), /Unsupported language/u);
    }
    for (const name of ["style.scss", "data.json5", "settings.jsonc", "code.rb", "code.swift", "notes.md"]) {
      const path = join(directory, name);
      await writeFile(path, "first\nsecond\n");
      const read = JSON.parse(await client.request({ action: "read", path, display: name })) as NativeRead;
      await client.request({ action: "apply", input: `[${name}#${read.tag}]\nPUT 2:\n+changed`, cwd: directory, home: directory });
      assert.equal(await readFile(path, "utf8"), "first\nchanged\n");
      const search = JSON.parse(await client.request({ action: "search", paths: [name], cwd: directory, pattern: "$VALUE", skip: 0 })) as NativeSearch;
      assert.equal(search.totalMatches, 0);
      assert(search.warnings.some(warning => /Unable to infer language/u.test(warning)), name);
    }
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("the host owns filesystem writes while WASM enforces anchors and issues new tags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-files-"));
  const client = new NativeClient(await addonPath());
  try {
    const path = join(directory, "file.ts");
    await writeFile(path, "console.log(value);\r\n");
    const read = JSON.parse(await client.request({ action: "read", path, display: "file.ts" })) as NativeRead;
    await assert.rejects(client.request({ action: "apply", input: "[file.ts#0000]\nPUT 1:\n+broken", cwd: directory, home: directory }), /tag|snapshot|mismatch/iu);
    assert.equal(await readFile(path, "utf8"), "console.log(value);\r\n");
    const applied = JSON.parse(await client.request({ action: "apply", input: `[file.ts#${read.tag}]\nPUT 1:\n+console.log(answer);`, cwd: directory, home: directory })) as NativeEdit;
    assert.match(applied.text, /console\.log\(answer\)/u);
    assert.equal(await readFile(path, "utf8"), "console.log(answer);\r\n");
    const plan = JSON.parse(await client.request({ action: "preview", paths: ["*.ts"], cwd: directory, operations: [{ pattern: "console.log($VALUE)", replacement: "logger.info($VALUE)" }] })) as NativePlan;
    assert.equal(plan.totalReplacements, 1);
    assert.equal(await readFile(path, "utf8"), "console.log(answer);\r\n");
    await client.request({ action: "pending_paths" });
    const resolved = await client.request({ action: "resolve", apply: true });
    const tag = /\[file\.ts#([0-9A-F]{4})\]/u.exec(resolved)?.[1];
    assert(tag, resolved);
    await client.request({ action: "apply", input: `[file.ts#${tag}]\nPUT 1:\n+logger.warn(answer);`, cwd: directory, home: directory });
    assert.equal(await readFile(path, "utf8"), "logger.warn(answer);\r\n");
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("all hashline sections validate before the host writes any file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-atomic-"));
  const client = new NativeClient(await addonPath());
  try {
    const first = join(directory, "first.txt");
    const second = join(directory, "second.txt");
    await writeFile(first, "first\n");
    await writeFile(second, "second\n");
    const read = JSON.parse(await client.request({ action: "read", path: first, display: "first.txt" })) as NativeRead;
    await assert.rejects(client.request({ action: "apply", input: `[first.txt#${read.tag}]\nPUT 1:\n+changed\n[second.txt#0000]\nPUT 1:\n+changed`, cwd: directory, home: directory }));
    assert.equal(await readFile(first, "utf8"), "first\n");
    assert.equal(await readFile(second, "utf8"), "second\n");
    await assert.rejects(client.request({ action: "apply", input: "[first.txt]", cwd: directory, home: directory }), /tag|header|snapshot/iu);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("host discovery keeps globs and ignore rules, and the core rejects generated writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-search-"));
  const client = new NativeClient(await addonPath());
  try {
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "visible.ts"), "console.log(value);\n");
    await writeFile(join(directory, "ignored.ts"), "console.log(ignored);\n");
    await writeFile(join(directory, ".gitignore"), "ignored.ts\n");
    await writeFile(join(directory, "nested", "generated.ts"), "// @generated\nconsole.log(generated);\n");
    const found = JSON.parse(await client.request({ action: "search", paths: ["**/*.ts"], cwd: directory, pattern: "console.log($VALUE)", skip: 0 })) as NativeSearch;
    assert.equal(found.totalMatches, 2);
    assert(!found.text.includes("console.log(ignored)"));
    const plan = JSON.parse(await client.request({ action: "preview", paths: ["**/*.ts"], cwd: directory, operations: [{ pattern: "console.log($VALUE)", replacement: "logger.info($VALUE)" }] })) as NativePlan;
    assert.equal(plan.files.length, 1);
    assert(plan.warnings.some(warning => /generat/iu.test(warning)));
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("directory scopes inherit ignore rules and do not resurrect files inside ignored parents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-ignore-scope-"));
  const client = new NativeClient(await addonPath());
  try {
    await mkdir(join(directory, "blocked"));
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, ".gitignore"), "blocked/\n!blocked/keep.ts\nnested/skipped.ts\n");
    await writeFile(join(directory, ".ignore"), "nested/priority.ts\n");
    await writeFile(join(directory, "nested", ".gitignore"), "!priority.ts\n");
    for (const name of ["blocked/keep.ts", "nested/visible.ts", "nested/skipped.ts", "nested/priority.ts", "literal[1].ts"]) {
      await writeFile(join(directory, name), "console.log(value);\n");
    }
    const request = async (paths: string[]): Promise<NativeSearch> => JSON.parse(await client.request({ action: "search", paths, cwd: directory, pattern: "console.log($VALUE)", skip: 0 })) as NativeSearch;
    assert.equal((await request(["nested"])).totalMatches, 1);
    const all = await request(["**/*.ts"]);
    assert.equal(all.totalMatches, 2);
    assert(!all.matches.some(match => /blocked|skipped|priority/u.test(match.path)));
    assert.equal((await request(["literal[1].ts"])).totalMatches, 1);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("discovery prunes ignored and impossible glob directories before reading their contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-pruning-"));
  const client = new NativeClient(await addonPath());
  try {
    await mkdir(join(directory, "generated", ".ignore"), { recursive: true });
    await mkdir(join(directory, "docs", ".ignore"), { recursive: true });
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, ".gitignore"), "generated/\n");
    await writeFile(join(directory, "src", "visible.ts"), "console.log(value);\n");
    // Entering either excluded subtree would fail because its .ignore is not a regular file.
    const result = JSON.parse(await client.request({ action: "search", paths: ["{src,generated}/**/*.ts"], cwd: directory, pattern: "console.log($VALUE)", skip: 0 })) as NativeSearch;
    assert.equal(result.totalMatches, 1);
    assert.deepEqual(result.warnings, []);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("AST rewrites retain valid rules and reject divergent overlapping replacements", async () => {
  const engine = await WasmEngine.load(artifact);
  const result = engine.compute<{ content: string; warnings: string[] }>({
    action: "rewrite", language: "javascript", source: "console.log(value);",
    operations: [
      { pattern: "first(); second();", replacement: "ignored();" },
      { pattern: "console.log($VALUE)", replacement: "logger.info($VALUE)" },
    ],
  });
  assert.equal(result.content, "logger.info(value);");
  assert(result.warnings.length > 0);
  assert.throws(() => engine.compute({
    action: "rewrite", language: "javascript", source: "console.log(value);",
    operations: [
      { pattern: "console.log($VALUE)", replacement: "logger.info($VALUE)" },
      { pattern: "console.$METHOD($VALUE)", replacement: "logger.warn($VALUE)" },
    ],
  }), /Overlapping replacements/u);
});

test("AST staging retains identity matches, caps files, and detects equal-total file changes", async () => {
  const engine = await WasmEngine.load(artifact);
  const file = (name: string, content: string) => ({ authored: name, path: "/workspace/" + name, content, exists: true });
  const operations = [{ pattern: "console.log($VALUE)", replacement: "logger.info($VALUE)" }];
  const identity = engine.session<NativePlan>({ action: "preview", files: [file("identity.ts", "console.log(value);\n")], operations: [{ pattern: "console.log($VALUE)", replacement: "console.log($VALUE)" }] });
  assert.equal(identity.totalReplacements, 1);
  assert.equal(identity.files.length, 1);
  const limited = engine.session<NativePlan>({ action: "preview", files: Array.from({ length: 1001 }, (_, index) => file(`file-${index}.ts`, "console.log(value);\n")), operations });
  assert.equal(limited.files.length, 1000);
  assert.equal(limited.limitReached, true);
  engine.session({ action: "preview", files: [file("first.ts", "console.log(one);console.log(two);"), file("second.ts", "logger.info(old);")], operations });
  assert.throws(() => engine.session({ action: "resolve", files: [file("first.ts", "logger.info(one);logger.info(two);"), file("second.ts", "console.log(one);console.log(two);")] }), /Preview is stale; no files were modified/u);
  engine.session({ action: "preview", files: [file("first.ts", "console.log(one);")], operations });
  assert.throws(() => engine.session({ action: "resolve", files: [file("first.ts", "console.log(changed);")] }), /Preview is stale; no files were modified/u);
});

test("stale AST previews reject equal-count content changes before any host write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-stale-preview-"));
  const client = new NativeClient(await addonPath());
  try {
    const path = join(directory, "file.ts");
    const source = "console.log(before);\n";
    await writeFile(path, source);
    await client.request({ action: "preview", paths: ["file.ts"], cwd: directory, operations: [{ pattern: "console.log($VALUE)", replacement: "logger.info($VALUE)" }] });
    const changed = "console.log(outsideChange);\n";
    await writeFile(path, changed);
    await client.request({ action: "pending_paths" });
    await assert.rejects(client.request({ action: "resolve", apply: true }), /Preview is stale; no files were modified/u);
    assert.equal(await readFile(path, "utf8"), changed);
    await assert.rejects(client.request({ action: "resolve", apply: true }), /No AST edit preview/u);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("clipboard moves and tag recovery share canonical snapshot identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-identity-"));
  const client = new NativeClient(await addonPath());
  try {
    const path = join(directory, "source.txt");
    await writeFile(path, "first\nsecond\nthird\n");
    const read = JSON.parse(await client.request({ action: "read", path, display: "source.txt" })) as NativeRead;
    await client.request({ action: "apply", input: `[source.txt#${read.tag}]\nCUT 2 @held\nPUT >$ @held`, cwd: directory, home: directory });
    assert.equal(await readFile(path, "utf8"), "first\nthird\nsecond\n");
    await mkdir(join(directory, "nested"));
    const nested = join(directory, "nested", "other.txt");
    await writeFile(nested, "before\n");
    const observed = JSON.parse(await client.request({ action: "read", path: nested, display: "nested/other.txt" })) as NativeRead;
    await client.request({ action: "apply", input: `[other.txt#${observed.tag}]\nPUT 1:\n+after`, cwd: directory, home: directory });
    assert.equal(await readFile(nested, "utf8"), "after\n");
    await assert.rejects(client.request({ action: "apply", input: "[source.txt#0000]\nREM", cwd: directory, home: directory }));
    assert(existsSync(path));
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("missing destinations resolve through existing directory links without platform-specific binaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-links-"));
  try {
    const actual = join(directory, "actual");
    const alias = join(directory, "alias");
    await mkdir(actual);
    await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(await resolveHostPath("alias/new/deep/file.txt", directory), await resolveHostPath("actual/new/deep/file.txt", directory));
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("cancellation and shutdown stop owned workers and allow a fresh reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-cancel-"));
  const client = new NativeClient(await addonPath());
  try {
    const path = join(directory, "file.txt");
    await writeFile(path, "unchanged\n");
    const controller = new AbortController();
    const reading = client.request({ action: "read", path, display: "file.txt" }, controller.signal);
    controller.abort();
    await assert.rejects(reading, /cancel/u);
    const result = JSON.parse(await client.request({ action: "read", path, display: "file.txt" })) as NativeRead;
    assert.match(result.text, /1:unchanged/u);
    await client.close();
    assert.equal(await readFile(path, "utf8"), "unchanged\n");
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("an edit cancelled before writing preserves the original filesystem bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-cancel-edit-"));
  const client = new NativeClient(await addonPath());
  try {
    const path = join(directory, "file.txt");
    await writeFile(path, "original\n");
    const read = JSON.parse(await client.request({ action: "read", path, display: "file.txt" })) as NativeRead;
    const controller = new AbortController();
    const editing = client.request({ action: "apply", input: `[file.txt#${read.tag}]\nPUT 1:\n+changed`, cwd: directory, home: directory }, controller.signal);
    controller.abort();
    await assert.rejects(editing, /cancel/u);
    assert.equal(await readFile(path, "utf8"), "original\n");
    const again = JSON.parse(await client.request({ action: "read", path, display: "file.txt" })) as NativeRead;
    assert.match(again.text, /1:original/u);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("read path selectors support ranges, tails, raw bytes and literal filenames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-ranges-"));
  const client = new NativeClient(await addonPath());
  try {
    const path = join(directory, "lines.txt");
    const content = "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\n";
    await writeFile(path, content);
    const read = async (selector: string): Promise<NativeRead> => JSON.parse(await client.request({ action: "read", path: path + selector, display: "lines.txt" + selector })) as NativeRead;
    assert.equal((await read(":raw")).text, content);
    assert.equal((await read(":raw:2-3")).text, "two\r\nthree");
    assert.equal((await read(":2:raw")).text, "two");
    assert.equal((await read(":-2:raw")).text, "five\r\nsix\r\n");
    const ranged = await read(":3-3");
    assert.match(ranged.text, /2:two/u);
    assert.match(ranged.text, /6:six/u);
    assert(!ranged.text.includes("1:one"));
    const multi = await read(":1,5");
    assert.match(multi.text, /1:one/u);
    assert.match(multi.text, /5:five/u);
    assert(!multi.text.includes("2:two"));
    await assert.rejects(read(":0"), /1-indexed/u);
    if (process.platform !== "win32") {
      await writeFile(path + ":raw", "literal filename\n");
      assert.match((await read(":raw")).text, /1:literal filename/u);
    }
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("bare long-code reads summarize bodies and only observed rows can anchor edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-summary-"));
  const client = new NativeClient(await addonPath());
  try {
    const path = join(directory, "example.ts");
    const source = "function example() {\n" + "  console.log(value);\n".repeat(130) + "}\n";
    await writeFile(path, source);
    const read = JSON.parse(await client.request({ action: "read", path, display: "example.ts" })) as NativeRead;
    assert.match(read.text, /1-132:function example\(\) \{ … \}/u);
    assert.match(read.text, /example\.ts:1-132/u);
    await assert.rejects(client.request({ action: "apply", input: `[example.ts#${read.tag}]\nPUT 70:\n+  console.log(other);`, cwd: directory, home: directory }), /unseen|displayed|anchors to/iu);
    assert.equal(await readFile(path, "utf8"), source);
    const selected = JSON.parse(await client.request({ action: "read", path: path + ":70-70", display: "example.ts:70-70" })) as NativeRead;
    assert.match(selected.text, /70:  console\.log\(value\);/u);
    await client.request({ action: "apply", input: `[example.ts#${selected.tag}]\nPUT 70:\n+  console.log(other);`, cwd: directory, home: directory });
    assert.match(await readFile(path, "utf8"), /console\.log\(other\);/u);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("binary file deletion uses existence and exact-byte preconditions without allowing text edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-binary-"));
  const client = new NativeClient(await addonPath());
  try {
    const path = join(directory, "binary.bin");
    const bytes = Buffer.from([0x61, 0xff, 0x80]);
    await writeFile(path, bytes);
    await assert.rejects(client.request({ action: "apply", input: "[binary.bin#FFFF]\nPUT 1:\n+text", cwd: directory, home: directory }), /not valid UTF-8 at byte 1/u);
    assert.deepEqual(await readFile(path), bytes);
    const engine = await WasmEngine.load(artifact);
    const file = await supplyFile("binary.bin", directory, true);
    const plan = engine.session<StagedEdit>({ action: "stage", input: "[binary.bin#FFFF]\nREM", cwd: portablePath(directory), home: portablePath(directory), files: [file] });
    await writeFile(path, Buffer.from([0x62, 0xff, 0x80]));
    await assert.rejects(applyWrites(engine, plan), /changed after staging/u);
    assert(existsSync(path));
    await client.request({ action: "apply", input: "[binary.bin#FFFF]\nREM", cwd: directory, home: directory });
    assert.equal(existsSync(path), false);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("bounded edit responses never credit hidden rewritten rows as displayed anchors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-output-budget-"));
  const client = new NativeClient(await addonPath());
  try {
    const sections: string[] = [];
    for (let index = 0; index < 70; index++) {
      const name = `file-${index.toString().padStart(3, "0")}.txt`;
      const path = join(directory, name);
      await writeFile(path, "original\n");
      const read = JSON.parse(await client.request({ action: "read", path, display: name })) as NativeRead;
      sections.push(`[${name}#${read.tag}]\nPUT 1:\n+changed-${index}-${"x".repeat(1000)}`);
    }
    const result = JSON.parse(await client.request({ action: "apply", input: sections.join("\n"), cwd: directory, home: directory })) as NativeEdit;
    assert(!result.isError);
    assert.equal(result.files.length, 70);
    assert(Buffer.byteLength(result.text) <= 50 * 1024);
    assert(result.text.split("\n").length <= 2000);
    assert.match(result.text, /Output truncated/u);
    const hidden = result.files.at(-1);
    assert(hidden?.newText);
    assert(!result.text.includes("[file-069.txt#"));
    const engine = await WasmEngine.load(artifact);
    const tag = engine.compute<{ tag: string }>({ action: "content_tag", source: hidden.newText }).tag;
    await assert.rejects(client.request({ action: "apply", input: `[file-069.txt#${tag}]\nPUT 1:\n+must reread`, cwd: directory, home: directory }), /unseen|displayed|anchors to/iu);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("host write failures retain successful acknowledgements and discard uncommitted plans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-write-failure-"));
  const engine = await WasmEngine.load(artifact);
  try {
    await writeFile(join(directory, "first.txt"), "first\n");
    await writeFile(join(directory, "second.txt"), "second\n");
    const first = await supplyFile("first.txt", directory);
    const second = await supplyFile("second.txt", directory);
    const missing = await supplyFile("blocked/destination.txt", directory);
    const read = (file: typeof first) => engine.session<NativeRead>({ action: "read", file, offset: 1, limit: 10 });
    const firstRead = read(first);
    const secondRead = read(second);
    const plan = engine.session<StagedEdit>({ action: "stage", input: `[first.txt#${firstRead.tag}]\nPUT 1:\n+changed\n[second.txt#${secondRead.tag}]\nMV blocked/destination.txt`, cwd: portablePath(directory), home: portablePath(directory), files: [first, second, missing] });
    const outcome = await applyWrites(engine, plan, () => { writeFileSync(join(directory, "blocked"), "not a directory"); });
    assert.equal(outcome.isError, true);
    assert.equal(outcome.files.length, 1);
    assert.match(outcome.text, /1 file operations were acknowledged/u);
    assert.match(outcome.text, /No rollback/u);
    assert.equal(await readFile(join(directory, "first.txt"), "utf8"), "changed\n");
    assert.equal(await readFile(join(directory, "second.txt"), "utf8"), "second\n");
    assert.throws(() => engine.session({ action: "commit", generation: plan.generation, index: 1, written: "second\n" }), /Unknown or repeated/u);
    const current = await supplyFile("first.txt", directory);
    const currentRead = read(current);
    const retry = engine.session<StagedEdit>({ action: "stage", input: `[first.txt#${currentRead.tag}]\nPUT 1:\n+recovered`, cwd: portablePath(directory), home: portablePath(directory), files: [current] });
    assert(!(await applyWrites(engine, retry)).isError);
    assert.equal(await readFile(join(directory, "first.txt"), "utf8"), "recovered\n");
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("write acknowledgements reject stale generations, wrong order, and duplicates", async () => {
  const engine = await WasmEngine.load(artifact);
  const files = ["first", "second"].map(name => ({ authored: `${name}.txt`, path: `/workspace/${name}.txt`, content: name + "\n", exists: true }));
  const tags = files.map(file => engine.session<NativeRead>({ action: "read", file, offset: 1, limit: 10 }).tag);
  const plan = engine.session<StagedEdit>({ action: "stage", input: `[first.txt#${tags[0]}]\nPUT 1:\n+changed first\n[second.txt#${tags[1]}]\nPUT 1:\n+changed second`, cwd: "/workspace", home: "/workspace", files });
  assert.throws(() => engine.session({ action: "commit", generation: plan.generation + 1, index: 0, written: "changed first\n" }), /stale/u);
  assert.throws(() => engine.session({ action: "commit", generation: plan.generation, index: 1, written: "changed second\n" }), /file order/u);
  engine.session({ action: "commit", generation: plan.generation, index: 0, written: "changed first\n" });
  assert.throws(() => engine.session({ action: "commit", generation: plan.generation, index: 0, written: "changed first\n" }), /Unknown or repeated/u);
  engine.session({ action: "abort" });
  assert.throws(() => engine.session({ action: "commit", generation: plan.generation, index: 1, written: "changed second\n" }), /Unknown or repeated/u);
});

test("a real WASM trap discards its worker before the next request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-trap-"));
  const path = join(directory, "core.wasm");
  const client = new NativeClient(path);
  try {
    // This small module implements the owned ABI but traps in both execution exports.
    const name = (value: string): number[] => [value.length, ...Buffer.from(value)];
    const section = (id: number, bytes: number[]): number[] => [id, bytes.length, ...bytes];
    const trap = Uint8Array.from([
      0, 97, 115, 109, 1, 0, 0, 0,
      ...section(1, [3, 96, 1, 127, 1, 127, 96, 1, 127, 0, 96, 1, 127, 1, 126]),
      ...section(3, [4, 0, 1, 2, 2]),
      ...section(5, [1, 0, 1]),
      ...section(7, [5, ...name("memory"), 2, 0, ...name("code_anchor_alloc"), 0, 0, ...name("code_anchor_free"), 0, 1, ...name("code_anchor_execute"), 0, 2, ...name("code_anchor_session"), 0, 3]),
      ...section(10, [4, 5, 0, 65, 128, 8, 11, 2, 0, 11, 3, 0, 0, 11, 3, 0, 0, 11]),
    ]);
    assert(WebAssembly.validate(trap));
    await writeFile(path, trap);
    const file = join(directory, "file.txt");
    await writeFile(file, "recovered\n");
    await assert.rejects(client.request({ action: "read", path: file, display: "file.txt" }), /unreachable/u);
    await writeFile(path, await readFile(artifact));
    const read = JSON.parse(await client.request({ action: "read", path: file, display: "file.txt" })) as NativeRead;
    assert.match(read.text, /1:recovered/u);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("a source checkout must contain WASM bytes rather than a Git LFS pointer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-pointer-"));
  try {
    const path = join(directory, "core.wasm");
    await writeFile(path, "version https://git-lfs.github.com/spec/v1\noid sha256:" + "0".repeat(64) + "\nsize 100\n");
    await assert.rejects(WasmEngine.load(path), /LFS pointer/u);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});

test("the adapter rejects non-regular files and invalid UTF-8 rather than editing substituted text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-anchor-wasm-boundary-"));
  try {
    await assert.rejects(supplyFile(directory, directory), /regular file/u);
    await writeFile(join(directory, "invalid.bin"), Buffer.from([0xff, 0xfe, 0x80]));
    await assert.rejects(supplyFile("invalid.bin", directory), /encoded data|encoding|decode/iu);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); assert(!existsSync(directory)); }
});
