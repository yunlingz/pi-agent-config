import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
env.CODE_ANCHOR_PLATFORM = join(root, "rust", "platform", "include");
env.CODE_ANCHOR_GRAMMAR_SOURCES = join(root, ".build", "grammar-sources.json");
env.CARGO_TARGET_DIR = join(root, ".build", "target");
env.CARGO_NET_RETRY = "0";
env.CARGO_HTTP_TIMEOUT = "20";
const llvm = env.CODE_ANCHOR_LLVM ?? (process.platform === "win32" ? join(env.ProgramFiles ?? "C:/Program Files", "LLVM", "bin") : undefined);
if (llvm) {
  env.CC_wasm32_unknown_unknown = join(llvm, process.platform === "win32" ? "clang.exe" : "clang");
  env.AR_wasm32_unknown_unknown = join(llvm, process.platform === "win32" ? "llvm-ar.exe" : "llvm-ar");
}
assert(existsSync(env.CODE_ANCHOR_GRAMMAR_SOURCES), "Prepare pinned grammar sources before the WASM build");
const child = spawn("cargo", ["build", "--manifest-path", join(root, "rust", "Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release", "--locked"], { env, shell: false, stdio: "inherit" });
const heartbeat = setInterval(() => process.stderr.write(`[${new Date().toISOString()}] Building the portable CodeAnchor core\n`), 20_000);
const timeout = setTimeout(() => child.kill("SIGKILL"), 300_000);
try {
  const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); });
  assert.equal(code, 0, "The portable core build failed");
  const bytes = await readFile(join(root, ".build", "target", "wasm32-unknown-unknown", "release", "code_anchor_core.wasm"));
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module);
  assert(imports.every(entry => entry.module === "code_anchor"), "The core must not import WASI or another runtime");
  await mkdir(join(root, "wasm"), { recursive: true });
  await writeFile(join(root, "wasm", "code_anchor_core.wasm"), bytes);
  console.log(JSON.stringify({ bytes: bytes.length, imports }));
} finally { clearInterval(heartbeat); clearTimeout(timeout); }
