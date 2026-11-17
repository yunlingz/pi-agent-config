import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Grammar, GrammarManifest, GrammarSource } from "./grammar-types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = join(root, ".build");
const grammarDirectory = join(buildDirectory, "grammars");
const targetDirectory = join(buildDirectory, "target");
const manifest = JSON.parse(await readFile(join(root, "grammars.json"), "utf8")) as GrammarManifest;

async function run(command: string, args: string[], env = process.env): Promise<void> {
  const child = spawn(command, args, { cwd: root, env, shell: false, stdio: "inherit" });
  const heartbeat = setInterval(() => {
    process.stderr.write(`[${new Date().toISOString()}] Running ${basename(command)}; pid ${child.pid}\n`);
  }, 20_000);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 300_000);
  try {
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    });
    assert.equal(code, 0, `${basename(command)} failed or exceeded its time limit`);
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function unpackGrammar(grammar: Grammar): Promise<string> {
  const destination = join(grammarDirectory, `${grammar.crate}-${grammar.version}`);
  if (existsSync(join(destination, ".verified-sha256"))) {
    assert.equal(await readFile(join(destination, ".verified-sha256"), "utf8"), grammar.sha256);
    return destination;
  }
  const temporary = await mkdtemp(join(tmpdir(), "code-anchor-grammar-"));
  try {
    const url = `https://static.crates.io/crates/${grammar.crate}/${grammar.crate}-${grammar.version}.crate`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    assert(response.ok, `${grammar.crate}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), grammar.sha256, `${grammar.crate}: archive hash mismatch`);
    const archive = join(temporary, "source.crate");
    await writeFile(archive, bytes);
    const tar = process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe")
      : "tar";
    await run(tar, ["-xzf", archive, "-C", temporary]);
    await mkdir(grammarDirectory, { recursive: true });
    await cp(join(temporary, `${grammar.crate}-${grammar.version}`), destination, { recursive: true });
    await writeFile(join(destination, ".verified-sha256"), grammar.sha256);
    console.log(`Prepared ${grammar.crate}@${grammar.version}`);
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    assert.equal(existsSync(temporary), false);
  }
}

async function prepareGrammars(): Promise<GrammarSource[]> {
  const packages = new Map<string, string>();
  const heartbeat = setInterval(() => {
    process.stderr.write(`[${new Date().toISOString()}] Preparing grammar sources; ${packages.size} archives verified\n`);
  }, 20_000);
  try {
    for (const grammar of manifest.grammars) {
      const key = `${grammar.crate}@${grammar.version}`;
      if (!packages.has(key)) {
        packages.set(key, await unpackGrammar(grammar));
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
  const sources: GrammarSource[] = [];
  for (const grammar of manifest.grammars) {
    const packageRoot = packages.get(`${grammar.crate}@${grammar.version}`);
    assert(packageRoot);
    const sourceRoot = grammar.requiresReferencePatch
      ? join(root, "rust", "grammars", grammar.name)
      : packageRoot;
    assert(existsSync(sourceRoot), `${grammar.name}: required reference grammar patch is absent`);
    const files = await listFiles(sourceRoot);
    const candidates: string[] = [];
    const constructor = new RegExp(`\\btree_sitter_${grammar.symbol}\\s*\\(\\s*(?:void)?\\s*\\)`);
    for (const file of files.filter(file => basename(file) === "parser.c")) {
      if (constructor.test(await readFile(file, "utf8"))) {
        candidates.push(file);
      }
    }
    assert.equal(candidates.length, 1, `${grammar.name}: expected exactly one matching generated parser`);
    const parser = candidates[0];
    assert(parser);
    const scanners = ["scanner.c", "scanner.cc", "scanner.cpp"]
      .map(name => join(dirname(parser), name)).filter(existsSync);
    assert(scanners.length <= 1, `${grammar.name}: ambiguous external scanner`);
    sources.push({
      name: grammar.name,
      package: grammar.crate,
      symbol: grammar.symbol,
      parser,
      ...(scanners[0] ? { scanner: scanners[0] } : {}),
      include: [dirname(parser), join(packageRoot, "src"), join(packageRoot, "common"), join(packageRoot, "bindings", "c")],
    });
  }
  return sources;
}

function compilerEnvironment(sourcesPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.CODE_ANCHOR_GRAMMAR_SOURCES = sourcesPath;
  env.CARGO_TARGET_DIR = targetDirectory;
  env.CARGO_NET_RETRY = "0";
  env.CARGO_HTTP_TIMEOUT = "20";
  return env;
}

const action = process.argv[2] ?? "build";
assert(["prepare", "build", "test"].includes(action), "Expected prepare, build, or test");
await mkdir(buildDirectory, { recursive: true });
const sources = await prepareGrammars();
const sourcesPath = join(buildDirectory, "grammar-sources.json");
const sourceManifest = JSON.stringify(sources, null, 2) + "\n";
if (!existsSync(sourcesPath) || await readFile(sourcesPath, "utf8") !== sourceManifest) {
  await writeFile(sourcesPath, sourceManifest);
}
console.log(`Prepared ${sources.length} grammar inputs`);
if (action === "build") {
  await run(process.execPath, [join(root, "scripts", "build-wasm.ts")], compilerEnvironment(sourcesPath));
} else if (action === "test") {
  await run("cargo", ["test", "--manifest-path", join(root, "rust", "Cargo.toml"), "--locked"], compilerEnvironment(sourcesPath));
}
