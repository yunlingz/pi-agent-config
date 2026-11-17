import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GrammarManifest } from "./grammar-types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "grammars.json"), "utf8")) as GrammarManifest;
const cache = join(root, ".build", "licenses");
await mkdir(cache, { recursive: true });

interface Package { id: string; name: string; version: string; license: string | null; license_file: string | null; manifest_path: string }
interface Metadata { packages: Package[]; resolve: { nodes: { id: string }[] } }
interface Tree { tree: { type: string; path: string }[]; truncated: boolean }
const licenseName = /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/iu;

async function localNotices(directory: string): Promise<{ path: string; text: string }[]> {
  const result: { path: string; text: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && licenseName.test(entry.name)) {
      result.push({ path: entry.name, text: await readFile(join(directory, entry.name), "utf8") });
    }
  }
  return result;
}

async function get(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "CodeAnchor-notice-build", Accept: "application/vnd.github+json" } });
}

async function grammarNotices(directory: string, key: string): Promise<{ path: string; text: string }[]> {
  const local = await localNotices(directory);
  if (local.length) return local;
  const provenance = JSON.parse(await readFile(join(root, "licenses", "sources.json"), "utf8")) as Record<string, { files: string[]; source: string; note: string }>;
  const override = provenance[key];
  if (override) {
    assert(override.files.length, `${key}: ${override.note}`);
    const notices = [{ path: "Source provenance", text: `${override.source}\n${override.note}` }];
    for (const file of override.files) notices.push({ path: file, text: await readFile(join(root, "licenses", file), "utf8") });
    return notices;
  }
  const stored = join(cache, `${key}.json`);
  if (existsSync(stored)) return JSON.parse(await readFile(stored, "utf8")) as { path: string; text: string }[];
  const toml = await readFile(join(directory, "Cargo.toml"), "utf8");
  const repository = /^repository\s*=\s*"https:\/\/github\.com\/([^"\s]+)"/mu.exec(toml)?.[1]?.replace(/\.git$/u, "");
  assert(repository, `${key}: no pinned repository for the omitted license`);
  const vcs = JSON.parse(await readFile(join(directory, ".cargo_vcs_info.json"), "utf8")) as { git: { sha1: string } };
  const prefix = `https://raw.githubusercontent.com/${repository}/${vcs.git.sha1}/`;
  const direct = await get(prefix + "LICENSE");
  let result: { path: string; text: string }[];
  if (direct.ok) {
    result = [{ path: "LICENSE", text: await direct.text() }];
  } else {
    assert.equal(direct.status, 404, `${key}: license request failed with HTTP ${direct.status}`);
    const response = await get(`https://api.github.com/repos/${repository}/git/trees/${vcs.git.sha1}?recursive=1`);
    assert(response.ok, `${key}: license tree request failed with HTTP ${response.status}`);
    const tree = await response.json() as Tree;
    assert(!tree.truncated, `${key}: incomplete license inventory`);
    const files = tree.tree.filter(entry => entry.type === "blob" && licenseName.test(entry.path.split("/").at(-1) ?? ""));
    assert(files.length, `${key}: the pinned source has no discovered license file`);
    result = [];
    for (const file of files) {
      const response = await get(prefix + file.path);
      assert(response.ok, `${key}: cannot read ${file.path}`);
      result.push({ path: file.path, text: await response.text() });
    }
  }
  await writeFile(stored, JSON.stringify(result));
  return result;
}

async function cargoMetadata(target: string): Promise<Metadata> {
  const child = spawn("cargo", ["metadata", "--format-version", "1", "--locked", "--offline", "--filter-platform", target, "--manifest-path", join(root, "rust", "Cargo.toml")], { shell: false, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => { stdout += text; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); });
    assert.equal(code, 0, "Cargo metadata failed");
    return JSON.parse(stdout) as Metadata;
  } finally { clearTimeout(timeout); }
}

let completed = 0;
const heartbeat = setInterval(() => process.stderr.write(`[${new Date().toISOString()}] Collecting pinned dependency notices; ${completed} packages\n`), 20_000);
try {
  const header = (await readFile(join(root, "THIRD-PARTY-NOTICES"), "utf8")).split("\n===== Linked dependency notices =====")[0];
  assert(header);
  const gaps: string[] = [];
  const sections: string[] = [header.replace(/Other linked grammar\nand Rust dependency notices must be collected by the release build\.\n?/u, ""), "\n===== Linked dependency notices =====\n"];
  for (const grammar of [...new Map(manifest.grammars.map(grammar => [`${grammar.crate}-${grammar.version}`, grammar])).values()]) {
    const key = `${grammar.crate}-${grammar.version}`;
    try {
      const notices = await grammarNotices(join(root, ".build", "grammars", key), key);
      assert(notices.length, `${key}: missing notices`);
      sections.push(`\n--- ${grammar.crate} ${grammar.version} (${grammar.license}) ---\n`, ...notices.map(notice => `\n${notice.path}\n${notice.text}\n`));
      completed++;
    } catch (error) {
      gaps.push(error instanceof Error ? error.message : `${key}: cannot collect notices`);
    }
  }
  const packages = new Map<string, Package>();
  for (const target of ["wasm32-unknown-unknown"]) {
    const metadata = await cargoMetadata(target);
    const selected = new Set(metadata.resolve.nodes.map(node => node.id));
    for (const pkg of metadata.packages) if (selected.has(pkg.id)) packages.set(pkg.id, pkg);
  }
  for (const pkg of packages.values()) {
    if (pkg.name === "code-anchor-core") continue;
    const directory = dirname(pkg.manifest_path);
    try {
      const notices = await grammarNotices(directory, `${pkg.name}-${pkg.version}`);
      if (pkg.license_file && existsSync(join(directory, pkg.license_file)) && !notices.some(notice => notice.path === pkg.license_file)) {
        notices.push({ path: pkg.license_file, text: await readFile(join(directory, pkg.license_file), "utf8") });
      }
      assert(notices.length, `${pkg.name} ${pkg.version}: missing license notice; review before distribution`);
      sections.push(`\n--- ${pkg.name} ${pkg.version} (${pkg.license ?? "see license file"}) ---\n`, ...notices.map(notice => `\n${notice.path}\n${notice.text}\n`));
      completed++;
    } catch (error) {
      gaps.push(error instanceof Error ? error.message : `${pkg.name}: cannot collect notices`);
    }
  }
  for (const file of ["LICENSE.tree-sitter", "libc/LICENSE", "printf/LICENSE"]) {
    sections.push(`\n--- Portable C compatibility layer: ${file} ---\n`, await readFile(join(root, "rust", "platform", file), "utf8"));
  }
  assert.equal(gaps.length, 0, `Dependency notices are incomplete:\n${gaps.join("\n")}`);
  await writeFile(join(root, "THIRD-PARTY-NOTICES"), sections.join(""));
  console.log(`Collected notices for ${completed} grammar and Cargo packages`);
} finally { clearInterval(heartbeat); }
