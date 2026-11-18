import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./process.ts";
import { JOB_PREFIX, type JobManifest, type JobReference, type RunOptions, type RunResult, type RetentionResult } from "./types.ts";
import { executionEnvironment } from "./environment.ts";
import { jobDirectory, validateJobLocation } from "./storage.ts";

export function inside(root: string, target: string): boolean {
  const local = relative(root, target);
  return local === "" || (local !== ".." && !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(local));
}

export function jobReference(value: unknown): value is JobReference {
  return value !== null && typeof value === "object" && "id" in value && typeof value.id === "string"
    && "root" in value && typeof value.root === "string" && "token" in value && typeof value.token === "string";
}

export async function saveManifest(job: JobManifest): Promise<void> {
  const temporary = join(job.root, `.manifest-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(job, null, 2), { mode: 0o600, flag: "wx" });
  await rename(temporary, join(job.root, "manifest.json"));
}

export async function inspectJob(reference: JobReference, sessionId: string): Promise<JobManifest> {
  const root = resolve(reference.root);
  await validateJobLocation(root);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(root) !== root) throw new Error("Job root is not its original directory");
  if (process.getuid && metadata.uid !== process.getuid()) throw new Error("Job root belongs to another user");
  const manifestPath = join(root, "manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size > 64 * 1024) throw new Error("Job manifest is not a bounded regular file");
  const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!jobReference(value) || value.id !== reference.id || value.root !== root || value.token !== reference.token
    || !("format" in value) || value.format !== 1 || !("sessionId" in value) || value.sessionId !== sessionId
    || !("state" in value) || !["open", "pinned", "released"].includes(String(value.state))
    || !("purpose" in value) || typeof value.purpose !== "string"
    || !("createdAt" in value) || typeof value.createdAt !== "number"
    || !("dependencies" in value) || value.dependencies === null || typeof value.dependencies !== "object") {
    throw new Error("Job ownership or manifest state is invalid");
  }
  // The checked identity belongs to this extension; the remaining fields use its persisted contract.
  return value as JobManifest;
}

export async function createJob(sessionId: string, purpose: string, register: (job: JobReference) => void): Promise<JobManifest> {
  const root = await mkdtemp(join(await jobDirectory(true), JOB_PREFIX));
  let registered = false;
  try {
    const job: JobManifest = { format: 1, id: randomUUID(), root, token: randomUUID(), sessionId, purpose, createdAt: Date.now(), state: "open", dependencies: {} };
    await saveManifest(job);
    register({ id: job.id, root, token: job.token });
    registered = true;
    await mkdir(join(root, "work"), { mode: 0o700 });
    await mkdir(join(root, "runs"), { mode: 0o700 });
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }), { mode: 0o600 });
    return job;
  } finally {
    if (!registered) await rm(root, { recursive: true, force: true });
  }
}

export async function withJobLease<T>(reference: JobReference, sessionId: string, action: (job: JobManifest, keepLease: () => void) => Promise<T>): Promise<T> {
  const job = await inspectJob(reference, sessionId);
  const lease = join(job.root, "lease");
  try { await mkdir(lease, { mode: 0o700 }); }
  catch { throw new Error("Job is active or has an unresolved process lease; inspect it before recovery"); }
  let retain = false;
  try {
    await inspectJob(reference, sessionId);
    return await action(job, () => { retain = true; });
  } finally {
    if (!retain) await rm(lease, { recursive: true, force: true });
  }
}

export async function setRetention(reference: JobReference, sessionId: string, state: JobManifest["state"]): Promise<JobManifest> {
  return withJobLease(reference, sessionId, async job => {
    job.state = state;
    await saveManifest(job);
    return job;
  });
}

export async function cleanupJob(reference: JobReference, sessionId: string): Promise<boolean> {
  return withJobLease(reference, sessionId, async job => {
    if (job.state !== "released") throw new Error("Release the job before cleanup; open and pinned jobs are protected");
    await inspectJob(reference, sessionId);
    await rm(job.root, { recursive: true, force: false, maxRetries: 3 });
    if (existsSync(job.root)) throw new Error("Cleanup did not remove the owned job directory");
    return true;
  });
}

/** Release is an explicit end-of-work decision, unlike successful execution during development. */
export async function releaseJob(reference: JobReference, sessionId: string): Promise<boolean> {
  await setRetention(reference, sessionId, "released");
  return cleanupJob(reference, sessionId);
}

export async function finishInline(reference: JobReference, sessionId: string, output: RunResult, keep = false): Promise<RetentionResult> {
  if (!output.terminationConfirmed) return { state: "retained", reason: "Process termination is uncertain" };
  if (output.status !== "succeeded") return { state: "retained", reason: `Execution ${output.status}; diagnostic evidence preserved` };
  if (keep) return { state: "retained", reason: "Explicit keep request" };
  if (output.truncated || output.commandsTruncated || output.commands.some(command => command.truncated)) return { state: "retained", reason: "Output or command evidence is truncated" };
  if (output.commands.some(command => command.status !== "succeeded")) return { state: "retained", reason: "Unsuccessful or unfinished child command evidence" };
  try {
    await inspectJob(reference, sessionId);
    const rootEntries = await readdir(reference.root);
    const workEntries = await readdir(join(reference.root, "work"));
    const artifacts = await readdir(output.artifacts);
    const runEntries = await readdir(output.run);
    if (artifacts.length || workEntries.some(name => name !== "main.mjs")
      || rootEntries.some(name => !["manifest.json", "package.json", "work", "runs"].includes(name))
      || runEntries.some(name => !["source", "artifacts", "stdout.log", "stderr.log", "request.json", "result.json"].includes(name) && !name.startsWith("child-"))) {
      return { state: "retained", reason: "Generated artifacts or additional workspace files" };
    }
    await releaseJob(reference, sessionId);
    return { state: "removed", reason: "Successful one-time inline run; temporary files removed" };
  } catch {
    return { state: "cleanup_failed", reason: "Cleanup or artifact inspection failed; inspect the owned job before retrying" };
  }
}

async function snapshot(source: string, destination: string): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  const copy = async (from: string, to: string): Promise<void> => {
    const directory = await lstat(from);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Source directory must not be a link");
    await mkdir(to, { mode: 0o700 });
    const entries = (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(from, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) throw new Error("Source snapshots require regular files and directories without links");
      if (metadata.isDirectory()) {
        if (["node_modules", ".git"].includes(entry.name)) throw new Error("Keep dependencies and Git metadata outside work/");
        await copy(path, join(to, entry.name));
      } else {
        bytes += metadata.size;
        files++;
        if (bytes > 32 * 1024 * 1024 || files > 1000) throw new Error("Source snapshot exceeds 32 MiB or 1000 files; keep large data outside work/");
        const content = await readFile(path);
        const name = relative(source, path).replaceAll("\\", "/");
        hash.update(`${Buffer.byteLength(name)}:${name}:${content.length}:`).update(content);
        await writeFile(join(to, entry.name), content, { flag: "wx", mode: 0o600 });
      }
    }
  };
  await copy(source, destination);
  return hash.digest("hex");
}

export async function executeJob(reference: JobReference, sessionId: string, entry: string, args: string[], options: RunOptions & { test?: boolean; inline?: string }): Promise<RunResult> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  options.signal?.throwIfAborted();
  return withJobLease(reference, sessionId, async (job, keepLease) => {
    if (job.state === "released") throw new Error("Retain the released job before another run");
    if (existsSync(join(job.root, "dependencies-incomplete"))) throw new Error("Dependency setup is incomplete; repeat script_job dependencies before running");
    const source = join(job.root, "work");
    const entryPath = resolve(source, entry);
    if (!inside(source, entryPath) || !/\.(?:mjs|js)$/u.test(entry)) throw new Error("The entry must be a .mjs or .js file inside work/");
    const runs = await lstat(join(job.root, "runs"));
    if (!runs.isDirectory() || runs.isSymbolicLink()) throw new Error("Run directory must not be a link");
    const run = await mkdtemp(join(job.root, "runs", "run-"));
    const artifacts = join(run, "artifacts");
    await mkdir(artifacts, { mode: 0o700 });
    const stdoutPath = join(run, "stdout.log");
    const stderrPath = join(run, "stderr.log");
    const sourceHash = await snapshot(source, join(run, "source"));
    const target = join(run, "source", relative(source, entryPath));
    if (options.inline === undefined && !(await stat(target)).isFile()) throw new Error("Entry point must be a regular file");
    const sourceBytes = await readFile(target);
    const shown = sourceBytes.subarray(0, 32 * 1024);
    options.onSource?.({ text: shown.toString("utf8"), path: target, truncated: shown.length !== sourceBytes.length });
    const cwd = await realpath(options.cwd);
    const record = { job: job.id, run, cwd, sourceHash, stdoutPath, stderrPath, artifacts };
    const runtime = fileURLToPath(new URL("./runtime.ts", import.meta.url));
    await writeFile(join(run, "request.json"), JSON.stringify({ ...record, entry, args, purpose: options.purpose, timeoutSeconds: options.timeoutSeconds, dependencies: job.dependencies, startedAt: Date.now() }, null, 2), { mode: 0o600 });
    const lockfile = join(job.root, "package-lock.json");
    if (existsSync(lockfile)) await copyFile(lockfile, join(run, "package-lock.json"));
    options.signal?.throwIfAborted();
    const remaining = (deadline - Date.now()) / 1000;
    if (remaining <= 0) throw new Error("Execution preparation exceeded the total deadline; source snapshot retained");
    const { NODE_TEST_CONTEXT: _testContext, ...inherited } = options.env ?? process.env;
    const environment = executionEnvironment(inherited, [join(job.root, "node_modules", ".bin")]);
    try {
      const result = await runProcess({
        command: process.execPath,
        args: options.inline !== undefined ? ["--input-type=module", "-"] : [...(options.test ? ["--test"] : []), target, ...args],
        stdin: options.inline, cwd, timeoutSeconds: options.untilStopped ? undefined : remaining, untilStopped: options.untilStopped, onSpawn: options.onSpawn,
        signal: options.signal, onProgress: options.onProgress, stdoutPath, stderrPath, ipc: true,
        env: { ...environment, PI_SCRIPT_JOB: job.id, PI_SCRIPT_WORK: source, PI_SCRIPT_RUN: run, PI_SCRIPT_ARTIFACTS: artifacts, PI_SCRIPT_RUNTIME: runtime },
      });
      if (!result.terminationConfirmed) keepLease();
      const output = { ...record, ...result };
      await writeFile(join(run, "result.json"), JSON.stringify(output, null, 2), { mode: 0o600 });
      return output;
    } catch (error) {
      await writeFile(join(run, "error.txt"), error instanceof Error ? error.name : "Execution failure", { mode: 0o600 });
      throw error;
    }
  });
}
