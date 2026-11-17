import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { installDependencies } from "./dependencies.ts";
import { cleanupJob, createJob, executeJob, inspectJob, jobReference, saveManifest, setRetention, withJobLease } from "./jobs.ts";
import { blockedTool } from "./policy.ts";
import { displayText } from "./process.ts";
import { progressText, registerProgress } from "./progress.ts";
import { ENTRY_TYPE, type JobReference, type Progress, type RunOptions } from "./types.ts";
import { registerControls, TOOL_NAMES } from "./controls.ts";
import { scriptRenderers } from "./render.ts";
import { executionEnvironment } from "./environment.ts";

const timeoutSchema = Type.Number({ exclusiveMinimum: 0, maximum: 86400, description: "Total deadline in seconds, including preparation" });
const purposeSchema = Type.String({ minLength: 1, maxLength: 300, description: "Brief user-facing purpose" });
const result = (text: string, isError = false) => {
  const safe = displayText(text);
  const content = Buffer.byteLength(safe) > 49 * 1024 ? `${Buffer.from(safe).subarray(0, 48 * 1024).toString("utf8")}\n[Result truncated; inspect retained job files.]` : safe;
  return { content: [{ type: "text" as const, text: content }], details: undefined, isError };
};

export default function tempScripts(pi: ExtensionAPI): void {
  const references = new Map<string, JobReference>();
  let enabled = true;
  const operations = new Set<{ controller: AbortController; done: Promise<void> }>();
  const lookup = (id: string | undefined): JobReference => {
    const reference = id ? references.get(id) : undefined;
    if (!reference) throw new Error("Unknown job; use script_job list or create in the owning session");
    return reference;
  };
  const register = (reference: JobReference) => {
    pi.appendEntry(ENTRY_TYPE, reference);
    references.set(reference.id, reference);
  };
  const collect = async (sessionId: string): Promise<void> => {
    for (const reference of references.values()) {
      if (!existsSync(reference.root)) { references.delete(reference.id); continue; }
      try {
        const job = await inspectJob(reference, sessionId);
        if (job.state === "released" && await cleanupJob(reference, sessionId)) references.delete(reference.id);
      } catch { /* Invalid, active, or unresolved jobs stay retained. Explicit inspection reports their errors. */ }
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    references.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE && jobReference(entry.data)) references.set(entry.data.id, entry.data);
    }
  });
  pi.on("session_shutdown", async () => {
    for (const operation of operations) operation.controller.abort();
    await Promise.all([...operations].map(operation => operation.done));
  });
  const progress = registerProgress(pi, () => enabled);

  pi.on("tool_call", event => {
    if (!enabled) {
      if (TOOL_NAMES.includes(event.toolName)) return { block: true, reason: "Managed scripts are off. Use /temp-scripts on to enable them." };
      return;
    }
    const reason = blockedTool(event.toolName);
    if (reason) return { block: true, reason };
  });

  const options = (purpose: string, cwd: string | undefined, timeoutSeconds: number, ctx: ExtensionToolContext, signal: AbortSignal | undefined, update: ((text: string) => void) | undefined): RunOptions => {
    const env = executionEnvironment(process.env, [join(getAgentDir(), "bin")]);
    for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
    env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) env.PI_SESSION_FILE = sessionFile;
    if (ctx.model) { env.PI_PROVIDER = ctx.model.provider; env.PI_MODEL = ctx.model.id; }
    if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
    return { purpose, cwd: resolve(ctx.cwd, cwd ?? "."), timeoutSeconds, signal, env,
      onProgress: (value: Progress) => update?.(progressText(purpose, value)) };
  };
  const supervised = async <T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    let finish: () => void = () => {};
    const done = new Promise<void>(accept => { finish = accept; });
    const operation = { controller, done };
    operations.add(operation);
    try { return await action(controller.signal); }
    finally { signal?.removeEventListener("abort", abort); finish(); operations.delete(operation); }
  };
  const runGuidelines = [
    "Use script_inline or script_js for every new temporary helper; do not generate helpers in Python, Ruby, shell languages, or other runtimes.",
    "Prefer dedicated file/search tools. Use script_inline or script_js for all commands, including Git, project startup, and tests.",
    "Use script_inline or script_js instead of the blocked bash and powershell tools, including nested calls. Never bypass these gates.",
    "In script_inline and script_js, do not invoke PowerShell, including powershell.exe, pwsh/PowerShell 7, and .ps1 scripts.",
    "For script_js workspaces, use read, write, edit, and available AST tools with their active safeguards.",
    "Keep script_inline and script_js helpers in JavaScript. Maintained project code retains its required language and workflow.",
    "For script_js corrections, reuse retained workspaces and logs. Never restart quiet work just to obtain progress.",
    "In script_inline and script_js, use the managed exec helper for native commands; it uses argument arrays and shell:false.",
    "script_inline and script_js have normal OS permissions, not a sandbox. Keep credentials out of source, output, arguments, and logs.",
    "For script_inline and script_js, explain purpose, decisions, blockers, and results; automatic status reports only observed progress.",
    "In script_inline and script_js, import process.env.PI_SCRIPT_RUNTIME and call exec(command,args,{timeoutSeconds,cwd?,env?,input?,allowFailure?}). Output streams automatically.",
    "script_inline example: const {exec}=await import(process.env.PI_SCRIPT_RUNTIME); await exec('git',['status','--short'],{timeoutSeconds:10});",
    "For script_inline and script_js, exec throws on failure; set allowFailure:true only when inspecting an expected nonzero status.",
    "In script_inline and script_js, use input for finite stdin. Implement pipelines, glob expansion, and filesystem operations in JavaScript.",
    "In script_inline and script_js, do not launch background jobs or interactive programs. Every run owns its deadline and child processes.",
  ];
  pi.registerTool({
    name: "script_inline", label: "Inline JavaScript", description: "Run small dependency-free ESM JavaScript in a supervised Node process. Top-level await works; print results with console.log. Required deadline, retained source/logs, separate cwd. Output tail is limited to 48 KiB/1800 lines; disk logs stop at 16 MiB. Not a sandbox.",
    promptSnippet: "Run small temporary JavaScript helpers instead of inline shell or other interpreters",
    promptGuidelines: runGuidelines,
    parameters: Type.Object({ purpose: purposeSchema, code: Type.String({ minLength: 1, maxLength: 32 * 1024 }), timeoutSeconds: timeoutSchema, cwd: Type.Optional(Type.String()) }),
    executionMode: "sequential",
    ...scriptRenderers,
    async execute(_id, input, signal, onUpdate, ctx) {
      return supervised(signal, async ownedSignal => {
        const job = await createJob(ctx.sessionManager.getSessionId(), input.purpose, register);
        await writeFile(join(job.root, "work", "main.mjs"), input.code, { mode: 0o600 });
        const output = await executeJob(job, job.sessionId, "main.mjs", [], { ...options(input.purpose, input.cwd, input.timeoutSeconds, ctx, ownedSignal, text => onUpdate?.(result(text))), inline: input.code });
        return result(`Execution: ${output.status} · exit ${output.exitCode}\nJob: ${job.id}\nRun: ${output.run}\nCwd: ${output.cwd}\nElapsed: ${Math.round(output.elapsedMs)}ms\nSource: ${output.sourceHash}\nRetained: source, artifacts, stdout.log, stderr.log\n${output.truncated ? "Output tail (truncated):" : "Output:"}\n${output.output}`, output.status !== "succeeded");
      });
    },
  });
  pi.registerTool({
    name: "script_js", label: "Workspace JavaScript", description: "Execute an existing .mjs/.js entry inside a managed job's work/ directory. Uses a fresh source snapshot, retained logs and artifacts, explicit cwd and total deadline. Set test:true for Node's test runner. Output limits match script_inline. No TypeScript or runtime compilation.",
    promptSnippet: "Execute and rerun developed JavaScript workspaces with retained evidence",
    promptGuidelines: [
      "Use script_job create before developing multi-file or dependency-based helpers with normal session file tools.",
      "For script_js outputs, use PI_SCRIPT_ARTIFACTS. Source snapshots mean import.meta.url refers to the snapshot, not work/.",
      "In script_js, import process.env.PI_SCRIPT_RUNTIME for progress(message) and exec(command,args,{timeoutSeconds,cwd?}).",
    ],
    parameters: Type.Object({ job: Type.String(), purpose: purposeSchema, entry: Type.String(), args: Type.Optional(Type.Array(Type.String())), cwd: Type.Optional(Type.String()), timeoutSeconds: timeoutSchema, test: Type.Optional(Type.Boolean()) }),
    executionMode: "sequential", ...scriptRenderers,
    async execute(_id, input, signal, onUpdate, ctx) {
      return supervised(signal, async ownedSignal => {
        const output = await executeJob(lookup(input.job), ctx.sessionManager.getSessionId(), input.entry, input.args ?? [], { ...options(input.purpose, input.cwd, input.timeoutSeconds, ctx, ownedSignal, text => onUpdate?.(result(text))), test: input.test });
        return result(`Execution: ${output.status} · exit ${output.exitCode}\nJob: ${output.job}\nRun: ${output.run}\nCwd: ${output.cwd}\nElapsed: ${Math.round(output.elapsedMs)}ms\nSource: ${output.sourceHash}\nRetained: source, artifacts, stdout.log, stderr.log\n${output.truncated ? "Output tail (truncated):" : "Output:"}\n${output.output}`, output.status !== "succeeded");
      });
    },
  });
  pi.registerTool({
    name: "script_job", label: "Script workspace", description: "Manage JS helper jobs in owned OS temporary directories. Actions: create, list, inspect, dependencies, retain, pin, release, cleanup. Jobs persist across reload/resume in the owning session. Release makes a job eligible for cleanup after seven days; cleanup immediate:true deletes a released job now. Open/pinned/leased jobs are protected. Dependencies need exact versions, the company registry, and disabled lifecycle scripts.",
    promptSnippet: "Manage editable temporary workspaces, job dependencies, retention, and safe cleanup",
    promptGuidelines: [
      "For script_job dependencies, keep runtime packages inside the managed job, never in the project or global installation.",
      "Use script_job dependencies with exact package versions; never switch registries after an installation failure.",
      "Before script_job release, copy requested deliverables to an approved durable path. Pinning cannot prevent OS temporary cleanup.",
      "Use script_job release when evidence is no longer needed; cleanup immediate:true permits deleting that job's source, logs, and artifacts.",
      "For script_job workspaces, normal file tools author scripts. Do not edit manifests, leases, dependency metadata, or recorded runs.",
    ],
    parameters: Type.Object({ action: StringEnum(["create", "list", "inspect", "dependencies", "retain", "pin", "release", "cleanup"] as const), job: Type.Optional(Type.String()), purpose: Type.Optional(purposeSchema), dependencies: Type.Optional(Type.Record(Type.String(), Type.String())), timeoutSeconds: Type.Optional(timeoutSchema), immediate: Type.Optional(Type.Boolean()) }),
    executionMode: "sequential", ...scriptRenderers,
    async execute(_id, input, signal, onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (input.action === "create") {
        if (!input.purpose) throw new Error("create requires purpose");
        await collect(sessionId);
        const job = await createJob(sessionId, input.purpose, register);
        return result(`Job: ${job.id}\nSource directory: ${join(job.root, "work")}\nCreate entry: ${join(job.root, "work", "main.mjs")}\nRetention: open\nUse normal read/write/edit/AST tools on these paths.`);
      }
      if (input.action === "list") {
        await collect(sessionId);
        const entries: string[] = [];
        for (const reference of references.values()) {
          try { const job = await inspectJob(reference, sessionId); entries.push(`${job.id} · ${job.state} · ${job.purpose}\n${join(job.root, "work")}`); }
          catch { entries.push(`${reference.id} · ownership or state unresolved; retained`); }
        }
        return result(entries.join("\n") || "No managed jobs in this session.");
      }
      const reference = lookup(input.job);
      if (input.action === "inspect") {
        const job = await inspectJob(reference, sessionId);
        const { token: _token, ...publicJob } = job;
        return result(JSON.stringify({ ...publicJob, work: join(job.root, "work"), leased: existsSync(join(job.root, "lease")) }, null, 2));
      }
      if (input.action === "retain" || input.action === "pin" || input.action === "release") {
        const state = input.action === "retain" ? "open" : input.action === "pin" ? "pinned" : "released";
        const job = await setRetention(reference, sessionId, state);
        return result(`Job: ${job.id}\nRetention: ${job.state}\n${job.state === "released" ? "Eligible for deletion after seven days; files remain available until cleanup." : "Files retained; OS temporary cleanup can still remove them."}`);
      }
      if (input.action === "cleanup") {
        const removed = await cleanupJob(reference, sessionId, input.immediate);
        if (removed) references.delete(reference.id);
        return result(removed ? `Removed owned job directory: ${reference.root}` : "Retained: the released job has not reached seven days.");
      }
      if (!input.dependencies || !input.timeoutSeconds) throw new Error("dependencies requires dependencies and timeoutSeconds");
      return supervised(signal, ownedSignal => withJobLease(reference, sessionId, async (job, keepLease) => {
        if (job.state === "released") throw new Error("Retain the job before dependency changes");
        const log = await mkdtemp(join(job.root, "dependencies-"));
        await writeFile(join(job.root, "dependencies-incomplete"), "Dependency setup must finish before execution.");
        try {
          await installDependencies(job, input.dependencies ?? {}, options(input.purpose ?? "Install helper dependencies", undefined, input.timeoutSeconds ?? 60, ctx, ownedSignal, text => onUpdate?.(result(text))), log);
          job.dependencies = input.dependencies ?? {};
          await saveManifest(job);
          await rm(join(job.root, "dependencies-incomplete"));
        } catch (error) {
          if (existsSync(join(log, "termination-unconfirmed"))) keepLease();
          throw error;
        }
        return result(`Dependencies installed for ${job.id}.\nLogs: ${log}\nLifecycle scripts disabled; locked versions retained.`);
      }));
    },
  });
  registerControls(pi, next => {
    const active = pi.getActiveTools().filter(name => !TOOL_NAMES.includes(name));
    pi.setActiveTools(next ? [...active, ...TOOL_NAMES] : active);
    enabled = next;
    if (!next) progress.clear();
  }, () => operations.size > 0);
  pi.on("session_start", async (_event, ctx) => { if (enabled) await collect(ctx.sessionManager.getSessionId()); });
}
