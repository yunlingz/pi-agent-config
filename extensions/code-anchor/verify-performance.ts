import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { addonPath, NativeClient } from "./core-client.ts";
import type { NativeEdit, NativePlan, NativeRead, NativeSearch } from "./core-types.ts";

interface Measurement { name: string; samples: number; medianMs: number; p95Ms: number }
const results: Measurement[] = [];
const fileCount = Number(process.argv[2] ?? 100);
assert([100, 1000].includes(fileCount) && process.argv.length <= 3, "Usage: node verify-performance.ts [100|1000]");
const matchCount = fileCount * 30;
const temporary = await mkdtemp(join(tmpdir(), "code-anchor-performance-"));
const clients = new Set<NativeClient>();
const loop = monitorEventLoopDelay({ resolution: 10 });
let phase = "preparing representative local fixtures";
const heartbeat = setInterval(() => {
  process.stderr.write(`[${new Date().toISOString()}] CodeAnchor performance: ${phase}\n`);
}, 20_000);
try {
  const artifact = await addonPath();
  const binary = await readFile(artifact);
  const source = "// performance fixture\n" + Array.from({ length: 30 }, (_, index) => `console.log(value${index});\n`).join("");
  await mkdir(join(temporary, "src"));
  for (let index = 0; index < fileCount; index++) {
    await writeFile(join(temporary, "src", `file-${index.toString().padStart(3, "0")}.ts`), source);
  }
  const path = join(temporary, "read.txt");
  await writeFile(path, "original\n" + "unchanged text\n".repeat(999));
  const measure = async (name: string, count: number, operation: () => Promise<void>): Promise<void> => {
    phase = name;
    const samples: number[] = [];
    for (let index = 0; index < count; index++) {
      const start = performance.now();
      await operation();
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    const percentile = (fraction: number): number => {
      const value = samples[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)];
      assert(value !== undefined);
      return Number(value.toFixed(2));
    };
    results.push({ name, samples: count, medianMs: percentile(0.5), p95Ms: percentile(0.95) });
  };
  loop.enable();
  await measure("worker startup and first read", 3, async () => {
    const client = new NativeClient(artifact);
    clients.add(client);
    try {
      const result = JSON.parse(await client.request({ action: "read", path, display: "read.txt", limit: 1 })) as NativeRead;
      assert.match(result.text, /1:original/u);
    } finally { await client.close(); clients.delete(client); }
  });
  const client = new NativeClient(artifact);
  clients.add(client);
  await client.request({ action: "read", path, display: "read.txt", limit: 1 });
  await measure("warm read of a 1000-line text file", 30, async () => {
    const result = JSON.parse(await client.request({ action: "read", path, display: "read.txt", limit: 20 })) as NativeRead;
    assert.equal(result.totalLines, 1000);
  });
  await measure(`search ${fileCount} files and count ${matchCount} matches`, 5, async () => {
    const result = JSON.parse(await client.request({ action: "search", paths: ["src/**/*.ts"], cwd: temporary, pattern: "console.log($VALUE)", skip: 0 })) as NativeSearch;
    assert.equal(result.totalMatches, matchCount);
    assert.equal(result.matches.length, 50);
  });
  await measure(`preview ${matchCount} replacements across ${fileCount} files`, 3, async () => {
    const result = JSON.parse(await client.request({ action: "preview", paths: ["src"], cwd: temporary, operations: [{ pattern: "console.log($VALUE)", replacement: "logger.info($VALUE)" }] })) as NativePlan;
    assert.equal(result.totalReplacements, matchCount);
    assert.equal(result.files.length, fileCount);
  });
  await measure(`resolve and write the ${fileCount}-file preview`, 1, async () => {
    await client.request({ action: "pending_paths" });
    const result = JSON.parse(await client.request({ action: "resolve", apply: true })) as NativeEdit;
    assert(!result.isError);
    assert.equal(result.files.length, fileCount);
    assert.equal(await readFile(join(temporary, "src", "file-000.ts"), "utf8"), source.replaceAll("console.log", "logger.info"));
  });
  let value = "original";
  await measure("warm hashline edit with a fresh read and host acknowledgement", 20, async () => {
    const read = JSON.parse(await client.request({ action: "read", path, display: "read.txt", limit: 1 })) as NativeRead;
    value = value === "original" ? "changed" : "original";
    const result = JSON.parse(await client.request({ action: "apply", input: `[read.txt#${read.tag}]\nPUT 1:\n+${value}`, cwd: temporary, home: temporary })) as NativeEdit;
    assert(!result.isError);
    assert((await readFile(path, "utf8")).startsWith(value + "\n"));
  });
  loop.disable();
  console.log(JSON.stringify({
    status: "PASS", platform: process.platform, arch: process.arch, node: process.version,
    artifact: { bytes: binary.length, sha256: createHash("sha256").update(binary).digest("hex") },
    fixture: { sourceFiles: fileCount, sourceBytes: Buffer.byteLength(source) * fileCount, matches: matchCount, readFileLines: 1000 },
    results,
    hostEventLoop: { samples: loop.count, p99Ms: Number((loop.percentile(99) / 1e6).toFixed(2)), maxMs: Number((loop.max / 1e6).toFixed(2)) },
    rssAtEndBytes: process.memoryUsage().rss,
    limits: "Local synthetic workload; small sample counts; no production latency or peak-memory guarantee. Startup uses a warm filesystem and may reuse the Node WASM code cache.",
  }, null, 2));
} finally {
  clearInterval(heartbeat);
  loop.disable();
  try { await Promise.all([...clients].map(client => client.close())); }
  finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    assert(!existsSync(temporary));
    console.error("CLEANUP: performance workers stopped and temporary fixtures removed");
  }
}
