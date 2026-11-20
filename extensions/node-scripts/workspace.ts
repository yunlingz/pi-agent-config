import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import { startProcess } from "./process.ts";
import { managedPath } from "./paths.ts";
import { UUID, listJobs, type Job, type JobView, type Query, type Status } from "./types.ts";

type Controller = ReturnType<typeof startProcess>;
const statuses: Status[] = ["created", "started", "finished", "failed", "timeout", "deprecated"];
const inside = (root: string, path: string) => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Workspace directories must not be links");
  return realpath(path);
}

async function tail(path: string) {
  if (!existsSync(path)) return { text: "", truncated: false };
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const bytes = Buffer.alloc(Math.min(size, 24 * 1024));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return { text: bytes.subarray(0, bytesRead).toString("utf8"), truncated: size > bytes.length };
  } finally { await file.close(); }
}

async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export class Workspace {
  readonly jobs = new Map<string, Job>();
  private controllers = new Map<string, { process: Controller; completion: Promise<void> }>();
  private launches = new Map<string, Promise<void>>();
  private writes = new Map<string, Promise<void>>();
  private outputTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  dependencyBusy = false;

  readonly root: string;
  readonly sessionId: string;
  registry: string;
  private constructor(root: string, sessionId: string, registry: string) {
    this.root = root; this.sessionId = sessionId; this.registry = registry;
  }

  static async create(config: Config, sessionId: string): Promise<Workspace> {
    if (!UUID.test(sessionId)) throw new Error("Pi session must have a UUID");
    const parent = await directory(config.rootFolder);
    const root = await directory(join(parent, sessionId));
    for (const name of ["scripts", "jobs", "logs"]) await directory(await managedPath(root, name));
    const workspace = new Workspace(root, sessionId, config.npmRegistry);
    const manifest = await managedPath(root, "package.json");
    if (!existsSync(manifest)) await writeFile(manifest, JSON.stringify({ private: true, type: "module" }, null, 2), { flag: "wx", mode: 0o600 });
    await workspace.manifest();
    for (const name of await readdir(await managedPath(root, "jobs"))) {
      if (!UUID.test(name.slice(0, -5)) || !name.endsWith(".json")) continue;
      const path = await managedPath(root, "jobs", name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("Job record must be a bounded regular file");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (value === null || typeof value !== "object" || !("id" in value) || value.id !== name.slice(0, -5)
        || !("format" in value) || value.format !== 1 || !("status" in value) || !statuses.includes(value.status as Status)
        || !("scriptPath" in value) || typeof value.scriptPath !== "string" || !("args" in value) || !Array.isArray(value.args)
        || !value.args.every(arg => typeof arg === "string") || !("name" in value) || typeof value.name !== "string"
        || !("createdAt" in value) || typeof value.createdAt !== "number"
        || ("scriptSha256AtStart" in value && (typeof value.scriptSha256AtStart !== "string" || !/^[0-9a-f]{64}$/u.test(value.scriptSha256AtStart)))
        || ("timeoutSeconds" in value && (typeof value.timeoutSeconds !== "number" || !Number.isFinite(value.timeoutSeconds) || value.timeoutSeconds <= 0))) throw new Error("Invalid node-scripts job record");
      // Identity and execution inputs are checked once at this persisted-data boundary.
      workspace.jobs.set(value.id, value as Job);
      if (!inside(root, resolve(root, value.scriptPath))) throw new Error("Saved script path must stay inside this session workspace");
    }
    return workspace;
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  get active() { return this.controllers.size + this.launches.size; }
  private get(id: string) { if (!UUID.test(id)) throw new Error("Use the complete job UUID"); const job = this.jobs.get(id); if (!job) throw new Error("Unknown job in this session; use node_job_list"); return job; }
  managedPath(...parts: string[]) { return managedPath(this.root, ...parts); }
  private save(job: Job): Promise<void> {
    const text = JSON.stringify(job, null, 2);
    const next = (this.writes.get(job.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const path = await this.managedPath("jobs", `${job.id}.json`);
      const temporary = await this.managedPath("jobs", `.${job.id}-${randomUUID()}.tmp`);
      await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      // Windows can briefly deny replacement while another reader opens the record.
      const deadline = Date.now() + 2000;
      for (;;) {
        await this.managedPath("jobs", `${job.id}.json`);
        try { await rename(temporary, path); break; }
        catch (error) {
          if (process.platform !== "win32" || Date.now() >= deadline || !(error instanceof Error) || !("code" in error)
            || !["EPERM", "EBUSY"].includes(String(error.code))) throw error;
          await new Promise(accept => setTimeout(accept, 25));
        }
      }
    });
    this.writes.set(job.id, next);
    return next;
  }
  view(job: Job): JobView {
    const active = this.controllers.has(job.id) || this.launches.has(job.id);
    const uncertain = job.terminationConfirmed === false || job.status === "started" && !active;
    return { ...job, status: uncertain ? "unconfirmed" : job.status, active, workspace: this.root,
      stdoutPath: join(this.root, "logs", job.id, "stdout.log"), stderrPath: join(this.root, "logs", job.id, "stderr.log") };
  }
  views(): JobView[] { return [...this.jobs.values()].map(job => this.view(job)); }
  list(status: JobView["status"], recentN: number) { return listJobs(this.views(), status, recentN); }
  async query(id: string): Promise<Query> {
    const view = this.view(this.get(id));
    const stdout = await tail(await this.managedPath("logs", view.id, "stdout.log"));
    const stderr = await tail(await this.managedPath("logs", view.id, "stderr.log"));
    let sourceState: Query["sourceState"] = "not_recorded";
    let scriptSha256Current: string | undefined;
    if (view.scriptSha256AtStart) {
      try {
        scriptSha256Current = await sha256(await this.managedPath(view.scriptPath));
        sourceState = scriptSha256Current === view.scriptSha256AtStart ? "same" : "changed";
      } catch (error) {
        sourceState = error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "unreadable";
      }
    }
    return { ...view, sourceState, scriptSha256Current, stdout: stdout.text, stderr: stderr.text, outputTruncated: stdout.truncated || stderr.truncated };
  }
  async manifest(): Promise<{ private: true; type: "module"; dependencies?: Record<string, string> }> {
    const path = await this.managedPath("package.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error("Workspace ESM manifest must be a bounded regular file");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (value === null || typeof value !== "object" || !("type" in value) || value.type !== "module"
      || !("private" in value) || value.private !== true) throw new Error("Workspace must stay private and use ESM (type: module)");
    // npm owns dependency entries. The workspace contract is validated at this boundary.
    return value as { private: true; type: "module"; dependencies?: Record<string, string> };
  }
  private async script(path: string) {
    const full = await this.managedPath(path);
    if (!inside(this.root, full) || !full.endsWith(".mjs")) throw new Error("Script must be a .mjs file inside this session workspace");
    const canonical = await realpath(full);
    const info = await lstat(full);
    if (!inside(this.root, canonical) || info.isSymbolicLink() || !info.isFile()) throw new Error("Script must be a regular workspace file, not a link");
    await this.manifest();
    return canonical;
  }
  async createJob(input: { scriptPath: string; args?: string[]; timeoutSeconds?: number; name?: string }) {
    await this.script(input.scriptPath);
    if (input.timeoutSeconds !== undefined && (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0 || input.timeoutSeconds * 1000 > 2147483647)) throw new Error("Timeout must be positive and at most 2147483 seconds");
    const job: Job = { format: 1, id: randomUUID(), name: input.name ?? basename(input.scriptPath), scriptPath: relative(this.root, resolve(this.root, input.scriptPath)),
      args: input.args ?? [], ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }), status: "created", createdAt: Date.now() };
    if (JSON.stringify(job).length > 32 * 1024 || job.args.some(arg => arg.includes("\0"))) throw new Error("Job definition is too large or has invalid arguments");
    await this.save(job); this.jobs.set(job.id, job); this.changed(); return this.view(job);
  }
  async run(id: string, signal?: AbortSignal, update?: (job: JobView) => void) {
    const job = this.get(id);
    if (this.dependencyBusy) throw new Error("Wait for the npm operation to finish");
    if (job.status !== "created") throw new Error("Jobs can run only once; create another job");
    signal?.throwIfAborted();
    job.status = "started"; job.startedAt = Date.now();
    const preparing = Promise.withResolvers<void>();
    this.launches.set(id, preparing.promise);
    let publish = update;
    const partial = { stdout: "", stderr: "" };
    let controller: Controller;
    try {
      await this.save(job);
      const script = await this.script(job.scriptPath);
      const log = await directory(await this.managedPath("logs", job.id));
      const stdoutPath = await this.managedPath("logs", job.id, "stdout.log");
      const stderrPath = await this.managedPath("logs", job.id, "stderr.log");
      job.scriptSha256AtStart = await sha256(script);
      await this.save(job);
      controller = startProcess({ args: [script, ...job.args], cwd: this.root, timeoutSeconds: job.timeoutSeconds,
        stdoutPath, stderrPath, onOutput: (text, stream) => {
          const lines = (partial[stream] + text).split(/\r\n|\r|\n/u);
          partial[stream] = (lines.at(-1) ?? "").slice(-500);
          const nonempty = lines.filter(line => line.trim()).at(-1);
          if (text.trim() && nonempty) { job.lastOutputAt = Date.now(); job.lastOutputLine = nonempty.slice(-500); }
          if (!this.outputTimers.has(id)) this.outputTimers.set(id, setTimeout(() => {
            this.outputTimers.delete(id);
            void this.save(job).catch(() => { job.error = "Cannot persist latest output metadata"; });
            this.changed(); publish?.(this.view(job));
          }, 250));
        } });
    } catch (error) {
      job.status = "failed"; job.endedAt = Date.now(); job.terminationConfirmed = true;
      job.error = error instanceof Error ? error.message : "Job launch failed";
      try { await this.save(job); } finally { this.launches.delete(id); preparing.resolve(); }
      this.changed(); return this.query(id);
    }
    const completion = (async () => {
      const outcome = await controller.completion;
      clearTimeout(this.outputTimers.get(id)); this.outputTimers.delete(id);
      job.exitCode = outcome.exitCode; job.signal = outcome.signal; job.terminationConfirmed = outcome.terminationConfirmed;
      job.endedAt = Date.now();
      if (outcome.reason === "deprecated") job.previousStatus = "started";
      job.status = outcome.reason === "deprecated" ? "deprecated" : outcome.reason === "timeout" ? "timeout" : outcome.exitCode === 0 && !outcome.error ? "finished" : "failed";
      if (outcome.error) job.error = outcome.error;
      if (!outcome.terminationConfirmed) job.error = "Process termination is unconfirmed; do not kill a saved PID";
      await this.save(job); this.controllers.delete(id); this.changed();
    })();
    this.controllers.set(id, { process: controller, completion }); this.changed();
    this.launches.delete(id); preparing.resolve();
    // Observe rejection immediately, including when a background job finishes after this call returns.
    void completion.catch(error => { job.error = error instanceof Error ? error.message : "Cannot finalize job"; this.changed(); });
    try { await controller.started; } catch { await completion; return this.query(id); }
    if (job.timeoutSeconds === undefined) { publish = undefined; return this.query(id); }
    const abort = () => { void controller.deprecate(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { await completion; return await this.query(id); }
    finally { publish = undefined; signal?.removeEventListener("abort", abort); }
  }
  async deprecate(id: string) {
    const job = this.get(id);
    await this.launches.get(id);
    const active = this.controllers.get(id);
    if (active) { await active.process.deprecate(); await active.completion; }
    if (job.terminationConfirmed === false || job.status === "started" && !active) throw new Error("Cannot confirm this process is stopped; no saved PID will be killed");
    if (job.status !== "deprecated") {
      const deprecated = { ...job, previousStatus: job.status, status: "deprecated" as const };
      await this.save(deprecated); Object.assign(job, deprecated); this.changed();
    }
    return this.query(id);
  }
  async interruptTimed() { await Promise.all([...this.jobs.values()].filter(job => job.status === "started" && job.timeoutSeconds !== undefined).map(job => this.deprecate(job.id))); }
  async shutdown() { await Promise.all([...this.jobs.values()].filter(job => job.status === "started" && (this.controllers.has(job.id) || this.launches.has(job.id))).map(job => this.deprecate(job.id))); }
}

// Reload shares only owned runtime state; listeners detach with their extension instance.
const key = Symbol.for("pi.node-scripts.workspaces.v1");
const host = globalThis as typeof globalThis & { [key]?: Map<string, Promise<Workspace>> };
const workspaces = host[key] ??= new Map<string, Promise<Workspace>>();
export async function sessionWorkspace(config: Config, sessionId: string) {
  const root = resolve(config.rootFolder);
  const existing = workspaces.get(sessionId);
  if (existing) {
    const value = await existing;
    // Reload keeps owned processes but uses this extension version's workspace methods.
    Object.setPrototypeOf(value, Workspace.prototype);
    const canonical = existsSync(root) ? await realpath(root) : root;
    if (dirname(value.root) === canonical) { value.registry = config.npmRegistry; return value; }
    if (value.active || value.dependencyBusy) throw new Error("Cannot change rootFolder while work is running");
  }
  const created = Workspace.create(config, sessionId);
  workspaces.set(sessionId, created);
  try { return await created; } catch (error) { workspaces.delete(sessionId); throw error; }
}

export async function retainedWorkspace(sessionId: string): Promise<Workspace | undefined> {
  const value = await workspaces.get(sessionId)?.catch(() => undefined);
  if (value) Object.setPrototypeOf(value, Workspace.prototype);
  return value;
}
