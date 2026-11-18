import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installDependencies } from "./dependencies.ts";
import { cleanupJob, createJob, executeJob, finishInline, inspectJob, jobReference, releaseJob, saveManifest, setRetention, withJobLease } from "./jobs.ts";
import { blockedTool } from "./policy.ts";
import { displayText } from "./process.ts";
import { progressText, registerProgress } from "./progress.ts";
import { ENTRY_TYPE, REMOVED_ENTRY_TYPE, type JobIdentity, type JobManifest, type JobReference, type Progress, type RunOptions, type ScriptDetails } from "./types.ts";
import { registerControls, TOOL_NAMES } from "./controls.ts";
import { inlineRenderers, workspaceRenderers, jobRenderers } from "./render.ts";
import { executionEnvironment } from "./environment.ts";
import { executionText, executionView } from "./execution.ts";
import { backgroundActive, backgroundStatus, backgroundSummary, forgetBackground, runForeground, startBackground, stopBackground, stopSessionBackground } from "./background.ts";
import { registerJobPanels } from "./background-panel.ts";

const timeoutSchema = Type.Number({ exclusiveMinimum: 0, maximum: 86400, description: "Total deadline in seconds, including preparation" });
const purposeSchema = Type.String({ minLength: 1, maxLength: 300, description: "Brief user-facing purpose" });
const readyUrlSchema = Type.Optional(Type.String({description:"Use only a known loopback HTTP readiness endpoint. Omit for non-HTTP work; never invent an endpoint."}));
const backgroundSchema = Type.Optional(Type.Union([
  Type.Literal(false),
  Type.Object({service:Type.Literal(true),readyUrl:readyUrlSchema},{additionalProperties:false,description:"Service: run until stopped or session shutdown. No runtimeSeconds field."}),
  Type.Object({runtimeSeconds:Type.Number({exclusiveMinimum:0,maximum:7*86400}),readyUrl:readyUrlSchema},{additionalProperties:false,description:"Finite background work with an explicit runtime deadline. No service field."}),
],{default:false,description:"Default false: foreground. Only requested independent long work uses a service or finite-job object, never both forms."}));
const result = <T extends ScriptDetails | undefined = undefined>(text: string, isError = false, details?: T) => {
  const safe = displayText(text);
  const content = Buffer.byteLength(safe) > 49 * 1024 ? `${Buffer.from(safe).subarray(0, 48 * 1024).toString("utf8")}\n[Result truncated; inspect retained job files.]` : safe;
  return { content: [{ type: "text" as const, text: content }], details, isError };
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
    panels.set({ id: reference.id, purpose: reference.purpose ?? "Managed job", state: "preparing", reason: "Preparing owned job files" });
  };
  const forget = (reference: JobReference) => {
    pi.appendEntry(REMOVED_ENTRY_TYPE, { id: reference.id });
    references.delete(reference.id);
    forgetBackground(reference.id);
    panels.remove(reference.id);
  };
  pi.on("session_start", async (_event, ctx) => {
    references.clear();
    panels.reset();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE && jobReference(entry.data)) references.set(entry.data.id, entry.data);
      if (entry.type === "custom" && entry.customType === REMOVED_ENTRY_TYPE && entry.data !== null && typeof entry.data === "object" && "id" in entry.data && typeof entry.data.id === "string") references.delete(entry.data.id);
    }
    for (const reference of [...references.values()]) {
      if (!existsSync(reference.root)) { forget(reference); continue; }
      try {
        const job = await inspectJob(reference, ctx.sessionManager.getSessionId());
        references.set(job.id, { ...reference, purpose: job.purpose });
        stored(job, "Registered files remain until explicit release");
      } catch {
        panels.set({ id: reference.id, purpose: reference.purpose ?? "Managed job", state: "unresolved", reason: "Inspect ownership, state, and process lease before cleanup" });
      }
    }
  });
  pi.on("session_shutdown", async (event,ctx) => {
    if(event.reason==="reload") return;
    for (const operation of operations) operation.controller.abort();
    await Promise.all([...operations].map(operation => operation.done));
    await stopSessionBackground(ctx.sessionManager.getSessionId());
  });
  const progress = registerProgress(pi, () => enabled);
  const panels = registerJobPanels(pi);
  const stored = (job: JobManifest, reason: string) => {
    if (job.state === "released") panels.remove(job.id);
    else panels.set({ id: job.id, purpose: job.purpose, state: job.state === "pinned" ? "pinned" : "retained", reason });
  };
  const tracking = async <T>(reference: JobReference, sessionId: string, action: (job: JobManifest) => Promise<T>): Promise<T> => {
    const job = await inspectJob(reference, sessionId);
    panels.set({ id: job.id, purpose: job.purpose, state: "running", reason: "Execution owns these files" });
    try { return await action(job); }
    catch (error) { stored(job, "Execution did not finish normally; diagnostic files preserved"); throw error; }
  };

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
    "For operations supported by active dedicated tools, prefer those tools over script_inline and script_js; managed scripts replace shell execution.",
    "Use script_inline or script_js for commands only when dedicated tools are unavailable or insufficient, including Git, project startup, and tests.",
    "Prefer script_inline when dependency-free code fits directly in the call. Several sequential commands do not require a script_js workspace.",
    "Use script_js when dependencies, multiple files, repeated editing, or a reusable helper justify a workspace.",
    "Successful disposable script_inline runs clean up automatically. Set keep:true only when the source or full evidence is still needed.",
    "For script_inline and script_js, use foreground by default: omit background or set false. Background requires requested independent long-running work.",
    "Use script_inline or script_js instead of the blocked bash and powershell tools, including nested calls. Never bypass these gates.",
    "In script_inline and script_js, do not invoke PowerShell, including powershell.exe, pwsh/PowerShell 7, and .ps1 scripts.",
    "For script_js workspaces, use active session file tools with their existing safeguards; no separate authoring plugin is required.",
    "Keep script_inline and script_js helpers in JavaScript. Maintained project code retains its required language and workflow.",
    "For script_js corrections, reuse retained workspaces and logs. Never restart quiet work just to obtain progress.",
    "In script_inline and script_js, use the managed exec helper for native commands; it uses argument arrays and shell:false.",
    "script_inline and script_js have normal OS permissions, not a sandbox. Keep credentials out of source, output, arguments, and logs.",
    "For script_inline and script_js, explain purpose, decisions, blockers, and results; automatic status reports only observed progress.",
    "In script_inline and script_js, import process.env.PI_SCRIPT_RUNTIME and call exec(command,args,{timeoutSeconds,cwd?,env?,input?,allowFailure?}). Output streams automatically.",
    "script_inline example: const {exec}=await import(process.env.PI_SCRIPT_RUNTIME); await exec('git',['status','--short'],{timeoutSeconds:10});",
    "For script_inline and script_js, exec throws on failure; set allowFailure:true only when inspecting an expected nonzero status.",
    "Accepted normal nonzero exits do not retain safe successful inline jobs. Timeouts, truncation, and uncertain termination still preserve evidence.",
    "In script_inline and script_js, use input for finite stdin. Implement pipelines, glob expansion, and filesystem operations in JavaScript.",
    "Use background:{runtimeSeconds:...} for finite long jobs, or background:{service:true} for requested services; timeoutSeconds is then the startup deadline.",
    "For script_inline/script_js background, choose either service:true or runtimeSeconds, never both. Supply readyUrl only for a known real loopback endpoint.",
    "Background jobs return promptly and survive native manual/automatic compaction and reload. Quit or session replacement stops owned jobs; use script_job status/logs/stop.",
    "For background scripts, managed exec may omit its options object and inherit the parent lifetime. Foreground child commands still require deadlines.",
    "Escape and manual compaction cancel foreground waiting, not the job. Inspect the fixed panel or script_job status/logs; use script_job stop to terminate.",
    "Do not disable /temp-scripts while background work is active. Stop jobs before release; release immediately deletes their evidence.",
  ];
  pi.registerTool({
    name: "script_inline", label: "Inline JavaScript", description: "Default foreground: run dependency-free ESM JavaScript directly with a total deadline and streamed output. Omit background or set false for normal commands. Background objects are only for requested independent work/services; timeoutSeconds then bounds startup (max120s). Safe successful foreground runs auto-clean; failures/artifacts/keep:true/background retain. Output:48KiB/1800 lines, disk cap:16MiB. Not a sandbox.",
    promptSnippet: "Run small temporary JavaScript helpers instead of inline shell or other interpreters",
    promptGuidelines: runGuidelines,
    parameters: Type.Object({ purpose: purposeSchema, code: Type.String({ minLength: 1, maxLength: 32 * 1024 }), timeoutSeconds: timeoutSchema, cwd: Type.Optional(Type.String()), keep: Type.Optional(Type.Boolean({description:"Preserve successful foreground source and logs"})), background:backgroundSchema }),
    executionMode: "sequential",
    ...inlineRenderers,
    async execute(_id, input, signal, onUpdate, ctx) {
      return supervised(signal, async ownedSignal => {
        const job = await createJob(ctx.sessionManager.getSessionId(), input.purpose, register);
        return tracking(job, job.sessionId, async () => {
          await writeFile(join(job.root, "work", "main.mjs"), input.code, { mode: 0o600 });
          const view = executionView("inline", resolve(ctx.cwd, input.cwd ?? "."), (text, details) => onUpdate?.(result(text, false, details)), { text: input.code, truncated: false });
          view.start();
          if (input.background) {
            const details = await startBackground(job, job.sessionId, "main.mjs", [], "inline", { ...options(input.purpose, input.cwd, input.timeoutSeconds, ctx, ownedSignal, undefined), inline: input.code, onProgress: view.onProgress }, { ...input.background, startupSeconds: input.timeoutSeconds });
            stored(job, "Background evidence remains until completion/stop and explicit release");
            return result(backgroundSummary(input.purpose, details), false, details);
          }
          const completed = await runForeground(job, job.sessionId, "main.mjs", [], "inline", { ...options(input.purpose, input.cwd, input.timeoutSeconds, ctx, ownedSignal, undefined), inline: input.code, onProgress: view.onProgress });
          if (!completed.record) {
            stored(job, "Waiting interrupted; files remain until explicit release");
            return result(backgroundSummary(input.purpose, completed), false, completed);
          }
          const output = completed.record;
          const retention = await finishInline(job, job.sessionId, output, input.keep);
          if (retention.state === "removed") forget(job);
          else panels.set({ id: job.id, purpose: job.purpose, state: retention.state, reason: retention.reason });
          const details = view.finish(output, retention);
          return result(executionText(details), output.status !== "succeeded" || retention.state === "cleanup_failed", details);
        });
      });
    },
  });
  pi.registerTool({
    name: "script_js", label: "Workspace JavaScript", description: "Run an existing .mjs/.js workspace entry from a fresh snapshot with visible source, commands, and logs. test:true uses Node tests. Optional background:{runtimeSeconds} or {service:true} returns after startup; timeoutSeconds then bounds startup (max120s), not lifetime. Workspaces remain until explicit release. No TypeScript or runtime compilation.",
    promptSnippet: "Execute and rerun developed JavaScript workspaces with retained evidence",
    promptGuidelines: [
      "Use script_job create before developing multi-file or dependency-based helpers with normal session file tools.",
      "For script_js outputs, use PI_SCRIPT_ARTIFACTS. Source snapshots mean import.meta.url refers to the snapshot, not work/.",
      "In script_js, import process.env.PI_SCRIPT_RUNTIME for progress(message) and exec(command,args,{timeoutSeconds,cwd?}).",
    ],
    parameters: Type.Object({ job: Type.String(), purpose: purposeSchema, entry: Type.String(), args: Type.Optional(Type.Array(Type.String())), cwd: Type.Optional(Type.String()), timeoutSeconds: timeoutSchema, test: Type.Optional(Type.Boolean()),background:backgroundSchema }),
    executionMode: "sequential", ...workspaceRenderers,
    async execute(_id, input, signal, onUpdate, ctx) {
      return supervised(signal, ownedSignal => tracking(lookup(input.job), ctx.sessionManager.getSessionId(), async job => {
        const view = executionView("workspace", resolve(ctx.cwd, input.cwd ?? "."), (text, details) => onUpdate?.(result(text, false, details)));
        view.start();
        if (input.background) {
          const details = await startBackground(job, job.sessionId, input.entry, input.args ?? [], "workspace", { ...options(input.purpose, input.cwd, input.timeoutSeconds, ctx, ownedSignal, undefined), test: input.test, onProgress: view.onProgress }, { ...input.background, startupSeconds: input.timeoutSeconds });
          stored(job, "Background workspace remains until explicit release");
          return result(backgroundSummary(input.purpose, details), false, details);
        }
        const completed = await runForeground(job, job.sessionId, input.entry, input.args ?? [], "workspace", { ...options(input.purpose, input.cwd, input.timeoutSeconds, ctx, ownedSignal, undefined), test: input.test, onProgress: view.onProgress, onSource: view.onSource });
        if (!completed.record) {
          stored(job, "Waiting interrupted; workspace remains until explicit release");
          return result(backgroundSummary(input.purpose, completed), false, completed);
        }
        if (completed.source) view.onSource(completed.source);
        const output = completed.record;
        const details = view.finish(output, { state: "retained", reason: "Workspace available for edits and reruns until explicit release" });
        stored(job, details.retention?.reason ?? "Workspace remains until explicit release");
        return result(executionText(details), output.status !== "succeeded", details);
      }));
    },
  });
  pi.registerTool({
    name: "script_job", label: "Script job", description: "Manage JavaScript jobs under ~/.pi-temp-scripts/jobs. Actions:create,list,inspect,status,logs,stop,dependencies,retain,pin,release,cleanup. Background status/logs/stop do not restart work. Running/uncertain jobs cannot be deleted. Release deletes stopped owned source,dependencies,artifacts,logs immediately. jobs:[ids] batches lifecycle actions. No expiry. Dependencies require exact versions; lifecycle scripts disabled.",
    promptSnippet: "Manage editable temporary workspaces, job dependencies, retention, and safe cleanup",
    promptGuidelines: [
      "For script_job dependencies, keep runtime packages inside the managed job, never in the project or global installation.",
      "Use script_job dependencies with exact package versions; never switch registries after an installation failure.",
      "Before script_job release, copy requested deliverables to an approved durable path. Job storage is disposable, not a backup.",
      "Use script_job release when source, logs, artifacts, and dependencies are no longer needed; it deletes them immediately. Batch with jobs:[ids].",
      "For script_job workspaces, normal file tools author scripts. Do not edit manifests, leases, dependency metadata, or recorded runs.",
    ],
    parameters: Type.Object({ action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("inspect"),Type.Literal("status"),Type.Literal("logs"),Type.Literal("stop"), Type.Literal("dependencies"), Type.Literal("retain"), Type.Literal("pin"), Type.Literal("release"), Type.Literal("cleanup")]), job: Type.Optional(Type.String()), jobs: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 50 })), purpose: Type.Optional(purposeSchema), dependencies: Type.Optional(Type.Record(Type.String(), Type.String())), timeoutSeconds: Type.Optional(timeoutSchema) }),
    executionMode: "sequential", ...jobRenderers(id => references.get(id)?.purpose),
    async execute(_id, input, signal, onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (input.job && input.jobs) throw new Error("Use job or jobs, not both");
      if (input.jobs && !["release", "cleanup", "retain", "pin"].includes(input.action)) throw new Error("jobs is supported only for lifecycle actions");
      if (["release", "cleanup", "retain", "pin"].includes(input.action)) {
        const selected = [...new Set(input.jobs ?? (input.job ? [input.job] : []))];
        if (!selected.length) throw new Error("Lifecycle actions require job or jobs");
        const targets = selected.map(id => lookup(id));
        const messages: string[] = [];
        const identities: JobIdentity[] = [];
        let failed = false;
        for (const reference of targets) {
          let identity = { id: reference.id, purpose: reference.purpose ?? "Managed job" };
          try {
            const job = await inspectJob(reference, sessionId);
            identity = { id: job.id, purpose: job.purpose };
            onUpdate?.(result(`${input.action}: ${job.purpose}\nJob: ${job.id}`, false, { kind: "script-job", jobs: [...identities, identity] }));
            if (input.action === "release" || input.action === "cleanup") {
              if (input.action === "release") await releaseJob(reference, sessionId);
              else await cleanupJob(reference, sessionId);
              forget(reference);
              messages.push(`Removed job: ${job.purpose}\nJob: ${job.id}\nOwned source, dependencies, artifacts, and logs deleted.`);
            } else {
              const retained = await setRetention(reference, sessionId, input.action === "pin" ? "pinned" : "open");
              stored(retained, "Retained until explicit release; this storage is not a backup");
              messages.push(`${retained.purpose}\nJob: ${retained.id}\nRetention: ${retained.state}; retained until explicit release. This storage is not a backup.`);
            }
          } catch {
            failed = true;
            messages.push(`${identity.purpose}\nJob: ${reference.id}\nOperation failed; inspect ownership, state, and process lease before retrying.`);
          }
          identities.push(identity);
        }
        return result(messages.join("\n\n"), failed, { kind: "script-job", jobs: identities });
      }
      if (input.action === "create") {
        if (!input.purpose) throw new Error("create requires purpose");
        const job = await createJob(sessionId, input.purpose, register);
        stored(job, "Editable workspace remains until explicit release");
        return result(`Job: ${job.id}\nPurpose: ${job.purpose}\nSource directory: ${join(job.root, "work")}\nCreate entry: ${join(job.root, "work", "main.mjs")}\nRetention: open\nUse active session file tools with their existing safeguards on these paths.`, false, { kind: "script-job", jobs: [{ id: job.id, purpose: job.purpose }] });
      }
      if (input.action === "list") {
        const entries: string[] = [];
        for (const reference of [...references.values()]) {
          if (!existsSync(reference.root)) { forget(reference); continue; }
          try { const job = await inspectJob(reference, sessionId); entries.push(`${job.id} · ${job.state} · ${job.purpose}\n${join(job.root, "work")}`); }
          catch { entries.push(`${reference.id} · ownership or state unresolved; retained`); }
        }
        return result(entries.join("\n") || "No managed jobs in this session.");
      }
      const reference = lookup(input.job);
      if(input.action==="status" || input.action==="logs" || input.action==="stop"){
        const details=input.action==="stop"?await stopBackground(reference,sessionId):await backgroundStatus(reference,sessionId);
        if(!details){const job=await inspectJob(reference,sessionId);return result(`Job: ${job.id}\nNo live controller in this Pi process. Persisted files remain; an unresolved lease must not be used to kill a saved PID.\nWork: ${join(job.root,"work")}`);}
        return result(backgroundSummary(input.purpose??"Background job",details),details.status==="termination_unconfirmed",details);
      }
      if (input.action === "inspect") {
        const job = await inspectJob(reference, sessionId);
        const { token: _token, ...publicJob } = job;
        return result(JSON.stringify({ ...publicJob, work: join(job.root, "work"), leased: existsSync(join(job.root, "lease")) }, null, 2));
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
  }, () => operations.size > 0 || backgroundActive());
}
